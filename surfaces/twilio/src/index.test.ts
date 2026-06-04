import { TwilioVoiceSurface, buildStreamTwiml, type TwilioWebSocket } from './index.js';
import type { VoiceCallEvent } from '@tenet/voice';

function makeFakeWs(): { ws: TwilioWebSocket; sent: string[]; fire: (msg: object | string) => void; fireClose: () => void } {
  let onMsg: ((d: string | Uint8Array) => void) | null = null;
  let onClose: (() => void) | null = null;
  const sent: string[] = [];
  return {
    ws: {
      send(d) { sent.push(d); },
      close() {},
      onMessage(cb) { onMsg = cb; },
      onClose(cb) { onClose = cb; },
    },
    sent,
    fire(msg) { onMsg?.(typeof msg === 'string' ? msg : JSON.stringify(msg)); },
    fireClose() { onClose?.(); },
  };
}

async function readN<T>(it: AsyncIterable<T>, n: number, timeoutMs = 100): Promise<T[]> {
  const out: T[] = [];
  const reader = it[Symbol.asyncIterator]();
  for (let i = 0; i < n; i++) {
    const result = await Promise.race([
      reader.next(),
      new Promise<IteratorResult<T>>((_, reject) => setTimeout(() => reject(new Error('read timeout')), timeoutMs)),
    ]);
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

const b64 = (s: string): string => globalThis.btoa(s);

describe('buildStreamTwiml', () => {
  it('builds TwiML with <Connect><Stream> + custom parameters', () => {
    const xml = buildStreamTwiml({
      websocketUrl: 'wss://api.example.com/voice',
      parameters: { from: '+15551234', to: '+15555678' },
    });
    expect(xml).toContain('<Connect>');
    expect(xml).toContain('<Stream url="wss://api.example.com/voice">');
    expect(xml).toContain('name="from"');
    expect(xml).toContain('value="+15551234"');
  });

  it('escapes XML special chars in URL + params', () => {
    const xml = buildStreamTwiml({
      websocketUrl: 'wss://api.example.com/voice?x=a&b=1',
      parameters: { note: 'I <3 TENET' },
    });
    expect(xml).toContain('x=a&amp;b=1');
    expect(xml).toContain('I &lt;3 TENET');
  });
});

describe('TwilioVoiceSurface', () => {
  it('emits call.started with parsed context on `start` event', async () => {
    const { ws, fire } = makeFakeWs();
    const surface = new TwilioVoiceSurface(ws, { tenantId: 't1' });
    fire({
      event: 'start',
      start: {
        streamSid: 'MZ-stream-123',
        callSid: 'CA-call-456',
        customParameters: { from: '+15551234', to: '+15555678' },
      },
    });
    const [e] = await readN(surface.events(), 1);
    expect(e.kind).toBe('call.started');
    if (e.kind === 'call.started') {
      expect(e.ctx.callId).toBe('CA-call-456');
      expect(e.ctx.tenantId).toBe('t1');
      expect(e.ctx.from).toBe('+15551234');
      expect(e.ctx.to).toBe('+15555678');
    }
  });

  it('decodes base64 μ-law media into PCM16 audio_in event', async () => {
    const { ws, fire } = makeFakeWs();
    const surface = new TwilioVoiceSurface(ws, { tenantId: 't1' });
    fire({ event: 'start', start: { streamSid: 'MZ-1', callSid: 'CA-1' } });
    // 4 bytes of μ-law silence (~ 0xff)
    fire({ event: 'media', media: { payload: b64('\xff\xff\xff\xff'), timestamp: '1700' } });
    const events = await readN(surface.events(), 2);
    const audio = events.find((e): e is Extract<VoiceCallEvent, { kind: 'call.audio_in' }> => e.kind === 'call.audio_in');
    expect(audio).toBeDefined();
    expect(audio!.chunk.format).toBe('pcm16');
    expect(audio!.chunk.sampleRate).toBe(8000);
    // 4 μ-law bytes → 8 PCM16 bytes
    expect(audio!.chunk.bytes.byteLength).toBe(8);
    expect(audio!.chunk.capturedAtMs).toBe(1700);
  });

  it('emits call.ended on `stop` event', async () => {
    const { ws, fire } = makeFakeWs();
    const surface = new TwilioVoiceSurface(ws, { tenantId: 't1' });
    fire({ event: 'start', start: { streamSid: 'MZ-1', callSid: 'CA-1' } });
    fire({ event: 'stop' });
    const events = await readN(surface.events(), 2);
    const ended = events.find((e): e is Extract<VoiceCallEvent, { kind: 'call.ended' }> => e.kind === 'call.ended');
    expect(ended).toBeDefined();
    expect(ended!.reason).toBe('hangup');
  });

  it('speak() sends media frames with streamSid + base64 mulaw', async () => {
    const { ws, sent, fire } = makeFakeWs();
    const surface = new TwilioVoiceSurface(ws, { tenantId: 't1' });
    fire({ event: 'start', start: { streamSid: 'MZ-1', callSid: 'CA-1' } });
    // Consume call.started so internal state is set
    await readN(surface.events(), 1);
    sent.length = 0;
    async function* gen() {
      yield { bytes: new Uint8Array([0xff, 0xff]), format: 'mulaw' as const, sampleRate: 8000 as const, capturedAtMs: 0 };
    }
    await surface.speak('CA-1', gen());
    const msg = JSON.parse(sent[0]!);
    expect(msg.event).toBe('media');
    expect(msg.streamSid).toBe('MZ-1');
    expect(typeof msg.media.payload).toBe('string');
  });

  it('speak() rejects unsupported audio format', async () => {
    const { ws, fire } = makeFakeWs();
    const surface = new TwilioVoiceSurface(ws, { tenantId: 't1' });
    fire({ event: 'start', start: { streamSid: 'MZ-1', callSid: 'CA-1' } });
    await readN(surface.events(), 1);
    async function* gen() {
      yield { bytes: new Uint8Array([0]), format: 'opus' as const, sampleRate: 48000 as const, capturedAtMs: 0 };
    }
    await expect(surface.speak('CA-1', gen())).rejects.toMatchObject({ code: 'unsupported_format' });
  });

  it('speak() converts PCM16@8000 to mulaw automatically', async () => {
    const { ws, sent, fire } = makeFakeWs();
    const surface = new TwilioVoiceSurface(ws, { tenantId: 't1' });
    fire({ event: 'start', start: { streamSid: 'MZ-1', callSid: 'CA-1' } });
    await readN(surface.events(), 1);
    sent.length = 0;
    async function* gen() {
      yield { bytes: new Uint8Array(4), format: 'pcm16' as const, sampleRate: 8000 as const, capturedAtMs: 0 };
    }
    await surface.speak('CA-1', gen());
    const msg = JSON.parse(sent[0]!);
    expect(msg.event).toBe('media');
    // 4 bytes pcm16 (2 samples) → 2 bytes mulaw → ~3 chars base64
    expect(globalThis.atob(msg.media.payload).length).toBe(2);
  });

  it('hangup() closes the WS + emits ended', async () => {
    const { ws, fire } = makeFakeWs();
    const surface = new TwilioVoiceSurface(ws, { tenantId: 't1' });
    fire({ event: 'start', start: { streamSid: 'MZ-1', callSid: 'CA-1' } });
    await readN(surface.events(), 1);
    await surface.hangup('CA-1');
    const [e] = await readN(surface.events(), 1);
    expect(e.kind).toBe('call.ended');
  });

  it('WebSocket close triggers call.ended', async () => {
    const { ws, fire, fireClose } = makeFakeWs();
    const surface = new TwilioVoiceSurface(ws, { tenantId: 't1' });
    fire({ event: 'start', start: { streamSid: 'MZ-1', callSid: 'CA-1' } });
    await readN(surface.events(), 1);
    fireClose();
    const [e] = await readN(surface.events(), 1);
    expect(e.kind).toBe('call.ended');
  });
});
