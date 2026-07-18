/**
 * The three pre-reasoning graph nodes (design gate §4.2), each a
 * `Step<OrchestratorState, OrchestratorState>`.
 *
 * Every node FAILS CLOSED on the paths that threaten the grounding guarantee: a
 * blocked input hands off to a human; thin evidence or a retrieval error abstains.
 * The lone exception is the cache node — a cache miss or lookup error simply
 * continues to reasoning, because the cache is an optimization whose absence never
 * risks an ungrounded answer (and a hit is only ever a candidate, re-verified later).
 *
 * Nodes do NOT check `state.halt` themselves — the orchestrator wraps each in
 * `halting()` so a terminal set upstream skips the rest of the graph (2.1b-i).
 */
import type { Step } from '@tenet/workflow';
import { runFilterChain } from '@tenet/guardrails';
import { knowledgeBoundaryGate } from '@tenet/refine';
import type { AgentDeps, ScoredResult } from './deps.js';
import type { OrchestratorState, RetrievedChunk } from './types.js';
import { abstainResult, handoffResult } from './terminals.js';

/** (A) Inbound guardrail gate. A blocking filter → FAIL CLOSED to a security handoff;
 *  the untrusted text never reaches retrieval or the model. */
export function injectionGate(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s) => {
    let chain: ReturnType<typeof runFilterChain>;
    try {
      chain = runFilterChain(s.event.text, deps.inboundFilters);
    } catch (err) {
      // A guardrail that throws cannot clear the input — hand to a human, never pass
      // an un-vetted input through to retrieval/the model.
      return { ...s, halt: handoffResult('security', `filter error: ${(err as Error).message}`) };
    }
    if (chain.verdict.kind === 'block') {
      return {
        ...s,
        halt: handoffResult('security', `blocked by ${chain.filterId}: ${chain.verdict.reason}`),
      };
    }
    return s;
  };
}

/** (B) Retrieve + knowledge-boundary gate. Thin evidence (gate rejects) OR a retriever
 *  error → FAIL CLOSED to abstain; the turn never drafts without sufficient sources.
 *  Feeds retrieval RELEVANCE (the producer score) into the gate, not `Source.confidence`. */
export function retrieveNode(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => {
    let scored: ReadonlyArray<ScoredResult>;
    try {
      scored = await deps.retriever.query({
        text: s.event.text,
        k: deps.retrieveK,
        tenantId: s.event.tenantId,
        signal: ctx.signal,
      });
    } catch (err) {
      // Retrieval failure = no evidence = cannot ground. Abstain, never draft blind.
      return { ...s, halt: abstainResult(`retrieval error: ${(err as Error).message}`) };
    }
    // Defense: a retriever that violates its contract and resolves null/undefined is
    // treated as zero evidence, so the boundary gate below abstains — never drafts blind.
    const results = scored ?? [];
    const gate = knowledgeBoundaryGate(
      results.map((c) => ({ score: c.score })),
      deps.boundary,
    );
    if (!gate.proceed) return { ...s, halt: abstainResult(gate.reason) };
    const chunks: ReadonlyArray<RetrievedChunk> = results.map((c) => ({
      source: c.source,
      relevance: c.score,
    }));
    return { ...s, chunks };
  };
}

/** (C) Cache lookup. A hit becomes a CANDIDATE draft (re-verified in the critic loop,
 *  never emitted from here). A miss OR a lookup error just continues to reasoning —
 *  the cache is an optimization; its absence must not abstain the turn. */
export function cacheNode(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => {
    const hit = await deps.cache.lookup(s.event.text, ctx.signal).catch(() => null);
    return hit ? { ...s, cachedDraft: hit.answer } : s;
  };
}

/** (D) Optional long-history compaction. When a compactor is injected AND the history
 *  overflows the model's window, it is summarized to fit BEFORE the reasoner reads it —
 *  so a long conversation cannot silently overflow the prompt and drop the grounding
 *  context. This runs behind `halting`, AFTER the fail-closed pre-nodes, so it is
 *  skipped entirely on a blocked/thin-retrieval turn and only pays the summarizer cost
 *  when the turn will actually reason. A compaction error FAILS CLOSED to abstain — a
 *  truncated prompt is never sent. No compactor configured → pass through untouched
 *  (opt-in; existing callers are unchanged). The compacted history is not trusted to be
 *  grounded; it still flows through the same verify/emit edge. */
export function compactNode(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => {
    if (deps.compaction === undefined) return s;
    try {
      const { messages } = await deps.compaction.compact(s.history, ctx.signal);
      return { ...s, history: messages };
    } catch (err) {
      // Cannot bound the prompt → cannot safely reason on it. Abstain, never send a
      // silently truncated context that could drop the grounding sources.
      return { ...s, halt: abstainResult(`compaction error: ${(err as Error).message}`) };
    }
  };
}
