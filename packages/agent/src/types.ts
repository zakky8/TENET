/**
 * @tenet/agent type contract (design gate: docs/design/agent-turn.md §3).
 *
 * This package is the composition root that DRIVES core's `AgentState` as a
 * `@tenet/workflow` graph: deterministic pre-handlers -> retrieve -> a
 * decides-and-drafts `Reasoner` -> fail-CLOSED verify -> critique-retry ->
 * emit | abstain | handoff. These types come first; the reasoner, nodes, and
 * orchestrator implement against them in later increments.
 *
 * North star encoded in the types: there is NO default `answer` in
 * `ReasonerOutput` — any ambiguity resolves to `abstain`. The worst outcome of
 * a turn is a human handoff, never an ungrounded fact.
 */
import type { AgentState, Citation, NormalizedReply, Outcome, Source } from '@tenet/core';
import type { Handoff } from '@tenet/harness';

/** A tool call the Reasoner requests. Provider-agnostic; the input is the
 *  validated arguments object. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** The result of ONE executed tool call, in the provider-agnostic shape the next
 *  reasoning pass consumes. `isError: true` marks a tool failure the model must react
 *  to — it is never silently dropped or turned into a fake success. */
export interface ToolResultBlock {
  readonly toolUseId: string;
  readonly content: string;
  readonly isError: boolean;
}

/** A retrieved chunk carries retrieval RELEVANCE (cosine / BM25 / rerank,
 *  normalized 0..1) — deliberately distinct from `Source.confidence`, which is a
 *  correctness prior. The knowledge-boundary gate keys on relevance. */
export interface RetrievedChunk {
  readonly source: Source;
  readonly relevance: number;
}

/** The terminal result of a turn: the member-facing reply plus the recorded
 *  outcome. Produced only at a terminal edge (emit / abstain / handoff). */
export type Result = {
  readonly reply: NormalizedReply;
  readonly outcome: Outcome;
  /** Diagnostic reason for a non-`resolved` terminal (abstain/handoff) — carried
   *  for telemetry/debugging so it is not dropped. Not shown to the member. */
  readonly reason?: string;
};

/** The orchestrator's working state. IS an `AgentState` (so retrieve/draft/verify
 *  stages read the same fields), extended with transient orchestration carriers
 *  plus an explicit terminal channel. When `halt` is set the graph
 *  short-circuits: downstream nodes pass through untouched and the finalizer
 *  converts it into the returned `Result`. */
export interface OrchestratorState extends AgentState {
  /** Retrieved context with relevance scores (set by the retrieve node). */
  readonly chunks?: ReadonlyArray<RetrievedChunk>;
  /** A cache-lookup candidate draft. NOT emitted directly — it re-enters
   *  verification, so a stale/poisoned cache entry cannot bypass the guarantee. */
  readonly cachedDraft?: string;
  /** Results of tool calls executed this turn, appended to history for the next
   *  reasoning pass. */
  readonly toolResults?: ReadonlyArray<ToolResultBlock>;
  /** Set when the graph is short-circuiting to a terminal outcome. */
  readonly halt?: Result;
}

/** ONE model turn returns exactly one of these, discriminated on `kind`. Action
 *  selection and drafting share ONE grounded turn, so `handoff`/`abstain` are
 *  first-class results, not emit-time afterthoughts. The union has no privileged
 *  variant; the fail-CLOSED rule (a parse failure, unknown action, missing field,
 *  refusal, or aborted turn maps to `abstain`, never a default `answer`) is
 *  enforced by the Reasoner IMPLEMENTATION — increment 2.2 — not by this type. */
export type ReasonerOutput =
  | { readonly kind: 'answer'; readonly draft: string; readonly citations: ReadonlyArray<Citation> }
  | { readonly kind: 'tool'; readonly calls: ReadonlyArray<ToolCall> }
  | { readonly kind: 'handoff'; readonly handoff: Handoff }
  | { readonly kind: 'abstain'; readonly reason: string };

/** The decides-and-drafts model call. `signal` is REQUIRED — inherited from the
 *  canonical `@tenet/core` ChatModel contract, so a cancelled turn releases the
 *  in-flight model call (no zombie HTTP). */
export interface Reasoner {
  reason(state: OrchestratorState, signal: AbortSignal): Promise<ReasonerOutput>;
}
