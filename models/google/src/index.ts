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
 * Increment 1.2b-ii: implements the canonical @tenet/core ChatModel
 * (block-structured ChatRequest → ChatResponse) instead of the old
 * local single-string interface, and maps Gemini's `finishReason`
 * onto the canonical StopReason in both the non-streaming and
 * streaming paths (the streaming path previously leaked the raw
 * provider string, e.g. 'MAX_TOKENS', mid-stream).
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
} from '@tenet/core';

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

export interface GoogleChatModelOptions {
  apiKey: string;
  /** e.g. 'gemini-2.5-pro', 'gemini-2.5-flash'. */
  model: string;
  /** Default 0.2. Gemini accepts [0,2]. Overridden per-request by ChatRequest.temperature. */
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

/** Map Gemini's raw finishReason onto the canonical StopReason.
 *  Unknown / absent values degrade to 'end_turn'. Every reason that means the model
 *  was BLOCKED/REFUSED maps to 'refusal' — reporting a content-blocked generation as a
 *  clean 'end_turn' would mask a refusal (same failure class as truncation-masking), and
 *  the canonical StopReason is documented lossless. */
function mapFinishReason(raw: unknown): StopReason {
  switch (raw) {
    case 'STOP': return 'end_turn';
    case 'MAX_TOKENS': return 'max_tokens';
    case 'SAFETY': return 'refusal';
    case 'RECITATION': return 'refusal';
    case 'PROHIBITED_CONTENT': return 'refusal';
    case 'BLOCKLIST': return 'refusal';
    case 'SPII': return 'refusal';
    case 'IMAGE_SAFETY': return 'refusal';
    default: return 'end_turn';
  }
}

/** Canonical messages → Gemini `contents`. Gemini's role vocabulary is
 *  'user' | 'model'; assistant maps to 'model', everything else to
 *  'user'. Text blocks are joined; tool blocks are skipped (this
 *  adapter does not offer tools on the Gemini wire yet). */
function toGoogleContents(
  messages: ReadonlyArray<ModelMessage>,
): Array<{ role: string; parts: Array<{ text: string }> }> {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{
      text: m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
    }],
  }));
}

function parseUsage(
  parsed: object,
): { inputTokens: number; outputTokens: number } | undefined {
  const usage = (parsed as { usageMetadata?: unknown }).usageMetadata;
  if (usage === null || usage === undefined || typeof usage !== 'object') return undefined;
  const inT = (usage as { promptTokenCount?: unknown }).promptTokenCount;
  const outT = (usage as { candidatesTokenCount?: unknown }).candidatesTokenCount;
  if (typeof inT !== 'number' || typeof outT !== 'number') return undefined;
  return { inputTokens: inT, outputTokens: outT };
}

export class GoogleChatModel implements ChatModel {
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

  private buildBody(req: ChatRequest): string {
    const body: Record<string, unknown> = {
      contents: toGoogleContents(req.messages),
      generationConfig: {
        temperature: req.temperature ?? this.temperature,
        maxOutputTokens: req.maxTokens,
      },
    };
    if (req.system.length > 0) {
      body['systemInstruction'] = { parts: [{ text: req.system }] };
    }
    return JSON.stringify(body);
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (req.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const res = await this.http.fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(req),
      signal: req.signal,
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new GoogleApiError(res.status, text);
    return this.parseChat(text);
  }

  private parseChat(body: string): ChatResponse {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch (e) { throw new Error(`Google response not JSON: ${(e as Error).message}`); }
    if (!parsed || typeof parsed !== 'object') throw new Error('Google response not object');
    const usage = parseUsage(parsed);
    const candidates = (parsed as { candidates?: unknown }).candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return { content: [], stopReason: 'end_turn', ...(usage !== undefined ? { usage } : {}) };
    }
    const first = candidates[0] as { content?: { parts?: unknown }; finishReason?: unknown };
    const parts = first.content?.parts;
    const out: string[] = [];
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (p && typeof p === 'object') {
          const t = (p as { text?: unknown }).text;
          if (typeof t === 'string') out.push(t);
        }
      }
    }
    const joined = out.join('');
    const content: ContentBlock[] = joined.length > 0 ? [{ type: 'text', text: joined }] : [];
    return {
      content,
      stopReason: mapFinishReason(first.finishReason),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  /**
   * SSE-streamed generateContent. Emits the canonical @tenet/core
   * StreamChunk shapes. The raw `finishReason` is CAPTURED when it
   * arrives on a candidate (skipping FINISH_REASON_UNSPECIFIED) and
   * mapped onto the canonical StopReason for the single `message_stop`
   * chunk emitted at stream end (previously the raw provider string
   * leaked out mid-stream).
   */
  async *chatStream(req: ChatRequest): AsyncIterable<StreamChunk> {
    if (req.maxTokens <= 0) throw new Error('maxTokens must be > 0');
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    const res = await this.http.fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: this.buildBody(req),
      signal: req.signal,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new GoogleApiError(res.status, await res.text());
    }
    if (!res.body) throw new Error('Google streaming response missing body');

    let capturedFinish: unknown;

    for await (const ev of parseSseStream(res.body, req.signal)) {
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
            capturedFinish = finish;
          }
        }
      }
      if (usage) {
        const inT = typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0;
        const outT = typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;
        if (inT > 0 || outT > 0) yield { kind: 'usage', inputTokens: inT, outputTokens: outT };
      }
    }
    yield { kind: 'message_stop', stopReason: mapFinishReason(capturedFinish) };
  }
}

export const VERSION = '0.0.0';
