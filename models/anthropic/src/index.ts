/**
 * Direct Anthropic API ChatModel.
 *
 * Talks to https://api.anthropic.com/v1/messages directly (not via
 * Bedrock). Companion to @tenet/models-bedrock for callers who want
 * Anthropic's direct billing, prompt-caching extensions, and the
 * latest model IDs without the Bedrock wrapper.
 *
 * Design — no @anthropic-ai/sdk hard dep: accepts an injected
 * AnthropicHttp shape (any fetch-compatible function works). This
 * keeps the package dep-free and lets callers wire their own retry /
 * proxy / observability middleware.
 */

/** Minimal HTTP contract — fetch-compatible. */
export interface AnthropicHttp {
  fetch(input: string, init: {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal;
  }): Promise<{
    status: number;
    text(): Promise<string>;
    /** Present on streaming responses. */
    body?: ReadableStream<Uint8Array> | null;
  }>;
}

/** ChatModel contract — matches @tenet/verifier's ChatModel. */
export interface ChatModel {
  chat(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface AnthropicChatModelOptions {
  /** Anthropic API key (sk-ant-...). */
  apiKey: string;
  /** Model id, e.g. 'claude-opus-4-8-20260528'. */
  model: string;
  /** Anthropic-Version header. Default '2023-06-01'. */
  anthropicVersion?: string;
  /** Temperature 0..1. Default 0.2 (verifier-friendly). */
  temperature?: number;
  /** Base URL. Default 'https://api.anthropic.com'. */
  baseUrl?: string;
  /** Beta features (enables prompt caching, etc.). */
  betas?: ReadonlyArray<string>;
}

export class AnthropicChatModel implements ChatModel {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly anthropicVersion: string;
  private readonly temperature: number;
  private readonly baseUrl: string;
  private readonly betas: ReadonlyArray<string>;

  constructor(
    private readonly http: AnthropicHttp,
    opts: AnthropicChatModelOptions,
  ) {
    if (!opts.apiKey) throw new Error('AnthropicChatModel: apiKey required');
    if (!opts.model) throw new Error('AnthropicChatModel: model required');
    const t = opts.temperature ?? 0.2;
    if (t < 0 || t > 1) throw new Error('temperature must be in [0,1]');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.anthropicVersion = opts.anthropicVersion ?? '2023-06-01';
    this.temperature = t;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.betas = opts.betas ?? [];
  }

  async chat(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<string> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
    };
    if (this.betas.length > 0) {
      headers['anthropic-beta'] = this.betas.join(',');
    }

    const body = JSON.stringify({
      model: this.model,
      max_tokens: args.maxTokens,
      temperature: this.temperature,
      system: args.system,
      messages: [{ role: 'user', content: args.user }],
    });

    const res = await this.http.fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });

    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new AnthropicApiError(res.status, text);
    }
    return this.parseResponse(text);
  }

  private parseResponse(body: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`Anthropic response was not valid JSON: ${(e as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('Anthropic response was not a JSON object');
    }
    const content = (parsed as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      throw new Error('Anthropic response.content must be an array');
    }
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const t = (block as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    return parts.join('');
  }

  /**
   * SSE-streamed Anthropic Messages API. Closes the OSS-streaming-gap
   * confirmed by 2026 research. Emits StreamChunks compatible with
   * @tenet/streaming so eval-measure's measureTtft + the verifier's
   * streaming path see a consistent shape across providers.
   *
   * Anthropic event-stream events we honor:
   *   - content_block_delta + delta.text → text chunk
   *   - message_delta + usage → usage chunk
   *   - message_stop → message_stop chunk
   * Other events (ping, content_block_start/stop, message_start) are
   * intentionally not surfaced — they're framework-internal and the
   * verifier doesn't need them.
   */
  async *chatStream(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): AsyncIterable<import('@tenet/streaming').StreamChunk> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
      accept: 'text/event-stream',
    };
    if (this.betas.length > 0) headers['anthropic-beta'] = this.betas.join(',');

    const body = JSON.stringify({
      model: this.model,
      max_tokens: args.maxTokens,
      temperature: this.temperature,
      system: args.system,
      stream: true,
      messages: [{ role: 'user', content: args.user }],
    });

    const res = await this.http.fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text();
      throw new AnthropicApiError(res.status, text);
    }
    if (!res.body) throw new Error('Anthropic streaming response missing body');

    const { parseSseStream } = await import('@tenet/streaming');
    for await (const ev of parseSseStream(res.body, args.signal)) {
      let parsed: unknown;
      try { parsed = JSON.parse(ev.data); } catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      const type = (parsed as { type?: unknown }).type;
      if (type === 'content_block_delta') {
        const delta = (parsed as { delta?: { type?: unknown; text?: unknown } }).delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { kind: 'text', text: delta.text };
        }
      } else if (type === 'message_delta') {
        const usage = (parsed as { usage?: { output_tokens?: unknown; input_tokens?: unknown } }).usage;
        if (usage && typeof usage === 'object') {
          const inT = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
          const outT = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
          if (outT > 0 || inT > 0) yield { kind: 'usage', inputTokens: inT, outputTokens: outT };
        }
      } else if (type === 'message_stop') {
        yield { kind: 'message_stop', stopReason: 'end_turn' };
        return;
      }
    }
  }
}

export class AnthropicApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Anthropic API ${status}: ${body.slice(0, 200)}`);
    this.name = 'AnthropicApiError';
  }
}

export const VERSION = '0.0.0';
