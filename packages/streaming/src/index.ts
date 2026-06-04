/**
 * Streaming ChatModel contract — closes the table-stakes gap vs
 * Pydantic-AI / Mastra / OpenAI Agents SDK.
 *
 * Non-breaking: ChatModelStreaming is a SEPARATE interface. Existing
 * ChatModel adapters stay unchanged. Adapters that support streaming
 * implement both; the verifier / router asks for streaming when the
 * surface supports it and falls back to non-streaming otherwise.
 *
 * Three shipped capabilities:
 *   1. ChatModelStreaming — AsyncIterable<StreamChunk> protocol
 *   2. parseSseStream() — SSE event-stream parser (Anthropic, OpenAI,
 *      Mistral all use SSE)
 *   3. structuredStreamingParser() — incremental JSON-shape validator
 *      so callers see partial structured output as it arrives
 *      (Pydantic-AI's headline differentiator — now ours too)
 */

// ── Streaming ChatModel contract ──────────────────────────────────────

export type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use_start'; id: string; name: string }
  | { kind: 'tool_use_delta'; id: string; partial: string }
  | { kind: 'tool_use_end'; id: string }
  | { kind: 'message_stop'; stopReason: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number };

export interface ChatModelStreaming {
  chatStream(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): AsyncIterable<StreamChunk>;
}

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
