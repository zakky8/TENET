/**
 * Mistral La Plateforme ChatModel — REST + SSE streaming.
 *
 * API ref: POST https://api.mistral.ai/v1/chat/completions
 *   stream:false → JSON; stream:true → SSE with [DONE] sentinel.
 *
 * The body shape is OpenAI-Chat-Completions compatible (Mistral
 * deliberately mirrors it), so this adapter is structurally identical
 * to models-openai with different default baseUrl and no
 * stream_options. Could collapse to a shared base; we keep the
 * adapters separate to stay loyal to per-vendor evolution.
 */

import { parseSseStream, type ChatModelStreaming, type StreamChunk } from '@tenet/streaming';

export interface MistralHttp {
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

export interface MistralChatModelOptions {
  apiKey: string;
  /** e.g. 'mistral-large-latest', 'mistral-small-latest'. */
  model: string;
  /** Default 0.2. Mistral accepts [0,1]. */
  temperature?: number;
  /** Default 'https://api.mistral.ai'. */
  baseUrl?: string;
}

export class MistralApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Mistral API ${status}: ${body.slice(0, 200)}`);
    this.name = 'MistralApiError';
  }
}

export class MistralChatModel implements ChatModel, ChatModelStreaming {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly baseUrl: string;

  constructor(private readonly http: MistralHttp, opts: MistralChatModelOptions) {
    if (!opts.apiKey) throw new Error('MistralChatModel: apiKey required');
    if (!opts.model) throw new Error('MistralChatModel: model required');
    const t = opts.temperature ?? 0.2;
    if (t < 0 || t > 1) throw new Error('temperature must be in [0,1]');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.temperature = t;
    this.baseUrl = (opts.baseUrl ?? 'https://api.mistral.ai').replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
  }

  private buildBody(args: { system: string; user: string; maxTokens: number }, stream: boolean): string {
    return JSON.stringify({
      model: this.model,
      temperature: this.temperature,
      max_tokens: args.maxTokens,
      stream,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
    });
  }

  async chat(args: { system: string; user: string; maxTokens: number; signal?: AbortSignal }): Promise<string> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const res = await this.http.fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(args, false),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new MistralApiError(res.status, text);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error(`Mistral response not JSON: ${(e as Error).message}`); }
    if (!parsed || typeof parsed !== 'object') return '';
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) return '';
    const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
    return typeof content === 'string' ? content : '';
  }

  async *chatStream(args: { system: string; user: string; maxTokens: number; signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const res = await this.http.fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(args, true),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    if (res.status < 200 || res.status >= 300) throw new MistralApiError(res.status, await res.text());
    if (!res.body) throw new Error('Mistral streaming response missing body');

    for await (const ev of parseSseStream(res.body, args.signal)) {
      if (ev.data === '[DONE]') return;
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data); } catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      const choices = (parsed as { choices?: unknown }).choices;
      const usage = (parsed as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
      if (Array.isArray(choices) && choices.length > 0) {
        const delta = (choices[0] as { delta?: { content?: unknown } }).delta;
        const content = delta?.content;
        if (typeof content === 'string' && content.length > 0) yield { kind: 'text', text: content };
        const finish = (choices[0] as { finish_reason?: unknown }).finish_reason;
        if (typeof finish === 'string' && finish.length > 0) yield { kind: 'message_stop', stopReason: finish };
      }
      if (usage) {
        const inT = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
        const outT = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
        if (inT > 0 || outT > 0) yield { kind: 'usage', inputTokens: inT, outputTokens: outT };
      }
    }
  }
}

export const VERSION = '0.0.0';
