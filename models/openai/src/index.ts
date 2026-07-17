/**
 * Direct OpenAI Chat Completions adapter — closes the second-provider gap.
 *
 * No `openai` SDK hard dep — fetch-injected. Implements the canonical
 * @tenet/core ChatModel:
 *   - chat() — non-streaming, block-structured ChatRequest → ChatResponse
 *   - chatStream() — SSE-streamed core StreamChunks
 *
 * API ref: POST https://api.openai.com/v1/chat/completions
 *   stream: false → JSON body
 *   stream: true  → SSE body with chunks emitting choices[0].delta.content
 *
 * Increment 1.2b-i: migrated from the old local single-string ChatModel
 * to the canonical @tenet/core contract, and maps OpenAI's
 * `finish_reason` onto the canonical StopReason in both the
 * non-streaming and streaming paths (the streaming path previously
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

export interface OpenAiChatModelOptions {
  apiKey: string;
  /** e.g. 'gpt-5.1', 'gpt-4o', 'o1', etc. */
  model: string;
  /** Default 0.2 (verifier-friendly). Overridden per-request by ChatRequest.temperature. */
  temperature?: number;
  /** Base URL. Default 'https://api.openai.com'. */
  baseUrl?: string;
  /** Optional org id. */
  organization?: string;
}

/** Map OpenAI's raw finish_reason onto the canonical StopReason.
 *  Unknown / absent values degrade to 'end_turn'. */
function mapFinishReason(raw: unknown): StopReason {
  switch (raw) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'function_call': return 'tool_use';
    case 'content_filter': return 'refusal';
    default: return 'end_turn';
  }
}

/** Canonical ToolDef → OpenAI wire tool definition. */
function toOpenAiTool(t: ToolDef): {
  type: 'function';
  function: { name: string; description: string; parameters: Readonly<Record<string, unknown>> };
} {
  return {
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  };
}

/**
 * Canonical messages → OpenAI Chat Completions `messages` array.
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
function toOpenAiMessages(
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

/** OpenAI response choice message → canonical ContentBlock[]. */
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

/** Strip Bearer tokens / Authorization headers from echoed error bodies. */
function scrubSecrets(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/(authorization\s*:\s*)[^\s,"]+/gi, '$1[redacted]');
}

export class OpenAiApiError extends Error {
  /** Scrubbed body — Bearer tokens / sk- keys / Authorization values removed. */
  public readonly body: string;
  constructor(public readonly status: number, body: string) {
    const scrubbed = scrubSecrets(body).slice(0, 200);
    super(`OpenAI returned ${status}: ${scrubbed}`);
    this.body = scrubbed;
    this.name = 'OpenAiApiError';
  }
}

export class OpenAiChatModel implements ChatModel {
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

  private buildBody(req: ChatRequest, stream: boolean): string {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: req.temperature ?? this.temperature,
      max_tokens: req.maxTokens,
      stream,
      messages: toOpenAiMessages(req.system, req.messages),
    };
    if (req.tools !== undefined && req.tools.length > 0) {
      body['tools'] = req.tools.map(toOpenAiTool);
    }
    if (stream) body['stream_options'] = { include_usage: true };
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
    if (res.status < 200 || res.status >= 300) {
      throw new OpenAiApiError(res.status, text);
    }
    return this.parseChat(text);
  }

  private parseChat(body: string): ChatResponse {
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
    const choice = choices[0] as { message?: unknown; finish_reason?: unknown };
    const usage = parseUsage(parsed);
    return {
      content: parseContentBlocks(choice.message),
      stopReason: mapFinishReason(choice.finish_reason),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /**
   * SSE-streamed Chat Completions. Emits the canonical @tenet/core
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
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text();
      throw new OpenAiApiError(res.status, text);
    }
    if (!res.body) throw new Error('OpenAI streaming response has no body');

    let capturedFinish: unknown;

    for await (const ev of parseSseStream(res.body, req.signal)) {
      if (ev.data === '[DONE]') break;
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
          capturedFinish = finish;
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
    yield { kind: 'message_stop', stopReason: mapFinishReason(capturedFinish) };
  }
}

export const VERSION = '0.0.0';
