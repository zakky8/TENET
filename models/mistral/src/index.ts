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
 *
 * Increment 1.2b-i: migrated from the old local single-string ChatModel
 * to the canonical @tenet/core contract, and maps Mistral's
 * OpenAI-style `finish_reason` onto the canonical StopReason in both
 * the non-streaming and streaming paths (the streaming path previously
 * leaked the raw provider string).
 */

import { parseSseStream } from '@tenet/streaming';
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

export interface MistralHttp {
  fetch(input: string, init: {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string>; body?: ReadableStream<Uint8Array> | null }>;
}

export interface MistralChatModelOptions {
  apiKey: string;
  /** e.g. 'mistral-large-latest', 'mistral-small-latest'. */
  model: string;
  /** Default 0.2. Mistral accepts [0,1]. Overridden per-request by ChatRequest.temperature. */
  temperature?: number;
  /** Default 'https://api.mistral.ai'. */
  baseUrl?: string;
}

/** Map Mistral's raw (OpenAI-style) finish_reason onto the canonical
 *  StopReason. Unknown / absent values degrade to 'end_turn'. */
function mapFinishReason(raw: unknown): StopReason {
  switch (raw) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    // Mistral-specific: 'model_length' = the context window was exceeded — a TRUNCATION,
    // so it maps to max_tokens, NOT the default end_turn. Reporting a context-truncated
    // draft as a clean end_turn is the exact truncation-masking bug this phase exists to fix.
    case 'model_length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'function_call': return 'tool_use';
    case 'content_filter': return 'refusal';
    default: return 'end_turn';
  }
}

/** Canonical ToolDef → Mistral (OpenAI-style) wire tool definition. */
function toMistralTool(t: ToolDef): {
  type: 'function';
  function: { name: string; description: string; parameters: Readonly<Record<string, unknown>> };
} {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  };
}

/**
 * Canonical messages → Mistral (OpenAI-style) `messages` array.
 * System prompt (when non-empty) is prepended as a system message.
 *
 * Common path: text-only content joined into a single `content` string.
 * Trivial tool mapping: assistant tool_use blocks → `tool_calls`;
 * tool_result blocks → role:'tool' messages (emitted before any text
 * from the same ModelMessage).
 * TODO: intra-message block ordering for mixed tool/text turns is
 * flattened (tool messages first) — no reasoner consumer exercises
 * multi-turn tool round-trips yet, so we deliberately keep this minimal.
 */
function toMistralMessages(
  system: string,
  messages: ReadonlyArray<ModelMessage>,
): unknown[] {
  const out: unknown[] = [];
  if (system.length > 0) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const toolUses = m.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    const toolResults = m.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
    );
    for (const r of toolResults) {
      out.push({ role: 'tool', tool_call_id: r.toolUseId, content: r.content });
    }
    if (toolUses.length > 0) {
      out.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        tool_calls: toolUses.map((u) => ({
          id: u.id,
          type: 'function',
          function: { name: u.name, arguments: JSON.stringify(u.input) },
        })),
      });
    } else if (toolResults.length === 0 || text.length > 0) {
      out.push({ role: m.role, content: text });
    }
  }
  return out;
}

/** Mistral response choice message → canonical ContentBlock[]. */
function parseContentBlocks(msg: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (msg === null || typeof msg !== 'object') return blocks;
  const content = (msg as { content?: unknown }).content;
  if (typeof content === 'string' && content.length > 0) {
    blocks.push({ type: 'text', text: content });
  }
  const toolCalls = (msg as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (tc === null || typeof tc !== 'object') continue;
      const id = (tc as { id?: unknown }).id;
      const fn = (tc as { function?: { name?: unknown; arguments?: unknown } }).function;
      if (typeof id !== 'string' || fn === null || typeof fn !== 'object') continue;
      if (typeof fn.name !== 'string') continue;
      let input: Readonly<Record<string, unknown>> = {};
      if (typeof fn.arguments === 'string') {
        try {
          const parsed: unknown = JSON.parse(fn.arguments);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            input = parsed as Readonly<Record<string, unknown>>;
          }
        } catch { /* malformed arguments → {} */ }
      }
      blocks.push({ type: 'tool_use', id, name: fn.name, input });
    }
  }
  return blocks;
}

function parseUsage(
  parsed: object,
): { inputTokens: number; outputTokens: number } | undefined {
  const usage = (parsed as { usage?: unknown }).usage;
  if (usage === null || usage === undefined || typeof usage !== 'object') return undefined;
  const inT = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  const outT = (usage as { completion_tokens?: unknown }).completion_tokens;
  if (typeof inT !== 'number' || typeof outT !== 'number') return undefined;
  return { inputTokens: inT, outputTokens: outT };
}

export class MistralApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Mistral API ${status}: ${body.slice(0, 200)}`);
    this.name = 'MistralApiError';
  }
}

export class MistralChatModel implements ChatModel {
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

  private buildBody(req: ChatRequest, stream: boolean): string {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: req.temperature ?? this.temperature,
      max_tokens: req.maxTokens,
      stream,
      messages: toMistralMessages(req.system, req.messages),
    };
    if (req.tools !== undefined && req.tools.length > 0) {
      body['tools'] = req.tools.map(toMistralTool);
    }
    return JSON.stringify(body);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (req.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const res = await this.http.fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(req, false),
      signal: req.signal,
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new MistralApiError(res.status, text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(`Mistral response not JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('Mistral response not an object');
    const choices = (parsed as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error('Mistral response.choices empty');
    }
    const choice = choices[0] as { message?: unknown; finish_reason?: unknown };
    const usage = parseUsage(parsed);
    return {
      content: parseContentBlocks(choice.message),
      stopReason: mapFinishReason(choice.finish_reason),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /**
   * SSE-streamed chat completions. Emits the canonical @tenet/core
   * StreamChunk shapes. The raw `finish_reason` is CAPTURED when it
   * arrives on a chunk and mapped onto the canonical StopReason for the
   * single `message_stop` chunk emitted at stream end (previously the
   * raw provider string leaked out — bug now that StopReason is
   * canonical).
   */
  async *chatStream(req: ChatRequest): AsyncIterable<StreamChunk> {
    if (req.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const res = await this.http.fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(req, true),
      signal: req.signal,
    });
    if (res.status < 200 || res.status >= 300) throw new MistralApiError(res.status, await res.text());
    if (!res.body) throw new Error('Mistral streaming response missing body');

    let capturedFinish: unknown;

    for await (const ev of parseSseStream(res.body, req.signal)) {
      if (ev.data === '[DONE]') break;
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
        if (typeof finish === 'string' && finish.length > 0) capturedFinish = finish;
      }
      if (usage && typeof usage === 'object') {
        const inT = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
        const outT = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
        if (inT > 0 || outT > 0) yield { kind: 'usage', inputTokens: inT, outputTokens: outT };
      }
    }
    yield { kind: 'message_stop', stopReason: mapFinishReason(capturedFinish) };
  }
}

export const VERSION = '0.0.0';
