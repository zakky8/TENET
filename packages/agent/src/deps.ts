/**
 * The agent turn's dependency-injection surface (design gate §4).
 *
 * `AgentDeps` is the single object the orchestrator threads to every node, so the
 * pipeline is pure-composition and fully fake-able in tests. The turn depends on
 * NARROW PORTS declared here — `Retriever`, `AnswerCache` — not on the concrete
 * retrieval/router classes. A real retriever's `ScoredSource` and the router's
 * embedding-based cache satisfy these structurally (or via a thin adapter), which is
 * what keeps the guarantee-critical orchestrator decoupled from wiring detail.
 *
 * This interface GROWS per increment. 2.1b-ii wires the fields the three
 * pre-reasoning nodes consume (filters, retriever, boundary, cache); the reasoning
 * loop's fields (reasoner, policy, tools, maxAttempts, timeouts) are added with
 * `criticLoop`/`runAgent` in 2.1b-iii/iv.
 */
import type { Citation, ConversationMessage, Source } from '@tenet/core';
import type { Filter } from '@tenet/guardrails';
import type { PolicyEvaluator } from '@tenet/governance';
import type { BoundaryGateOptions } from '@tenet/refine';
import type { Reasoner, ToolCall } from './types.js';

/** A scored retrieval result. Structurally identical to `@tenet/retrieval`'s
 *  `ScoredSource`, redeclared here so the agent depends on the PORT, not a concrete
 *  retriever package. `score` is producer-specific (BM25 / cosine / rerank). */
export interface ScoredResult {
  readonly source: Source;
  readonly score: number;
}

/** Narrow retrieval port. Any concrete retriever (hybrid pipeline, lexical scorer,
 *  vector-store adapter) satisfies it structurally. */
export interface Retriever {
  query(args: {
    text: string;
    k: number;
    tenantId?: string;
    signal?: AbortSignal;
  }): Promise<ReadonlyArray<ScoredResult>>;
}

/** Narrow answer-cache port. A lookup hit is a CANDIDATE draft only — the
 *  orchestrator re-verifies it before emit, so the concrete cache's own grounding is
 *  irrelevant to the guarantee. The embedding-based `SemanticAnswerCache` is wrapped
 *  behind this port at composition (it needs a query embedding; the port does not). */
export interface AnswerCache {
  lookup(text: string, signal?: AbortSignal): Promise<{ readonly answer: string } | null>;
}

/** Input to the verification port. `sources` is the KNOWLEDGE string the model was
 *  shown (the deterministic tier greps it for verbatim grounding); `sourceRecords`
 *  back the approved citations. */
export interface VerifierInput {
  readonly sources: string;
  readonly sourceRecords: ReadonlyArray<Source>;
  readonly draft: string;
}

/** The verifier's verdict. `approvedCitations` are the ONLY citations allowed to
 *  emit — an empty list means nothing was grounded, so the draft must NOT ship.
 *  Structurally satisfied by `@tenet/verifier`'s `VerifyResult` (adapted with a model
 *  + deterministic pre-checks at composition). */
export interface VerifierVerdict {
  readonly pass: boolean;
  readonly critique: string;
  readonly approvedCitations: ReadonlyArray<Citation>;
}

/** Narrow verification port — the fail-closed grounding check that stands in front of
 *  every emit. The concrete atomic-claim multi-judge verifier lives behind it. */
export interface Verifier {
  check(input: VerifierInput): Promise<VerifierVerdict>;
}

/** Narrow tool-execution port. A single ToolCall runs here and yields its result;
 *  a concrete MCP/registry executor is wrapped behind it at composition. Governance
 *  runs BEFORE this (see runTools) — the executor only ever sees allowed calls. */
export interface ToolExecutor {
  execute(
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<{ readonly content: string; readonly isError: boolean }>;
}

/** Rewrite a draft to address a verifier critique — a model call. Structurally matches
 *  `@tenet/refine`'s `RewriteFn`, declared locally so the agent owns its DI surface (a
 *  refine rewriter satisfies it directly). The rewritten draft is NOT trusted — it
 *  re-enters the same fail-closed emit edge, so a bad rewrite cannot ship. */
export interface RewriteFn {
  (args: { readonly draft: string; readonly critique: string; readonly signal?: AbortSignal }): Promise<string>;
}

/** Narrow history-compaction port — the long-horizon layer that keeps a growing
 *  conversation inside the model's context window. Given the turn's message history it
 *  returns a (possibly summarized) history plus whether it folded anything. A concrete
 *  `ContextCompactor` (`@tenet/harness`, with an injected model summarizer) satisfies
 *  this structurally at composition — the agent depends on the PORT, not the class, so
 *  the turn stays fully fake-testable. The returned history is NOT trusted to be
 *  grounded — it still flows through the same fail-closed verify/emit edge; compaction
 *  only bounds the prompt, it never adds facts. */
export interface HistoryCompactor {
  compact(
    messages: ReadonlyArray<ConversationMessage>,
    signal?: AbortSignal,
  ): Promise<{ readonly messages: ReadonlyArray<ConversationMessage>; readonly compacted: boolean }>;
}

/** Everything the orchestrator injects into the turn's nodes. */
export interface AgentDeps {
  /** Inbound filter chain (guardrails). An empty chain means no inbound blocking. */
  readonly inboundFilters: ReadonlyArray<Filter>;
  /** Retrieval port used by the retrieve node. */
  readonly retriever: Retriever;
  /** Top-K requested from the retriever. */
  readonly retrieveK: number;
  /** Knowledge-boundary thresholds (refine). Empty object = defaults (minHits 1). */
  readonly boundary: BoundaryGateOptions;
  /** Answer-cache port. A hit is a candidate draft, never emitted directly. */
  readonly cache: AnswerCache;
  /** Verification port — the fail-closed grounding check before the single emit edge. */
  readonly verify: Verifier;
  /** Outbound leak-filter chain (guardrails). Includes `systemPromptLeakFilter()`.
   *  An empty chain means no outbound gating (not recommended in production). */
  readonly outboundFilters: ReadonlyArray<Filter>;
  /** The decides-and-drafts model turn. */
  readonly reasoner: Reasoner;
  /** Max reason/tool turns before the loop fails closed (endless tool calls abstain once
   *  this is hit). */
  readonly maxAttempts: number;
  /** Rewrite a draft that failed verification, given the verifier's critique. The result
   *  re-enters the emit edge, so it is never trusted blindly. */
  readonly rewrite: RewriteFn;
  /** How many times a failed draft may be rewritten-and-re-verified before the turn fails
   *  closed to abstain. 0 = no repair (a verify failure abstains immediately). */
  readonly maxRepairRounds: number;
  /** Governance policy gating every tool call before execution. */
  readonly policy: PolicyEvaluator;
  /** Tool-execution port (only ever handed policy-allowed calls). */
  readonly tools: ToolExecutor;
  /** OPT-IN long-history compaction. When set, a conversation history that overflows
   *  the model's window is summarized to fit BEFORE the reasoner drafts. A compaction
   *  error FAILS CLOSED to abstain — the turn never silently sends a truncated prompt
   *  (which would drop context and risk an ungrounded answer). Absent = history verbatim. */
  readonly compaction?: HistoryCompactor;
  /** Per-node wall-clock budgets (ms) for the deterministic pre-reasoning nodes. A
   *  node that exceeds its budget aborts and the turn fails closed (top-level → abstain).
   *  criticLoop is NOT timed here — it self-bounds via maxAttempts + per-turn abort checks. */
  readonly timeouts: {
    readonly gate: number;
    readonly retrieve: number;
    readonly cache: number;
    /** Wall-clock budget (ms) for the optional compaction pre-step. Only consulted when
     *  `compaction` is configured; defaults to the retrieve budget when unset. */
    readonly compact?: number;
  };
}
