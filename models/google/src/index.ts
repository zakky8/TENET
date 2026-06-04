/**
 * Google Gemini ChatModel — REST + SSE streaming.
 *
 * No @google/generative-ai SDK hard dep; injectable HTTP. Targets
 * the generativelanguage.googleapis.com v1beta endpoint, which is
 * the stable surface for non-Vertex callers. (Vertex AI is a
 * separate adapter — different auth, different URL shape.)
 *
 * API ref:
 *   POST /v1beta/models/{model}:generateContent      (non-streaming)
 *   POST /v1beta/models/{model}:streamGenerateContent?alt=sse  (SSE)
 *
 * Pydantic-AI ships 8 providers; this is provider #4 for TENET
 * (after Anthropic, Bedrock, OpenAI). Mistral + Ollama in parallel
 * commits this turn.
 */

import { parseSseStream, type ChatModelStreaming, type StreamChunk } from '@tenet/streaming';

export interface GoogleHttp {
  fetch(input: string, init: {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal;
  }): Promise<{
    status: number;
    text(): Promise<string>;
    body?: ReadableStream<Uint8Array> | null;
  }>;
}

export interface ChatModel {
  chat(args: { system: string; user: string; maxTokens: number; signal?: AbortSignal }): Promise<string>;
}

export interface GoogleChatModelOptions {
  apiKey: string;
  /** e.g. 'gemini-2.5-pro', 'gemini-2.5-flash'. */
  model: string;
  /** Default 0.2. Gemini accepts [0,2]. */
  temperature?: number;
  /** Default 'https://generativelanguage.googleapis.com'. */
  baseUrl?: string;
}

export class GoogleApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Google API ${status}: ${body.slice(0, 200)}`);
    this.name = 'GoogleApiError';
  }
}

export class GoogleChatModel implements ChatModel, ChatModelStreaming {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly baseUrl: string;

  constructor(private readonly http: GoogleHttp, opts: GoogleChatModelOptions) {
    if (!opts.apiKey) throw new Error('GoogleChatModel: apiKey required');
    if (!opts.model) throw new Error('GoogleChatModel: model required');
    const t = opts.temperature ?? 0.2;
    if (t < 0 || t > 2) throw new Error('temperature must be in [0,2]');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.temperature = t;
    this.baseUrl = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  }

  private buildBody(args: { system: string; user: string; maxTokens: number }): string {
    return JSON.stringify({
      systemInstruction: { parts: [{ text: args.system }] },
      contents: [{ role: 'user', parts: [{ text: args.user }] }],
      generationConfig: { temperature: this.temperature, maxOutputTokens: args.maxTokens },
    });
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey };
  }

  async chat(args: { system: string; user: string; maxTokens: number; signal?: AbortSignal }): Promise<string> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const res = await this.http.fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(args),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new GoogleApiError(res.status, text);
    return this.parseChat(text);
  }

  private parseChat(body: string): string {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch (e) { throw new Error(`Google response not JSON: ${(e as Error).message}`); }
    if (!parsed || typeof parsed !== 'object') throw new Error('Google response not object');
    const candidates = (parsed as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    const content = (candidates[0] as { content?: { parts?: unknown } }).content;
    const parts = content?.parts;
    if (!Array.isArray(parts)) return '';
    const out: string[] = [];
    for (const p of parts) {
      if (p && typeof p === 'object') {
        const t = (p as { text?: unknown }).text;
        if (typeof t === 'string') out.push(t);
      }
    }
    return out.join('');
  }

  async *chatStream(args: {
    system: string; user: string; maxTokens: number; signal?: AbortSignal;
  }): AsyncIterable<StreamChunk> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    const res = await this.http.fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(args),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new GoogleApiError(res.status, await res.text());
    }
    if (!res.body) throw new Error('Google streaming response missing body');

    for await (const ev of parseSseStream(res.body, args.signal)) {
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data); } catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      const candidates = (parsed as { candidates?: unknown }).candidates;
      const usage = (parsed as { usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown } }).usageMetadata;
      if (Array.isArray(candidates)) {
        for (const c of candidates) {
          const parts = (c as { content?: { parts?: unknown } }).content?.parts;
          const finish = (c as { finishReason?: unknown }).finishReason;
          if (Array.isArray(parts)) {
            for (const p of parts) {
              const t = (p as { text?: unknown })?.text;
              if (typeof t === 'string' && t.length > 0) yield { kind: 'text', text: t };
            }
          }
          if (typeof finish === 'string' && finish.length > 0 && finish !== 'FINISH_REASON_UNSPECIFIED') {
            yield { kind: 'message_stop', stopReason: finish };
          }
        }
      }
      if (usage) {
        const inT = typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0;
        const outT = typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;
        if (inT > 0 || outT > 0) yield { kind: 'usage', inputTokens: inT, outputTokens: outT };
      }
    }
  }
}

export const VERSION = '0.0.0';
