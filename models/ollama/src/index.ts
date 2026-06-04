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
 * for the wire format, but we still emit @tenet/streaming StreamChunk
 * shapes so consumers see one consistent type.
 */

import type { ChatModelStreaming, StreamChunk } from '@tenet/streaming';

export interface OllamaHttp {
  fetch(input: string, init: {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string>; body?: ReadableStream<Uint8Array> | null }>;
}

export interface ChatModel {
  chat(args: { system: string; user: string; maxTokens: number; signal?: AbortSignal }): Promise<string>;
}

export interface OllamaChatModelOptions {
  /** e.g. 'llama3.3', 'qwen2.5', 'gemma2'. */
  model: string;
  /** Default 0.2 (verifier-friendly). Ollama accepts any non-negative. */
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

export class OllamaChatModel implements ChatModel, ChatModelStreaming {
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

  private buildBody(args: { system: string; user: string; maxTokens: number }, stream: boolean): string {
    return JSON.stringify({
      model: this.model,
      stream,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      options: { temperature: this.temperature, num_predict: args.maxTokens },
    });
  }

  async chat(args: { system: string; user: string; maxTokens: number; signal?: AbortSignal }): Promise<string> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const res = await this.http.fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: this.buildBody(args, false),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new OllamaApiError(res.status, text);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error(`Ollama not JSON: ${(e as Error).message}`); }
    if (!parsed || typeof parsed !== 'object') return '';
    const msg = (parsed as { message?: { content?: unknown } }).message;
    return typeof msg?.content === 'string' ? msg.content : '';
  }

  async *chatStream(args: { system: string; user: string; maxTokens: number; signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const res = await this.http.fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: this.buildBody(args, true),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
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
        if (args.signal?.aborted) throw new Error('aborted');
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
            yield { kind: 'message_stop', stopReason: typeof reason === 'string' ? reason : 'stop' };
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
