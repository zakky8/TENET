/**
 * OpenAI Realtime API adapter.
 *
 * OpenAI's Realtime API replaces the separate ASR + LLM + TTS stack
 * with one bidirectional WebSocket: audio in, audio + text + tool-calls
 * out. Sub-second TTFT for voice agents — matches Decagon Voice 2.0
 * latency for free.
 *
 * Wire shape (model-defined):
 *   wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-...
 *
 * Client → server events: session.update, input_audio_buffer.append,
 *   input_audio_buffer.commit, response.create, response.cancel
 * Server → client events: response.audio.delta, response.audio_transcript.delta,
 *   input_audio_buffer.speech_started, input_audio_buffer.speech_stopped,
 *   response.done, error
 *
 * No `ws` / `openai` SDK hard dep — operator injects any WebSocket-
 * shaped client (Node's built-in `WebSocket` (Node 22 ships it),
 * browser globalThis.WebSocket, ws library, isomorphic-ws).
 */

import type { AudioChunk, AudioFormat, SampleRate, AsrFinal, VoiceError } from '@tenet/voice';

// ── WebSocket contract — minimum operator needs to provide ────────────

export interface RealtimeWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number; // 0..3 per WebSocket spec
  /** Set by adapter; called when adapter wants to subscribe to events. */
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}

export interface RealtimeOptions {
  apiKey: string;
  /** e.g. 'gpt-4o-realtime-preview-2024-12-17'. */
  model: string;
  /** Operator wires the WebSocket constructor (Node / browser / ws). */
  openSocket: (url: string, headers: Readonly<Record<string, string>>) => Promise<RealtimeWebSocket>;
  /** System instructions to seed the session. */
  instructions?: string;
  /** Voice id (alloy/echo/fable/onyx/nova/shimmer). Default 'alloy'. */
  voice?: string;
  /** Audio format on the wire. Default 'pcm16'. */
  format?: AudioFormat;
  /** Audio sample rate. Default 24000. */
  sampleRate?: SampleRate;
}

// ── Events the orchestrator subscribes to ─────────────────────────────

export type RealtimeEvent =
  | { kind: 'audio.delta'; chunk: AudioChunk }
  | { kind: 'transcript.delta'; text: string }
  | { kind: 'user.speech_started'; tMs: number }
  | { kind: 'user.speech_stopped'; tMs: number; final?: AsrFinal }
  | { kind: 'response.done' }
  | { kind: 'error'; message: string };

export class RealtimeApiError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RealtimeApiError';
  }
}

/**
 * Open one Realtime session. Returns:
 *   - `send(chunk)` to push user audio in
 *   - `events()` AsyncIterable to consume model events
 *   - `commit()` to mark end of utterance
 *   - `cancel()` to interrupt the current response (used on barge-in)
 *   - `close()` to terminate the session
 */
export async function openRealtimeSession(opts: RealtimeOptions): Promise<{
  send(chunk: AudioChunk): void;
  events(): AsyncIterable<RealtimeEvent>;
  commit(): void;
  cancel(): void;
  close(): void;
}> {
  if (!opts.apiKey) throw new RealtimeApiError('invalid_config', 'apiKey required');
  if (!opts.model) throw new RealtimeApiError('invalid_config', 'model required');
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(opts.model)}`;
  const ws = await opts.openSocket(url, {
    authorization: `Bearer ${opts.apiKey}`,
    'openai-beta': 'realtime=v1',
  });

  const format = opts.format ?? 'pcm16';
  const sampleRate: SampleRate = opts.sampleRate ?? 24000;

  // Configure the session immediately on open.
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      modalities: ['audio', 'text'],
      voice: opts.voice ?? 'alloy',
      instructions: opts.instructions ?? '',
      input_audio_format: format === 'pcm16' ? 'pcm16' : 'g711_ulaw',
      output_audio_format: format === 'pcm16' ? 'pcm16' : 'g711_ulaw',
      turn_detection: { type: 'server_vad' },
    },
  }));

  // ── Event pump ──────────────────────────────────────────────────────

  const eventQueue: RealtimeEvent[] = [];
  let resolveNext: ((value: IteratorResult<RealtimeEvent>) => void) | undefined;
  let done = false;

  const push = (e: RealtimeEvent): void => {
    if (done) return;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = undefined;
      r({ value: e, done: false });
    } else {
      eventQueue.push(e);
    }
  };

  const finish = (): void => {
    done = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = undefined;
      r({ value: undefined as unknown as RealtimeEvent, done: true });
    }
  };

  ws.onMessage((data) => {
    if (typeof data !== 'string') {
      // Realtime API uses JSON text frames; binary is unexpected.
      return;
    }
    let msg: unknown;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const type = (msg as { type?: unknown }).type;
    switch (type) {
      case 'response.audio.delta': {
        const b64 = (msg as { delta?: unknown }).delta;
        if (typeof b64 !== 'string') return;
        const bytes = base64ToBytes(b64);
        push({
          kind: 'audio.delta',
          chunk: { bytes, format, sampleRate, capturedAtMs: Date.now() },
        });
        return;
      }
      case 'response.audio_transcript.delta': {
        const delta = (msg as { delta?: unknown }).delta;
        if (typeof delta === 'string') push({ kind: 'transcript.delta', text: delta });
        return;
      }
      case 'input_audio_buffer.speech_started':
        push({ kind: 'user.speech_started', tMs: Date.now() });
        return;
      case 'input_audio_buffer.speech_stopped':
        push({ kind: 'user.speech_stopped', tMs: Date.now() });
        return;
      case 'response.done':
        push({ kind: 'response.done' });
        return;
      case 'error': {
        const err = (msg as { error?: { message?: unknown } }).error;
        const m = typeof err?.message === 'string' ? err.message : 'unknown';
        push({ kind: 'error', message: m });
        return;
      }
    }
  });

  ws.onClose(() => finish());
  ws.onError((err) => { push({ kind: 'error', message: err.message }); finish(); });

  return {
    send(chunk: AudioChunk): void {
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: bytesToBase64(chunk.bytes),
      }));
    },
    commit(): void {
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      ws.send(JSON.stringify({ type: 'response.create' }));
    },
    cancel(): void {
      ws.send(JSON.stringify({ type: 'response.cancel' }));
    },
    close(): void {
      ws.close(1000, 'session.ended');
      finish();
    },
    events(): AsyncIterable<RealtimeEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
          return {
            next(): Promise<IteratorResult<RealtimeEvent>> {
              if (eventQueue.length > 0) {
                return Promise.resolve({ value: eventQueue.shift()!, done: false });
              }
              if (done) return Promise.resolve({ value: undefined as unknown as RealtimeEvent, done: true });
              return new Promise<IteratorResult<RealtimeEvent>>((resolve) => {
                resolveNext = resolve;
              });
            },
          };
        },
      };
    },
  };
}

// ── base64 helpers (no Buffer dep so browser-friendly) ────────────────

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

void (null as unknown as VoiceError); // type-only reference, avoid unused warning

export const VERSION = '0.0.0';
