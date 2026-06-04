/**
 * Direct OpenAI Chat Completions adapter — closes the second-provider gap.
 *
 * No `openai` SDK hard dep — fetch-injected. Implements:
 *   - ChatModel.chat() — non-streaming, returns string
 *   - ChatModelStreaming.chatStream() — SSE-streamed StreamChunks
 *
 * API ref: POST https://api.openai.com/v1/chat/completions
 *   stream: false → JSON body
 *   stream: true  → SSE body with chunks emitting choices[0].delta.content
 *
 * Pydantic-AI covers 8 providers; this is the second TENET-direct
 * provider after Anthropic. Bedrock + Gemini coming separately.
 */

import {
  parseSseStream,
  type ChatModelStreaming,
  type StreamChunk,
} from '@tenet/streaming';

export interface OpenAiHttp {
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
  chat(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface OpenAiChatModelOptions {
  apiKey: string;
  /** e.g. 'gpt-5.1', 'gpt-4o', 'o1', etc. */
  model: string;
  /** Default 0.2 (verifier-friendly). */
  temperature?: number;
  /** Base URL. Default 'https://api.openai.com'. */
  baseUrl?: string;
  /** Optional org id. */
  organization?: string;
}

export class OpenAiApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`OpenAI returned ${status}: ${body.slice(0, 200)}`);
    this.name = 'OpenAiApiError';
  }
}

export class OpenAiChatModel implements ChatModel, ChatModelStreaming {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly baseUrl: string;
  private readonly organization: string | undefined;

  constructor(
    private readonly http: OpenAiHttp,
    opts: OpenAiChatModelOptions,
  ) {
    if (!opts.apiKey) throw new Error('OpenAiChatModel: apiKey required');
    if (!opts.model) throw new Error('OpenAiChatModel: model required');
    const t = opts.temperature ?? 0.2;
    if (t < 0 || t > 2) throw new Error('temperature must be in [0,2]');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.temperature = t;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com').replace(/\/+$/, '');
    this.organization = opts.organization;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };
    if (this.organization !== undefined) h['openai-organization'] = this.organization;
    return h;
  }

  async chat(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<string> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const body = JSON.stringify({
      model: this.model,
      temperature: this.temperature,
      max_tokens: args.maxTokens,
      stream: false,
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
    });
    const res = await this.http.fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new OpenAiApiError(res.status, text);
    }
    return this.parseChat(text);
  }

  private parseChat(body: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`OpenAI response not valid JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('OpenAI response not an object');
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error('OpenAI response.choices empty');
    }
    const msg = (choices[0] as { message?: unknown }).message;
    const content = (msg as { content?: unknown } | undefined)?.content;
    return typeof content === 'string' ? content : '';
  }

  async *chatStream(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): AsyncIterable<StreamChunk> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const body = JSON.stringify({
      model: this.model,
      temperature: this.temperature,
      max_tokens: args.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
    });
    const res = await this.http.fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text();
      throw new OpenAiApiError(res.status, text);
    }
    if (!res.body) throw new Error('OpenAI streaming response has no body');

    for await (const ev of parseSseStream(res.body, args.signal)) {
      if (ev.data === '[DONE]') return;
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data); } catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      const choices = (parsed as { choices?: unknown }).choices;
      const usage = (parsed as { usage?: unknown }).usage;
      if (Array.isArray(choices) && choices.length > 0) {
        const delta = (choices[0] as { delta?: { content?: unknown } }).delta;
        const content = delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          yield { kind: 'text', text: content };
        }
        const finish = (choices[0] as { finish_reason?: unknown }).finish_reason;
        if (typeof finish === 'string' && finish.length > 0) {
          yield { kind: 'message_stop', stopReason: finish };
        }
      }
      if (usage && typeof usage === 'object') {
        const inT = (usage as { prompt_tokens?: unknown }).prompt_tokens;
        const outT = (usage as { completion_tokens?: unknown }).completion_tokens;
        if (typeof inT === 'number' && typeof outT === 'number') {
          yield { kind: 'usage', inputTokens: inT, outputTokens: outT };
        }
      }
    }
  }
}

export const VERSION = '0.0.0';
