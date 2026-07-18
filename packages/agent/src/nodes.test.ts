/**
 * Deterministic tests for the three pre-reasoning graph nodes (increment 2.1b-ii).
 *
 * Every node is driven with FAKE deps — no live model, no real retriever. The point
 * is the fail-closed edges: a blocked input hands off, thin evidence or a retrieval
 * error abstains, and — deliberately — a cache miss or cache error does NOT abstain.
 * Each test is written to FAIL if its node stopped failing closed (or started failing
 * closed where it must not).
 */
import type { ConversationMessage, Source } from '@tenet/core';
import type { StepContext } from '@tenet/workflow';
import type { Filter } from '@tenet/guardrails';
import type { AgentDeps, Retriever, AnswerCache, HistoryCompactor, ScoredResult } from './deps.js';
import type { OrchestratorState } from './types.js';
import { cacheNode, compactNode, injectionGate, retrieveNode } from './nodes.js';

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    event: {
      surface: 'test',
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      userId: 'user-1',
      text: 'What is the daily drawdown limit?',
      receivedAt: 0,
    },
    history: [{ role: 'user', content: 'What is the daily drawdown limit?' }],
    intent: 'question',
    sources: [],
    attempts: 0,
    ...overrides,
  };
}

const ctx: StepContext = { signal: new AbortController().signal, runId: 'run-1', stepId: 'step-1' };

const src = (id: string, confidence = 0.9): Source => ({
  id,
  uri: `kb://${id}`,
  text: `body of ${id}`,
  confidence,
});

const fixedRetriever = (results: ReadonlyArray<ScoredResult>): Retriever => ({
  async query() {
    return results;
  },
});
const throwingRetriever = (message: string): Retriever => ({
  async query() {
    throw new Error(message);
  },
});
const fixedCache = (answer: string | null): AnswerCache => ({
  async lookup() {
    return answer === null ? null : { answer };
  },
});
const throwingCache = (): AnswerCache => ({
  async lookup() {
    throw new Error('cache backend down');
  },
});

function makeDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    inboundFilters: [],
    retriever: fixedRetriever([]),
    retrieveK: 5,
    boundary: {},
    cache: fixedCache(null),
    ...over,
  };
}

const ALLOW: Filter = { id: 'ok', inspect: () => ({ kind: 'allow' }) };
const BLOCK: Filter = { id: 'deny', inspect: () => ({ kind: 'block', reason: 'looks like injection' }) };
const THROW: Filter = {
  id: 'boom',
  inspect: () => {
    throw new Error('regex exploded');
  },
};

// ── (A) injectionGate ───────────────────────────────────────────────────────

describe('injectionGate — inbound guardrail, FAIL CLOSED to handoff', () => {
  it('a blocking filter halts to a security handoff carrying the filter id + reason', async () => {
    const out = await injectionGate(makeDeps({ inboundFilters: [ALLOW, BLOCK] }))(makeState(), ctx);
    expect(out.halt).toBeDefined();
    expect(out.halt?.outcome).toBe('handed_off');
    expect(out.halt?.reason).toContain('deny');
    expect(out.halt?.reason).toContain('looks like injection');
  });

  it('an allowing chain passes the state through untouched (no halt)', async () => {
    const state = makeState();
    const out = await injectionGate(makeDeps({ inboundFilters: [ALLOW] }))(state, ctx);
    expect(out).toBe(state); // same object, no halt attached
  });

  it('an empty filter chain is treated as allow (passes through)', async () => {
    const state = makeState();
    expect(await injectionGate(makeDeps({ inboundFilters: [] }))(state, ctx)).toBe(state);
  });

  it('a filter that THROWS → security handoff (a guardrail we cannot run must not pass input through)', async () => {
    const out = await injectionGate(makeDeps({ inboundFilters: [THROW] }))(makeState(), ctx);
    expect(out.halt?.outcome).toBe('handed_off');
    expect(out.halt?.reason).toContain('filter error');
    expect(out.halt?.reason).toContain('regex exploded');
  });
});

// ── (B) retrieveNode ────────────────────────────────────────────────────────

describe('retrieveNode — retrieve + knowledge-boundary, FAIL CLOSED to abstain', () => {
  it('sufficient evidence proceeds and sets chunks (no halt)', async () => {
    const results = [
      { source: src('s1'), score: 0.8 },
      { source: src('s2'), score: 0.5 },
    ];
    const out = await retrieveNode(makeDeps({ retriever: fixedRetriever(results) }))(makeState(), ctx);
    expect(out.halt).toBeUndefined();
    expect(out.chunks).toHaveLength(2);
    expect(out.chunks?.[0]?.relevance).toBe(0.8);
  });

  it('maps RELEVANCE from the retriever score, NOT from Source.confidence (review §8)', async () => {
    // confidence is high (0.9) but the retrieval score is low (0.2): the chunk must
    // carry 0.2, so the boundary gate keys on relevance, not a correctness prior.
    const results = [{ source: src('s1', 0.9), score: 0.2 }];
    const out = await retrieveNode(makeDeps({ retriever: fixedRetriever(results) }))(makeState(), ctx);
    expect(out.chunks?.[0]?.relevance).toBe(0.2);
    expect(out.chunks?.[0]?.source.confidence).toBe(0.9); // confidence preserved, but distinct
  });

  it('too few hits → abstain (fail closed), never drafts blind', async () => {
    const out = await retrieveNode(makeDeps({ retriever: fixedRetriever([]) }))(makeState(), ctx);
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toContain('need 1');
    expect(out.chunks).toBeUndefined();
  });

  it('hits below the top-score floor → abstain (fail closed)', async () => {
    const deps = makeDeps({
      retriever: fixedRetriever([{ source: src('s1'), score: 1 }]),
      boundary: { minTopScore: 10 },
    });
    const out = await retrieveNode(deps)(makeState(), ctx);
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toContain('below 10');
  });

  it('a retriever error → abstain (fail closed on infra failure), never drafts blind', async () => {
    const out = await retrieveNode(makeDeps({ retriever: throwingRetriever('index unreachable') }))(
      makeState(),
      ctx,
    );
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toContain('retrieval error');
    expect(out.halt?.reason).toContain('index unreachable');
  });

  it('a retriever that resolves null (contract violation) → abstain, not a crash', async () => {
    // A lying retriever resolves null instead of an array; treated as zero evidence.
    const nullRetriever: Retriever = { async query() { return null as unknown as ScoredResult[]; } };
    const out = await retrieveNode(makeDeps({ retriever: nullRetriever }))(makeState(), ctx);
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.chunks).toBeUndefined();
  });
});

// ── (C) cacheNode ───────────────────────────────────────────────────────────

describe('cacheNode — candidate draft only, does NOT fail closed', () => {
  it('a hit sets cachedDraft (a candidate, not an emit) and never halts', async () => {
    const out = await cacheNode(makeDeps({ cache: fixedCache('cached answer') }))(makeState(), ctx);
    expect(out.cachedDraft).toBe('cached answer');
    expect(out.halt).toBeUndefined();
  });

  it('a miss passes through with no cachedDraft', async () => {
    const state = makeState();
    const out = await cacheNode(makeDeps({ cache: fixedCache(null) }))(state, ctx);
    expect(out).toBe(state);
    expect(out.cachedDraft).toBeUndefined();
  });

  it('a lookup error is swallowed — continue to reasoning, do NOT abstain', async () => {
    const out = await cacheNode(makeDeps({ cache: throwingCache() }))(makeState(), ctx);
    expect(out.halt).toBeUndefined(); // the cache is an optimization; its failure must not abstain
    expect(out.cachedDraft).toBeUndefined();
  });
});

// ── (D) compactNode ───────────────────────────────────────────────────────────

const HISTORY: ReadonlyArray<ConversationMessage> = [
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'q2' },
];
const fixedCompactor = (out: ReadonlyArray<ConversationMessage>): HistoryCompactor => ({
  async compact() {
    return { messages: out, compacted: true };
  },
});
const throwingCompactor = (message: string): HistoryCompactor => ({
  async compact() {
    throw new Error(message);
  },
});

describe('compactNode — OPT-IN long-history compaction, FAIL CLOSED on error', () => {
  it('no compactor configured → passes the state through untouched (opt-in no-op)', async () => {
    const state = makeState({ history: HISTORY });
    const out = await compactNode(makeDeps())(state, ctx);
    expect(out).toBe(state); // same object; history not touched, no summarizer call
    expect(out.halt).toBeUndefined();
  });

  it('a configured compactor replaces history with the compacted messages (no halt)', async () => {
    const compacted: ReadonlyArray<ConversationMessage> = [
      { role: 'system', content: '[conversation summary] q1/a1' },
      { role: 'user', content: 'q2' },
    ];
    const out = await compactNode(makeDeps({ compaction: fixedCompactor(compacted) }))(
      makeState({ history: HISTORY }),
      ctx,
    );
    expect(out.halt).toBeUndefined();
    expect(out.history).toEqual(compacted); // the reasoner will now read the shortened history
    expect(out.history).toHaveLength(2);
  });

  it('a compactor error → abstain (FAIL CLOSED): a silently truncated prompt is never sent', async () => {
    const out = await compactNode(makeDeps({ compaction: throwingCompactor('summarizer 500') }))(
      makeState({ history: HISTORY }),
      ctx,
    );
    expect(out.halt?.outcome).toBe('disqualified'); // abstain, never proceed to reason on an over-budget prompt
    expect(out.halt?.reason).toContain('compaction error');
    expect(out.halt?.reason).toContain('summarizer 500');
  });

  it('threads the turn AbortSignal through to the compactor (contract conformance)', async () => {
    let received: AbortSignal | undefined;
    const capturing: HistoryCompactor = {
      async compact(messages, sig) {
        received = sig;
        return { messages, compacted: false };
      },
    };
    await compactNode(makeDeps({ compaction: capturing }))(makeState({ history: HISTORY }), ctx);
    expect(received).toBe(ctx.signal); // the SAME signal object reached the compactor (cancellable)
  });
});
