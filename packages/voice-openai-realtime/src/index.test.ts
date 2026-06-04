import { openRealtimeSession, RealtimeApiError, type RealtimeWebSocket } from './index.js';

interface FakeWS extends RealtimeWebSocket {
  sent: string[];
  fire(msg: object | string): void;
  fireClose(): void;
  fireError(err: Error): void;
}

function makeFakeWs(): FakeWS {
  let onMsg: ((d: string | Uint8Array) => void) | null = null;
  let onClose: ((code: number, reason: string) => void) | null = null;
  let onError: ((err: Error) => void) | null = null;
  const sent: string[] = [];
  const ws: FakeWS = {
    sent,
    readyState: 1,
    send(data) { sent.push(typeof data === 'string' ? data : ''); },
    close() {},
    onMessage(cb) { onMsg = cb; },
    onClose(cb) { onClose = cb; },
    onError(cb) { onError = cb; },
    fire(msg) { onMsg?.(typeof msg === 'string' ? msg : JSON.stringify(msg)); },
    fireClose() { onClose?.(1000, 'ok'); },
    fireError(err) { onError?.(err); },
  };
  return ws;
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

describe('openRealtimeSession', () => {
  it('rejects missing apiKey/model', async () => {
    const ws = makeFakeWs();
    await expect(
      openRealtimeSession({ apiKey: '', model: 'm', openSocket: async () => ws }),
    ).rejects.toBeInstanceOf(RealtimeApiError);
    await expect(
      openRealtimeSession({ apiKey: 'k', model: '', openSocket: async () => ws }),
    ).rejects.toBeInstanceOf(RealtimeApiError);
  });

  it('sends session.update immediately on open with operator config', async () => {
    const ws = makeFakeWs();
    await openRealtimeSession({
      apiKey: 'sk-1', model: 'gpt-4o-realtime',
      instructions: 'be brief', voice: 'nova',
      openSocket: async () => ws,
    });
    expect(ws.sent.length).toBeGreaterThan(0);
    const update = JSON.parse(ws.sent[0]!);
    expect(update.type).toBe('session.update');
    expect(update.session.voice).toBe('nova');
    expect(update.session.instructions).toBe('be brief');
    expect(update.session.turn_detection.type).toBe('server_vad');
  });

  it('opens wss URL with model + bearer auth headers', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const ws = makeFakeWs();
    await openRealtimeSession({
      apiKey: 'sk-1', model: 'gpt-4o-realtime',
      openSocket: async (url, headers) => { capturedUrl = url; capturedHeaders = { ...headers }; return ws; },
    });
    expect(capturedUrl).toContain('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime');
    expect(capturedHeaders['authorization']).toBe('Bearer sk-1');
    expect(capturedHeaders['openai-beta']).toBe('realtime=v1');
  });

  it('parses response.audio.delta into audio.delta event', async () => {
    const ws = makeFakeWs();
    const session = await openRealtimeSession({
      apiKey: 'k', model: 'gpt-4o-realtime',
      openSocket: async () => ws,
    });
    ws.fire({ type: 'response.audio.delta', delta: globalThis.btoa('hi') });
    const events = await readN(session.events(), 1);
    expect(events[0]!.kind).toBe('audio.delta');
    if (events[0]!.kind === 'audio.delta') {
      expect(new TextDecoder().decode(events[0]!.chunk.bytes)).toBe('hi');
    }
  });

  it('parses transcript.delta', async () => {
    const ws = makeFakeWs();
    const session = await openRealtimeSession({
      apiKey: 'k', model: 'gpt-4o-realtime',
      openSocket: async () => ws,
    });
    ws.fire({ type: 'response.audio_transcript.delta', delta: 'Hello' });
    const [e] = await readN(session.events(), 1);
    expect(e).toEqual({ kind: 'transcript.delta', text: 'Hello' });
  });

  it('parses speech_started and speech_stopped', async () => {
    const ws = makeFakeWs();
    const session = await openRealtimeSession({
      apiKey: 'k', model: 'gpt-4o-realtime',
      openSocket: async () => ws,
    });
    ws.fire({ type: 'input_audio_buffer.speech_started' });
    ws.fire({ type: 'input_audio_buffer.speech_stopped' });
    const events = await readN(session.events(), 2);
    expect(events.map((e) => e.kind)).toEqual(['user.speech_started', 'user.speech_stopped']);
  });

  it('parses error event', async () => {
    const ws = makeFakeWs();
    const session = await openRealtimeSession({
      apiKey: 'k', model: 'gpt-4o-realtime',
      openSocket: async () => ws,
    });
    ws.fire({ type: 'error', error: { message: 'boom' } });
    const [e] = await readN(session.events(), 1);
    expect(e).toEqual({ kind: 'error', message: 'boom' });
  });

  it('send() base64-encodes audio chunks', async () => {
    const ws = makeFakeWs();
    const session = await openRealtimeSession({
      apiKey: 'k', model: 'gpt-4o-realtime',
      openSocket: async () => ws,
    });
    ws.sent.length = 0; // clear session.update
    session.send({ bytes: new Uint8Array([0x68, 0x69]), format: 'pcm16', sampleRate: 24000, capturedAtMs: 0 });
    const msg = JSON.parse(ws.sent[0]!);
    expect(msg.type).toBe('input_audio_buffer.append');
    expect(globalThis.atob(msg.audio)).toBe('hi');
  });

  it('commit() sends commit + response.create', async () => {
    const ws = makeFakeWs();
    const session = await openRealtimeSession({
      apiKey: 'k', model: 'gpt-4o-realtime',
      openSocket: async () => ws,
    });
    ws.sent.length = 0;
    session.commit();
    expect(JSON.parse(ws.sent[0]!).type).toBe('input_audio_buffer.commit');
    expect(JSON.parse(ws.sent[1]!).type).toBe('response.create');
  });

  it('cancel() sends response.cancel (used on barge-in)', async () => {
    const ws = makeFakeWs();
    const session = await openRealtimeSession({
      apiKey: 'k', model: 'gpt-4o-realtime',
      openSocket: async () => ws,
    });
    ws.sent.length = 0;
    session.cancel();
    expect(JSON.parse(ws.sent[0]!).type).toBe('response.cancel');
  });
});
