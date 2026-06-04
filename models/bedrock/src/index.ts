/**
 * AWS Bedrock ChatModel adapter for @tenet/verifier (and any future
 * caller that consumes the ChatModel interface).
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
 */

/** Minimal Bedrock invoker contract — wire to AWS SDK or your gateway. */
export interface BedrockInvoker {
  invokeModel(args: {
    modelId: string;
    body: string;
    signal?: AbortSignal;
  }): Promise<{ body: string }>;
}

/** Verifier-compatible ChatModel. Imported as type-only to avoid a hard dep. */
export interface ChatModel {
  chat(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface AnthropicOnBedrockOptions {
  /** Bedrock model ID, e.g. 'anthropic.claude-3-5-sonnet-20241022-v2:0'. */
  modelId: string;
  /** Bedrock-side Anthropic version string. Defaults to '2023-06-01'. */
  anthropicVersion?: string;
  /** Sampling temperature 0..1. Default 0.2 (verifier-friendly). */
  temperature?: number;
}

/** Bedrock ChatModel for Anthropic Claude family. */
export class AnthropicOnBedrockChatModel implements ChatModel {
  private readonly modelId: string;
  private readonly anthropicVersion: string;
  private readonly temperature: number;

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
  }

  async chat(args: {
    system: string;
    user: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<string> {
    if (args.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const body = JSON.stringify({
      anthropic_version: this.anthropicVersion,
      max_tokens: args.maxTokens,
      temperature: this.temperature,
      system: args.system,
      messages: [{ role: 'user', content: args.user }],
    });

    const res = await this.invoker.invokeModel({
      modelId: this.modelId,
      body,
      signal: args.signal,
    });

    return this.parseResponse(res.body);
  }

  /**
   * Extract assistant text from the Bedrock Anthropic response envelope.
   * Tolerant of slight schema variation (content array; text-only first
   * block is the common case).
   */
  private parseResponse(body: string): string {
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
    // Concatenate every text block; ignore non-text blocks (tool use etc.)
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
    return parts.join('');
  }
}

export const VERSION = '0.0.0';
