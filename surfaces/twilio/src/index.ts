/**
 * Twilio Programmable Voice surface — Media Streams WebSocket.
 *
 * Twilio Media Streams emits μ-law (g711) audio over WebSocket frames
 * at 8 kHz, base64-encoded inside JSON messages. We parse the message
 * stream, expose VoiceCallEvent shapes from @tenet/voice, and provide
 * the reverse path (TENET-side audio → Twilio-frame JSON) for
 * playback.
 *
 * Wire shape — Twilio Media Streams (https://www.twilio.com/docs/voice/media-streams):
 *   { event: 'connected' }
 *   { event: 'start', start: { streamSid, callSid, customParameters, ... } }
 *   { event: 'media', media: { payload: <base64 mulaw>, chunk, timestamp } }
 *   { event: 'stop' }
 *   { event: 'mark', mark: { name } }
 *
 * To stream BACK to Twilio:
 *   { event: 'media', streamSid, media: { payload: <base64 mulaw> } }
 *   { event: 'mark', streamSid, mark: { name } }   (for sync barriers)
 *
 * No `twilio` SDK hard dep — operator wires a WebSocket-shaped client.
 */

import {
  mulawBytesToPcm16,
  pcm16ToMulawBytes,
  VoiceError,
  type AudioChunk,
  type VoiceCallContext,
  type VoiceCallEvent,
  type VoiceSurface,
} from '@tenet/voice';

export interface TwilioWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: () => void): void;
}

export interface TwilioSurfaceOptions {
  tenantId: string;
  /**
   * Twilio doesn't expose the calling number in Media Streams 'start'
   * unless the operator passes customParameters with <Parameter
   * name="from" value="{{From}}"/> in TwiML. Operator wires this.
   */
  fromCustomParam?: string;
  toCustomParam?: string;
}

// ── TwiML helper ──────────────────────────────────────────────────────

/**
 * Build the TwiML `<Connect><Stream ...>` response that Twilio expects
 * when an inbound voice webhook fires. Operator returns this string
 * with content-type: text/xml from their voice-webhook endpoint.
 */
export function buildStreamTwiml(args: {
  /** wss:// URL pointing to the operator's Media Streams handler. */
  websocketUrl: string;
  /** Custom params forwarded inside the 'start' event. */
  parameters?: Readonly<Record<string, string>>;
}): string {
  const params = Object.entries(args.parameters ?? {})
    .map(([k, v]) => `      <Parameter name="${xmlEscape(k)}" value="${xmlEscape(v)}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(args.websocketUrl)}">
${params}
    </Stream>
  </Connect>
</Response>`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── Surface implementation ────────────────────────────────────────────

export class TwilioVoiceSurface implements VoiceSurface {
  private streamSid: string | undefined;
  private callSid: string | undefined;
  private ctx: VoiceCallContext | undefined;
  private readonly queue: VoiceCallEvent[] = [];
  private resolveNext: ((value: IteratorResult<VoiceCallEvent>) => void) | undefined;
  private done = false;
  /** markName → resolve, set when a mark is sent and the matching 'mark' event arrives. */
  private readonly pendingMarks = new Map<string, () => void>();

  constructor(
    private readonly ws: TwilioWebSocket,
    private readonly opts: TwilioSurfaceOptions,
  ) {
    ws.onMessage((data) => this.handleMessage(data));
    ws.onClose(() => this.finish('hangup'));
  }

  events(): AsyncIterable<VoiceCallEvent> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<VoiceCallEvent> => ({
        next: (): Promise<IteratorResult<VoiceCallEvent>> => {
          if (this.queue.length > 0) {
            return Promise.resolve({ value: this.queue.shift()!, done: false });
          }
          if (this.done) return Promise.resolve({ value: undefined as unknown as VoiceCallEvent, done: true });
          return new Promise((resolve) => { this.resolveNext = resolve; });
        },
      }),
    };
  }

  async speak(callId: string, audio: AsyncIterable<AudioChunk>, signal?: AbortSignal): Promise<void> {
    if (this.callSid !== callId) throw new VoiceError('call_not_found', `wrong callId ${callId}`);
    if (!this.streamSid) throw new VoiceError('call_not_found', 'streamSid missing — start not yet received');
    for await (const chunk of audio) {
      if (signal?.aborted) return;
      let payload: Uint8Array;
      if (chunk.format === 'mulaw' && chunk.sampleRate === 8000) {
        payload = chunk.bytes;
      } else if (chunk.format === 'pcm16' && chunk.sampleRate === 8000) {
        payload = pcm16ToMulawBytes(chunk.bytes);
      } else {
        throw new VoiceError(
          'unsupported_format',
          `Twilio requires mulaw@8000 or pcm16@8000 (got ${chunk.format}@${chunk.sampleRate})`,
        );
      }
      this.ws.send(JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: bytesToBase64(payload) },
      }));
    }
  }

  async hangup(callId: string, _reason?: string): Promise<void> {
    if (this.callSid !== callId) throw new VoiceError('call_not_found', `wrong callId ${callId}`);
    this.ws.close(1000, 'ended');
    this.finish('hangup');
  }

  // ── Internals ───────────────────────────────────────────────────────

  private handleMessage(data: string | Uint8Array): void {
    if (typeof data !== 'string') return;
    let msg: unknown;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const event = (msg as { event?: unknown }).event;
    switch (event) {
      case 'connected':
        return;
      case 'start': {
        const start = (msg as { start?: { streamSid?: unknown; callSid?: unknown; customParameters?: Record<string, string> } }).start;
        if (!start) return;
        this.streamSid = typeof start.streamSid === 'string' ? start.streamSid : undefined;
        this.callSid = typeof start.callSid === 'string' ? start.callSid : undefined;
        const params = start.customParameters ?? {};
        const fromKey = this.opts.fromCustomParam ?? 'from';
        const toKey = this.opts.toCustomParam ?? 'to';
        this.ctx = {
          callId: this.callSid ?? this.streamSid ?? 'unknown',
          tenantId: this.opts.tenantId,
          from: typeof params[fromKey] === 'string' ? params[fromKey] : 'unknown',
          to: typeof params[toKey] === 'string' ? params[toKey] : 'unknown',
          meta: { streamSid: this.streamSid ?? '', callSid: this.callSid ?? '' },
        };
        this.push({ kind: 'call.started', ctx: this.ctx, tMs: Date.now() });
        return;
      }
      case 'media': {
        if (!this.callSid) return;
        const media = (msg as { media?: { payload?: unknown; timestamp?: unknown } }).media;
        const payload = media?.payload;
        if (typeof payload !== 'string') return;
        const mulaw = base64ToBytes(payload);
        const pcm16 = mulawBytesToPcm16(mulaw);
        const ts = typeof media?.timestamp === 'string' ? Number.parseInt(media.timestamp, 10) : Date.now();
        this.push({
          kind: 'call.audio_in',
          callId: this.callSid,
          chunk: { bytes: pcm16, format: 'pcm16', sampleRate: 8000, capturedAtMs: ts },
        });
        return;
      }
      case 'mark': {
        const mark = (msg as { mark?: { name?: unknown } }).mark;
        const name = mark?.name;
        if (typeof name === 'string') {
          this.pendingMarks.get(name)?.();
          this.pendingMarks.delete(name);
        }
        return;
      }
      case 'stop':
        this.finish('hangup');
        return;
    }
  }

  private push(event: VoiceCallEvent): void {
    if (this.done) return;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = undefined;
      r({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  private finish(reason: 'hangup' | 'error' | 'timeout'): void {
    if (this.done) return;
    if (this.callSid) this.push({ kind: 'call.ended', callId: this.callSid, reason, tMs: Date.now() });
    this.done = true;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = undefined;
      r({ value: undefined as unknown as VoiceCallEvent, done: true });
    }
  }
}

// ── base64 helpers ────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return globalThis.btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = globalThis.atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const VERSION = '0.0.0';
