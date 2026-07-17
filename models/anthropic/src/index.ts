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
 *
 * Increment 1.2a: implements the canonical @tenet/core ChatModel
 * (block-structured ChatRequest → ChatResponse) instead of the old
 * local single-string interface, and maps Anthropic's `stop_reason`
 * faithfully in both the non-streaming and streaming paths (the
 * streaming path previously hardcoded 'end_turn').
 */

import type {
  ChatModel,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  ModelMessage,
  StopReason,
  StreamChunk,
  ToolDef,
} from '@tenet/core';

/**
 * @deprecated Transitional re-export: the legacy single-string model
 * shape (identical to this package's pre-1.2a local `ChatModel`),
 * kept so un-migrated consumers (apps/measure-real's runner) keep
 * compiling. New code: use the canonical `ChatModel` from
 * '@tenet/core' and wrap with `asLegacyModel()` where a legacy
 * single-string model is required.
 */
export type { LegacySingleStringModel as LegacyChatModel } from '@tenet/core';

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

export interface AnthropicChatModelOptions {
  /** Anthropic API key (sk-ant-...). */
  apiKey: string;
  /** Model id, e.g. 'claude-opus-4-8-20260528'. */
  model: string;
  /** Anthropic-Version header. Default '2023-06-01'. */
  anthropicVersion?: string;
  /** Temperature 0..1. Default 0.2 (verifier-friendly). Overridden per-request by ChatRequest.temperature. */
  temperature?: number;
  /** Base URL. Default 'https://api.anthropic.com'. */
  baseUrl?: string;
  /** Beta features (enables prompt caching, etc.). */
  betas?: ReadonlyArray<string>;
}

/** Map Anthropic's raw stop_reason to the canonical StopReason.
 *  The canonical values were chosen to MATCH Anthropic's wire strings,
 *  so this is near-identity; anything unknown (incl. null/undefined)
 *  degrades to 'end_turn'. */
function mapStopReason(raw: unknown): StopReason {
  switch (raw) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
    case 'tool_use':
    case 'refusal':
      return raw;
    default:
      return 'end_turn';
  }
}

/** Canonical ModelMessage → Anthropic wire message (array-of-blocks form). */
function toAnthropicMessage(m: ModelMessage): { role: string; content: unknown[] } {
  return {
    role: m.role,
    content: m.content.map((b): unknown => {
      switch (b.type) {
        case 'text':
          return { type: 'text', text: b.text };
        case 'tool_use':
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.content,
            ...(b.isError === true ? { is_error: true } : {}),
          };
      }
    }),
  };
}

/** Canonical ToolDef → Anthropic wire tool definition. */
function toAnthropicTool(t: ToolDef): {
  name: string;
  description: string;
  input_schema: Readonly<Record<string, unknown>>;
} {
  return { name: t.name, description: t.description, input_schema: t.inputSchema };
}

/** Anthropic response content blocks → canonical ContentBlock[]. Unknown
 *  block types (thinking, server tool results, …) are skipped. */
function parseContentBlocks(content: ReadonlyArray<unknown>): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const type = (block as { type?: unknown }).type;
    if (type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') blocks.push({ type: 'text', text: t });
    } else if (type === 'tool_use') {
      const id = (block as { id?: unknown }).id;
      const name = (block as { name?: unknown }).name;
      const input = (block as { input?: unknown }).input;
      if (typeof id === 'string' && typeof name === 'string') {
        blocks.push({
          type: 'tool_use',
          id,
          name,
          input: (input !== null && typeof input === 'object'
            ? input
            : {}) as Readonly<Record<string, unknown>>,
        });
      }
    }
  }
  return blocks;
}

function parseUsage(
  parsed: object,
): { inputTokens: number; outputTokens: number } | undefined {
  const usage = (parsed as { usage?: unknown }).usage;
  if (usage === null || usage === undefined || typeof usage !== 'object') return undefined;
  const inT = (usage as { input_tokens?: unknown }).input_tokens;
  const outT = (usage as { output_tokens?: unknown }).output_tokens;
  if (typeof inT !== 'number' || typeof outT !== 'number') return undefined;
  return { inputTokens: inT, outputTokens: outT };
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

  private buildHeaders(streaming: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.anthropicVersion,
    };
    if (streaming) headers['accept'] = 'text/event-stream';
    if (this.betas.length > 0) headers['anthropic-beta'] = this.betas.join(',');
    return headers;
  }

  private buildBody(req: ChatRequest, stream: boolean): string {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? this.temperature,
      system: req.system,
      messages: req.messages.map(toAnthropicMessage),
    };
    if (req.tools !== undefined && req.tools.length > 0) {
      body['tools'] = req.tools.map(toAnthropicTool);
    }
    if (stream) body['stream'] = true;
    return JSON.stringify(body);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (req.maxTokens <= 0) throw new Error('maxTokens must be > 0');

    const res = await this.http.fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.buildHeaders(false),
      body: this.buildBody(req, false),
      signal: req.signal,
    });

    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new AnthropicApiError(res.status, text);
    }
    return this.parseResponse(text);
  }

  private parseResponse(body: string): ChatResponse {
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
    const usage = parseUsage(parsed);
    return {
      content: parseContentBlocks(content),
      stopReason: mapStopReason((parsed as { stop_reason?: unknown }).stop_reason),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /**
   * SSE-streamed Anthropic Messages API. Emits the canonical
   * @tenet/core StreamChunk shapes so eval-measure's measureTtft +
   * the verifier's streaming path see a consistent shape across
   * providers.
   *
   * Anthropic event-stream events we honor:
   *   - content_block_delta + delta.text → text chunk
   *   - message_delta → captures delta.stop_reason (the REAL stop
   *     reason arrives here, not on message_stop) + usage chunk
   *   - message_stop → message_stop chunk carrying the captured
   *     stop reason (previously hardcoded 'end_turn' — bug fixed)
   * Other events (ping, content_block_start/stop, message_start) are
   * intentionally not surfaced — they're framework-internal and the
   * verifier doesn't need them.
   */
  async *chatStream(req: ChatRequest): AsyncIterable<StreamChunk> {
    if (req.maxTokens <= 0) throw new Error('maxTokens must be > 0');

    const res = await this.http.fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.buildHeaders(true),
      body: this.buildBody(req, true),
      signal: req.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text();
      throw new AnthropicApiError(res.status, text);
    }
    if (!res.body) throw new Error('Anthropic streaming response missing body');

    let capturedStopReason: unknown;

    const { parseSseStream } = await import('@tenet/streaming');
    for await (const ev of parseSseStream(res.body, req.signal)) {
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
        const delta = (parsed as { delta?: { stop_reason?: unknown } }).delta;
        if (delta !== null && typeof delta === 'object' && delta.stop_reason !== undefined) {
          capturedStopReason = delta.stop_reason;
        }
        const usage = (parsed as { usage?: { output_tokens?: unknown; input_tokens?: unknown } }).usage;
        if (usage && typeof usage === 'object') {
          const inT = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
          const outT = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
          if (outT > 0 || inT > 0) yield { kind: 'usage', inputTokens: inT, outputTokens: outT };
        }
      } else if (type === 'message_stop') {
        yield { kind: 'message_stop', stopReason: mapStopReason(capturedStopReason) };
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
