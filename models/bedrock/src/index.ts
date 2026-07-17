/**
 * AWS Bedrock ChatModel adapter (Anthropic Claude family).
 *
 * Design note — no AWS SDK as a hard dep:
 *   The adapter accepts a BedrockInvoker that callers wire to their
 *   own @aws-sdk/client-bedrock-runtime BedrockRuntimeClient. This
 *   keeps @tenet/models-bedrock dep-free for users who only want the
 *   contract definitions or who run a vendor-provided edge gateway
 *   (Cloudflare, Vercel, AWS Lambda extension) in front of Bedrock.
 *
 * Currently formats requests for Anthropic Claude on Bedrock. Other
 * Bedrock model families (Titan, Mistral, Llama) have different
 * request/response shapes and land as separate adapter classes
 * sharing the BedrockInvoker.
 *
 * Increment 1.2b-ii: implements the canonical @tenet/core ChatModel
 * (block-structured ChatRequest → ChatResponse) instead of the old
 * local single-string interface. Anthropic-on-Bedrock speaks the SAME
 * stop_reason vocabulary as the direct Anthropic API, so mapStopReason
 * is the same near-identity map. The non-streaming path previously
 * returned a bare string and DROPPED stop_reason/usage — both are now
 * surfaced; the streaming path previously leaked the raw provider
 * stop_reason string and emitted it mid-stream.
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

/** Minimal Bedrock invoker contract — wire to AWS SDK or your gateway. */
export interface BedrockInvoker {
  invokeModel(args: {
    modelId: string;
    body: string;
    signal?: AbortSignal;
  }): Promise<{ body: string }>;
}

/**
 * Streaming Bedrock invoker — wire to InvokeModelWithResponseStream.
 * Each yielded item is ONE decoded event payload: the UTF-8 string (or
 * raw bytes) of `chunk.bytes` from the AWS eventstream. With the AWS
 * SDK that wiring is:
 *
 *   async *invokeModelWithResponseStream(args) {
 *     const res = await client.send(new InvokeModelWithResponseStreamCommand({
 *       modelId: args.modelId, body: args.body,
 *       contentType: 'application/json', accept: 'application/json',
 *     }), { abortSignal: args.signal });
 *     for await (const ev of res.body!) {
 *       if (ev.chunk?.bytes) yield ev.chunk.bytes;
 *     }
 *   }
 */
export interface BedrockStreamInvoker {
  invokeModelWithResponseStream(args: {
    modelId: string;
    body: string;
    signal?: AbortSignal;
  }): AsyncIterable<Uint8Array | string>;
}

export interface AnthropicOnBedrockOptions {
  /** Bedrock model ID, e.g. 'anthropic.claude-3-5-sonnet-20241022-v2:0'. */
  modelId: string;
  /** Bedrock-side Anthropic version string. Defaults to '2023-06-01'. */
  anthropicVersion?: string;
  /** Sampling temperature 0..1. Default 0.2 (verifier-friendly). Overridden per-request by ChatRequest.temperature. */
  temperature?: number;
  /**
   * Optional streaming invoker. When provided, chatStream() is
   * available; without it chatStream() throws with a wiring hint.
   */
  streamInvoker?: BedrockStreamInvoker;
}

/** Map the raw Anthropic-on-Bedrock stop_reason to the canonical
 *  StopReason. Same vocabulary as the direct Anthropic API, so this is
 *  near-identity; anything unknown (incl. null/undefined) degrades to
 *  'end_turn'. */
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

/** Bedrock ChatModel for Anthropic Claude family. */
export class AnthropicOnBedrockChatModel implements ChatModel {
  private readonly modelId: string;
  private readonly anthropicVersion: string;
  private readonly temperature: number;
  private readonly streamInvoker: BedrockStreamInvoker | undefined;

  constructor(
    private readonly invoker: BedrockInvoker,
    opts: AnthropicOnBedrockOptions,
  ) {
    if (!opts.modelId) throw new Error('AnthropicOnBedrockChatModel: modelId required');
    this.modelId = opts.modelId;
    this.anthropicVersion = opts.anthropicVersion ?? '2023-06-01';
    const t = opts.temperature ?? 0.2;
    if (t < 0 || t > 1) throw new Error('temperature must be in [0,1]');
    this.temperature = t;
    this.streamInvoker = opts.streamInvoker;
  }

  private buildBody(req: ChatRequest): string {
    const body: Record<string, unknown> = {
      anthropic_version: this.anthropicVersion,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? this.temperature,
      system: req.system,
      messages: req.messages.map(toAnthropicMessage),
    };
    if (req.tools !== undefined && req.tools.length > 0) {
      body['tools'] = req.tools.map(toAnthropicTool);
    }
    return JSON.stringify(body);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (req.maxTokens <= 0) throw new Error('maxTokens must be > 0');

    const res = await this.invoker.invokeModel({
      modelId: this.modelId,
      body: this.buildBody(req),
      signal: req.signal,
    });

    return this.parseResponse(res.body);
  }

  /**
   * Streaming chat via InvokeModelWithResponseStream. Bedrock's
   * eventstream carries Anthropic-shaped events in each chunk's bytes
   * (message_start, content_block_delta, message_delta, message_stop).
   * Requires opts.streamInvoker; throws a wiring hint otherwise.
   *
   * The raw stop_reason arrives on message_delta; it is CAPTURED there
   * and emitted as EXACTLY ONE canonical message_stop chunk when the
   * terminal message_stop event arrives (previously the raw provider
   * string was yielded mid-stream at message_delta).
   */
  async *chatStream(req: ChatRequest): AsyncIterable<StreamChunk> {
    if (this.streamInvoker === undefined) {
      throw new Error(
        'AnthropicOnBedrockChatModel.chatStream: no streamInvoker wired. ' +
        'Pass opts.streamInvoker (InvokeModelWithResponseStream) to enable streaming.',
      );
    }
    if (req.maxTokens <= 0) throw new Error('maxTokens must be > 0');

    const decoder = new TextDecoder();
    let inputTokens = 0;
    let capturedStopReason: unknown;
    const iter = this.streamInvoker.invokeModelWithResponseStream({
      modelId: this.modelId,
      body: this.buildBody(req),
      signal: req.signal,
    });

    for await (const raw of iter) {
      if (req.signal.aborted) throw new Error('Bedrock stream aborted');
      const text = typeof raw === 'string' ? raw : decoder.decode(raw);
      let ev: unknown;
      try { ev = JSON.parse(text); } catch { continue; } // tolerate partial frames
      if (ev === null || typeof ev !== 'object') continue;
      const type = (ev as { type?: unknown }).type;

      if (type === 'message_start') {
        const usage = (ev as { message?: { usage?: { input_tokens?: unknown } } }).message?.usage;
        if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens;
      } else if (type === 'content_block_delta') {
        const delta = (ev as { delta?: { type?: unknown; text?: unknown } }).delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          yield { kind: 'text', text: delta.text };
        }
      } else if (type === 'message_delta') {
        const usage = (ev as { usage?: { output_tokens?: unknown } }).usage;
        if (typeof usage?.output_tokens === 'number') {
          yield { kind: 'usage', inputTokens, outputTokens: usage.output_tokens };
        }
        const stop = (ev as { delta?: { stop_reason?: unknown } }).delta?.stop_reason;
        if (stop !== undefined && stop !== null) capturedStopReason = stop;
      } else if (type === 'message_stop') {
        // Bedrock's final message_stop carries invocation metrics; the
        // stop_reason was captured on message_delta above.
        yield { kind: 'message_stop', stopReason: mapStopReason(capturedStopReason) };
        return;
      }
    }
  }

  /**
   * Parse the Bedrock Anthropic response envelope into the canonical
   * ChatResponse: content blocks from the Anthropic `content` array,
   * stopReason from top-level `stop_reason`, usage from
   * `usage.{input_tokens,output_tokens}` when present.
   */
  private parseResponse(body: string): ChatResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`Bedrock response was not valid JSON: ${(e as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('Bedrock response was not a JSON object');
    }
    const content = (parsed as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      throw new Error('Bedrock response.content must be an array');
    }
    const usage = parseUsage(parsed);
    return {
      content: parseContentBlocks(content),
      stopReason: mapStopReason((parsed as { stop_reason?: unknown }).stop_reason),
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}

export const VERSION = '0.0.0';
