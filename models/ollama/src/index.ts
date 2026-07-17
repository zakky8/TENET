/**
 * Ollama (self-host) ChatModel.
 *
 * Ollama serves locally at http://localhost:11434 by default (or any
 * operator-configured host). The HIPAA / air-gapped / on-prem use
 * case our enterprise customers care about.
 *
 * Wire shape: POST /api/chat
 *   { model, messages, stream, options: { temperature, num_predict } }
 *   stream:false → JSON; stream:true → NDJSON (one JSON object per line).
 *
 * Note: Ollama uses NEWLINE-delimited JSON for streaming, NOT SSE.
 * We parse line-by-line directly; no @tenet/streaming SSE dep needed
 * for the wire format — chunks are the canonical @tenet/core
 * StreamChunk shapes so consumers see one consistent type.
 *
 * Increment 1.2b-ii: implements the canonical @tenet/core ChatModel
 * (block-structured ChatRequest → ChatResponse) instead of the old
 * local single-string interface, and maps Ollama's `done_reason` onto
 * the canonical StopReason in both the non-streaming and streaming
 * paths (the streaming path previously leaked the raw provider
 * string, e.g. 'length').
 */

import type {
  ChatModel,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  ModelMessage,
  StopReason,
  StreamChunk,
} from '@tenet/core';

export interface OllamaHttp {
  fetch(input: string, init: {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string>; body?: ReadableStream<Uint8Array> | null }>;
}

export interface OllamaChatModelOptions {
  /** e.g. 'llama3.3', 'qwen2.5', 'gemma2'. */
  model: string;
  /** Default 0.2 (verifier-friendly). Ollama accepts any non-negative. Overridden per-request by ChatRequest.temperature. */
  temperature?: number;
  /** Base URL. Default 'http://localhost:11434'. */
  baseUrl?: string;
}

export class OllamaApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Ollama ${status}: ${body.slice(0, 200)}`);
    this.name = 'OllamaApiError';
  }
}

/** Map Ollama's raw done_reason onto the canonical StopReason.
 *  Unknown / absent values degrade to 'end_turn'. */
function mapDoneReason(raw: unknown): StopReason {
  switch (raw) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    default: return 'end_turn';
  }
}

/** Canonical messages → Ollama `messages`. System prompt (when
 *  non-empty) is prepended as a system message; text blocks are
 *  joined per turn (Ollama messages are single strings). */
function toOllamaMessages(
  system: string,
  messages: ReadonlyArray<ModelMessage>,
): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  if (system.length > 0) out.push({ role: 'system', content: system });
  for (const m of messages) {
    out.push({
      role: m.role,
      content: m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    });
  }
  return out;
}

export class OllamaChatModel implements ChatModel {
  private readonly model: string;
  private readonly temperature: number;
  private readonly baseUrl: string;

  constructor(private readonly http: OllamaHttp, opts: OllamaChatModelOptions) {
    if (!opts.model) throw new Error('OllamaChatModel: model required');
    const t = opts.temperature ?? 0.2;
    if (t < 0) throw new Error('temperature must be >= 0');
    this.model = opts.model;
    this.temperature = t;
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  }

  private buildBody(req: ChatRequest, stream: boolean): string {
    return JSON.stringify({
      model: this.model,
      stream,
      messages: toOllamaMessages(req.system, req.messages),
      options: { temperature: req.temperature ?? this.temperature, num_predict: req.maxTokens },
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (req.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const res = await this.http.fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: this.buildBody(req, false),
      signal: req.signal,
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new OllamaApiError(res.status, text);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error(`Ollama not JSON: ${(e as Error).message}`); }
    if (!parsed || typeof parsed !== 'object') return { content: [], stopReason: 'end_turn' };
    const msg = (parsed as { message?: { content?: unknown } }).message;
    const msgText = typeof msg?.content === 'string' ? msg.content : '';
    const content: ContentBlock[] = msgText.length > 0 ? [{ type: 'text', text: msgText }] : [];
    const inT = (parsed as { prompt_eval_count?: unknown }).prompt_eval_count;
    const outT = (parsed as { eval_count?: unknown }).eval_count;
    const usage = typeof inT === 'number' && typeof outT === 'number'
      ? { inputTokens: inT, outputTokens: outT }
      : undefined;
    return {
      content,
      stopReason: mapDoneReason((parsed as { done_reason?: unknown }).done_reason),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /**
   * NDJSON-streamed /api/chat. Emits the canonical @tenet/core
   * StreamChunk shapes. The raw `done_reason` arriving on the final
   * done:true frame is mapped onto the canonical StopReason for the
   * single `message_stop` chunk (previously the raw provider string
   * leaked out).
   */
  async *chatStream(req: ChatRequest): AsyncIterable<StreamChunk> {
    if (req.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const res = await this.http.fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: this.buildBody(req, true),
      signal: req.signal,
    });
    if (res.status < 200 || res.status >= 300) throw new OllamaApiError(res.status, await res.text());
    if (!res.body) throw new Error('Ollama streaming response missing body');

    // Ollama emits NDJSON (one JSON per line, NOT SSE).
    const decoder = new TextDecoder();
    const MAX_LINE = 1_048_576;
    let buf = '';
    const reader = res.body.getReader();
    try {
      while (true) {
        if (req.signal.aborted) throw new Error('aborted');
        const { value, done } = await reader.read();
        if (done) break;
        if (value) buf += decoder.decode(value, { stream: true });
        if (buf.length > MAX_LINE) throw new Error(`Ollama NDJSON line exceeded ${MAX_LINE} bytes`);
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === '') continue;
          let obj: unknown;
          try { obj = JSON.parse(line); } catch { continue; }
          if (!obj || typeof obj !== 'object') continue;
          const message = (obj as { message?: { content?: unknown } }).message;
          const content = message?.content;
          if (typeof content === 'string' && content.length > 0) yield { kind: 'text', text: content };
          const doneFlag = (obj as { done?: unknown }).done;
          if (doneFlag === true) {
            const inT = (obj as { prompt_eval_count?: unknown }).prompt_eval_count;
            const outT = (obj as { eval_count?: unknown }).eval_count;
            if (typeof inT === 'number' && typeof outT === 'number') {
              yield { kind: 'usage', inputTokens: inT, outputTokens: outT };
            }
            const reason = (obj as { done_reason?: unknown }).done_reason;
            yield { kind: 'message_stop', stopReason: mapDoneReason(reason) };
            return;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export const VERSION = '0.0.0';
