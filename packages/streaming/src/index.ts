/**
 * Streaming ChatModel contract — closes the table-stakes gap vs
 * Pydantic-AI / Mastra / OpenAI Agents SDK.
 *
 * The streaming contract (StreamingChatModel) and StreamChunk are CANONICAL,
 * defined in @tenet/core and re-exported here. Adapters that support streaming
 * implement `StreamingChatModel` over the SAME ChatRequest as non-streaming.
 *
 * Three shipped capabilities:
 *   1. StreamingChatModel — AsyncIterable<StreamChunk> protocol (from @tenet/core)
 *   2. parseSseStream() — SSE event-stream parser (Anthropic, OpenAI,
 *      Mistral all use SSE)
 *   3. structuredStreamingParser() — incremental JSON-shape validator
 *      so callers see partial structured output as it arrives
 *      (Pydantic-AI's headline differentiator — now ours too)
 */

// ── Streaming ChatModel contract (CANONICAL — defined in @tenet/core) ──
// StreamChunk + the streaming contract live in @tenet/core so streaming and non-streaming share ONE
// block vocabulary. This re-export closes the divergence flagged during the adapter migration: this
// package used to define its OWN StreamChunk with a loose `stopReason: string` (vs the canonical
// `StopReason` union) plus a single-string `ChatModelStreaming` (superseded by the messages-array
// StreamingChatModel). Re-exported here so the `@tenet/streaming` import path keeps working.
import type { StreamChunk, StreamingChatModel } from '@tenet/core';
export type { StreamChunk, StreamingChatModel };

// ── SSE parser ────────────────────────────────────────────────────────

/**
 * Parses an SSE byte stream into discrete events. Spec: WHATWG SSE
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 * Handles split chunks (events spanning multiple network reads),
 * CRLF / LF, and ignores comment lines starting with ':'.
 */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** DoS guard — max bytes per buffered line / per data field. */
export const SSE_MAX_LINE_BYTES = 1_048_576; // 1 MiB

/** Parse a ReadableStream<Uint8Array> into SseEvents. */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let buf = '';
  let curEvent = 'message';
  let curData: string[] = [];
  let curId: string | undefined;

  const reset = (): void => {
    curEvent = 'message';
    curData = [];
    curId = undefined;
  };

  const emit = (): SseEvent | undefined => {
    if (curData.length === 0) return undefined;
    const ev: SseEvent = { event: curEvent, data: curData.join('\n') };
    if (curId !== undefined) ev.id = curId;
    return ev;
  };

  const iterable = (stream as ReadableStream<Uint8Array>).getReader
    ? readerToIterable(stream as ReadableStream<Uint8Array>)
    : (stream as AsyncIterable<Uint8Array>);

  const processLine = (line: string): void => {
    if (line.startsWith(':')) return; // SSE comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    switch (field) {
      case 'event': curEvent = value; break;
      case 'data': curData.push(value); break;
      case 'id': curId = value; break;
      // 'retry' and unknown fields ignored per spec.
    }
  };

  for await (const chunk of iterable) {
    if (signal?.aborted) throw new Error('SSE stream aborted');
    buf += decoder.decode(chunk, { stream: true });
    // SECURITY 2026-06-04: cap line buffer to prevent unbounded growth
    // from an upstream that never emits a newline (DoS class).
    if (buf.length > SSE_MAX_LINE_BYTES) {
      throw new Error(`SSE line exceeded ${SSE_MAX_LINE_BYTES} bytes`);
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') {
        const ev = emit();
        if (ev) yield ev;
        reset();
        continue;
      }
      processLine(line);
    }
  }
  // Flush any trailing partial line (no terminating newline).
  if (buf.length > 0) {
    processLine(buf.replace(/\r$/, ''));
    buf = '';
  }
  // Flush final event if stream ended mid-event without a blank line.
  const final = emit();
  if (final) yield final;
}

async function* readerToIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Structured output streaming validator ─────────────────────────────

export interface StructuredStreamParser<T> {
  /** Feed a text chunk; returns the latest *valid* partial value or null. */
  feed(chunk: string): T | null;
  /** Final parse; throws on irrecoverable error. */
  finish(): T;
}

/**
 * Brace-balanced incremental JSON parser. Tolerates partial input by
 * tracking depth + quote state; when the running buffer balances to a
 * valid JSON value, JSON.parse runs and the result is returned.
 *
 * This is the Pydantic-AI "structured output as it arrives" pattern
 * generalised — no Pydantic, no schema; the caller validates shape.
 */
/** DoS guard — max bytes the running JSON buffer may grow to. */
export const JSON_STREAM_MAX_BUFFER_BYTES = 1_048_576; // 1 MiB

export function jsonStreamParser<T>(): StructuredStreamParser<T> {
  let buf = '';
  let depth = 0;
  let inString = false;
  let escape = false;
  let lastValid: T | null = null;

  const tryParse = (): T | null => {
    if (buf.length === 0) return null;
    try {
      return JSON.parse(buf) as T;
    } catch {
      return null;
    }
  };

  return {
    feed(chunk) {
      for (const ch of chunk) {
        buf += ch;
        // SECURITY 2026-06-04: cap running buffer to prevent attacker
        // (or buggy upstream) from inflating memory with unterminated
        // strings / objects (DoS class).
        if (buf.length > JSON_STREAM_MAX_BUFFER_BYTES) {
          throw new Error(`JSON stream buffer exceeded ${JSON_STREAM_MAX_BUFFER_BYTES} bytes`);
        }
        if (escape) { escape = false; continue; }
        if (inString) {
          if (ch === '\\') escape = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) {
            const v = tryParse();
            if (v !== null) {
              lastValid = v;
              // Snapshot semantics: clear buf so a subsequent feed of a
              // fresh JSON document starts clean. Common pattern when a
              // streaming responder re-emits the running object each tick.
              buf = '';
            }
          }
        }
      }
      return lastValid;
    },
    finish() {
      if (buf.length === 0 && lastValid !== null) return lastValid;
      const v = tryParse();
      if (v === null) {
        throw new Error(`incomplete JSON at end of stream: depth=${depth} inString=${inString}`);
      }
      return v;
    },
  };
}

// ── Convenience: collect a stream into a single string ────────────────

export async function streamToString(stream: AsyncIterable<StreamChunk>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of stream) {
    if (chunk.kind === 'text') parts.push(chunk.text);
  }
  return parts.join('');
}

/** Measure TTFT from a stream — wall-clock until first 'text' chunk. */
export async function measureTtft(
  stream: AsyncIterable<StreamChunk>,
  now: () => number,
): Promise<{ ttftMs: number; full: string }> {
  const start = now();
  let ttftMs = -1;
  const parts: string[] = [];
  for await (const chunk of stream) {
    if (chunk.kind === 'text') {
      if (ttftMs === -1) ttftMs = now() - start;
      parts.push(chunk.text);
    }
  }
  return { ttftMs: ttftMs === -1 ? now() - start : ttftMs, full: parts.join('') };
}

export const VERSION = '0.0.0';
