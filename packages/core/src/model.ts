// packages/core/src/model.ts
import type { Role } from './types.js';   // Role = 'user'|'assistant'|'system'|'tool' (existing)

/** A tool the model may call. Provider-agnostic; JSON-Schema described. */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema (draft 2020-12) for the arguments object. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** One content block of a turn. Discriminated on `type`. Single vocabulary
 *  shared by non-streaming content and (via StreamChunk) the streaming path. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string;
      readonly input: Readonly<Record<string, unknown>> }
  | { readonly type: 'tool_result'; readonly toolUseId: string;
      readonly content: string; readonly isError?: boolean };

/** THE canonical WIRE message sent to a model. An ARRAY of blocks — this kills the
 *  `${role}: ${content}` flattening in community-bot:115 (the `assistant:` turn-spoof)
 *  AND the array/string schism vs harness HarnessMessage. Turn boundaries are structural.
 *
 *  NAMED `ModelMessage`, NOT `ConversationMessage`: `core/types.ts:53` already defines a
 *  `ConversationMessage` with `content: string` — the STORED/history message that
 *  `AgentState.history` and `@tenet/memory` persist. Those are two genuinely distinct
 *  concepts (the design's own reasoner maps one to the other:
 *  `history.map((m) => textMessage(m.role, m.content))`), so they keep distinct names.
 *  This resolves the TS2308 barrel collision found by executing tsc at increment 1.1. */
export interface ModelMessage {
  readonly role: Role;
  readonly content: ReadonlyArray<ContentBlock>;
}

/** Lossless with every adapter's provider stop reasons. `end_turn` and
 *  `stop_sequence` are DISTINCT (Anthropic emits both) — no collapse to 'stop'. */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'refusal'
  | 'aborted';

export interface ChatRequest {
  /** System prompt is a first-class field (matches every legacy contract's own
   *  `system` field), never smuggled into messages. */
  readonly system: string;
  readonly messages: ReadonlyArray<ModelMessage>;
  readonly maxTokens: number;
  /** Tools offered THIS turn. Omit or [] disables tool use. */
  readonly tools?: ReadonlyArray<ToolDef>;
  /** REQUIRED — its PRESENCE is enforced by the type system, not JSDoc (this is
   *  what supersedes the optional `signal?` at verifier/types.ts:96-99). Presence
   *  is not the same as abortability: adapters must actually FORWARD and honor it. */
  readonly signal: AbortSignal;
  readonly temperature?: number;
}

export interface ChatResponse {
  /** text + any tool_use requests, together — answers "no contract returns
   *  {action,draft} together". */
  readonly content: ReadonlyArray<ContentBlock>;
  readonly stopReason: StopReason;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

/** THE contract. Every package imports this one. */
export interface ChatModel {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/** StreamChunk moved here from streaming/index.ts so streaming and
 *  non-streaming share the block vocabulary. */
export type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use_start'; id: string; name: string }
  | { kind: 'tool_use_delta'; id: string; partial: string }
  | { kind: 'tool_use_end'; id: string }
  | { kind: 'message_stop'; stopReason: StopReason }
  | { kind: 'usage'; inputTokens: number; outputTokens: number };

/** Streaming is an OPTIONAL capability over the SAME request shape. */
export interface StreamingChatModel extends ChatModel {
  chatStream(req: ChatRequest): AsyncIterable<StreamChunk>;
}

// ── Helpers ──────────────────────────────────────────────────────────────
export function textMessage(role: Role, text: string): ModelMessage {
  return { role, content: [{ type: 'text', text }] };
}

export function responseText(res: ChatResponse): string {
  return res.content.reduce((s, b) => (b.type === 'text' ? s + b.text : s), '');
}

export function toolUses(
  res: ChatResponse,
): ReadonlyArray<Extract<ContentBlock, { type: 'tool_use' }>> {
  return res.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );
}
