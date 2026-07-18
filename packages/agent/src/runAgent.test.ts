/**
 * End-to-end tests for the composition root (increment 2.1b-iv).
 *
 * runAgent drives the whole graph — injectionGate → retrieveNode → cacheNode →
 * criticLoop — with every port faked. These assert the turn as a WHOLE: the happy
 * path emits a grounded answer, each fail-closed edge short-circuits to the right
 * terminal, halting really skips downstream nodes, and the top-level catch turns an
 * uncaught throw into an abstain. Each test reddens if the wiring regresses.
 */
import type { Citation, Source } from '@tenet/core';
import type { Filter } from '@tenet/guardrails';
import { PolicyEvaluator } from '@tenet/governance';
import type { AgentDeps, AnswerCache, HistoryCompactor, Retriever, ScoredResult, Verifier, VerifierVerdict } from './deps.js';
import type { OrchestratorState, Reasoner } from './types.js';
import { runAgent } from './orchestrator.js';

const signal = new AbortController().signal;
const CITATION: Citation = { sourceId: 's1', quote: 'daily drawdown is 5%' };
const PASS: VerifierVerdict = { pass: true, critique: '', approvedCitations: [CITATION] };
const src = (id: string): Source => ({ id, uri: `kb://${id}`, text: `body of ${id}`, confidence: 0.9 });
const HITS: ScoredResult[] = [{ source: src('s1'), score: 0.8 }];

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

const ALLOW: Filter = { id: 'ok', inspect: () => ({ kind: 'allow' }) };
const BLOCK: Filter = { id: 'deny', inspect: () => ({ kind: 'block', reason: 'injection' }) };

const answerReasoner = (): Reasoner => ({
  async reason() {
    return { kind: 'answer', draft: 'The limit is 5%.', citations: [CITATION] };
  },
});
const explodingReasoner = (): Reasoner => ({
  async reason() {
    throw new Error('should not be reached');
  },
});

/** Full fake deps; override the piece under test. */
function makeDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  const retriever: Retriever = { async query() { return HITS; } };
  const cache: AnswerCache = { async lookup() { return null; } };
  const verify: Verifier = { async check() { return PASS; } };
  return {
    inboundFilters: [ALLOW],
    retriever,
    retrieveK: 5,
    boundary: {},
    cache,
    verify,
    outboundFilters: [ALLOW],
    reasoner: answerReasoner(),
    maxAttempts: 3,
    policy: new PolicyEvaluator([]),
    tools: { async execute() { return { content: '', isError: false }; } },
    rewrite: async ({ draft }) => draft,
    maxRepairRounds: 0,
    timeouts: { gate: 1000, retrieve: 1000, cache: 1000 },
    ...over,
  };
}

describe('runAgent — the composition root, end to end', () => {
  it('happy path: allow → retrieve → cache miss → reason → verify → EMIT (resolved)', async () => {
    const out = await runAgent(makeState(), makeDeps(), signal);
    expect(out.outcome).toBe('resolved');
    expect(out.reply.text).toBe('The limit is 5%.');
    expect(out.reply.citations).toEqual([CITATION]);
  });

  it('a blocked input hands off AND skips every downstream node (halting short-circuit)', async () => {
    let retrieverCalled = false;
    const retriever: Retriever = { async query() { retrieverCalled = true; return HITS; } };
    const out = await runAgent(makeState(), makeDeps({ inboundFilters: [BLOCK], retriever }), signal);
    expect(out.outcome).toBe('handed_off');
    expect(retrieverCalled).toBe(false); // retrieve/cache/critic never ran
  });

  it('thin retrieval abstains before ever reasoning', async () => {
    const empty: Retriever = { async query() { return []; } };
    const out = await runAgent(makeState(), makeDeps({ retriever: empty, reasoner: explodingReasoner() }), signal);
    expect(out.outcome).toBe('disqualified'); // boundary gate abstained; reasoner never reached
  });

  it('a verified cache hit resolves and never reasons (cache short-circuit)', async () => {
    const cache: AnswerCache = { async lookup() { return { answer: 'cached 5% answer' }; } };
    const out = await runAgent(makeState(), makeDeps({ cache, reasoner: explodingReasoner() }), signal);
    expect(out.outcome).toBe('resolved');
    expect(out.reply.text).toBe('cached 5% answer');
  });

  it('an UNCAUGHT node throw is converted to abstain by the top-level catch (fail-closed backstop)', async () => {
    // A negative minHits makes knowledgeBoundaryGate throw OUTSIDE retrieveNode's own
    // try/catch → it propagates to runAgent's top-level catch → abstain, never a crash.
    const out = await runAgent(makeState(), makeDeps({ boundary: { minHits: -1 } }), signal);
    expect(out.outcome).toBe('disqualified');
    expect(out.reason).toContain('orchestrator error');
  });
});

// ── Long-history compaction pre-step (2.4) ────────────────────────────────────
// The compaction node sits at injectionGate → retrieve → cache → COMPACT → critic.
// These prove it is really wired into the turn (not a dangling function) and that a
// compaction failure fails the WHOLE turn closed, before the model is ever called.

describe('runAgent — long-history compaction pre-step', () => {
  it('a configured compactor runs inside the turn on the full history, then the turn still EMITS', async () => {
    let sawHistoryLen: number | undefined;
    const compactor: HistoryCompactor = {
      async compact(messages) {
        sawHistoryLen = messages.length;
        return { messages: [{ role: 'system', content: '[summary]' }], compacted: true };
      },
    };
    const longHistory = Array.from({ length: 40 }, (_, i) => ({ role: 'user' as const, content: `turn ${i}` }));
    const out = await runAgent(makeState({ history: longHistory }), makeDeps({ compaction: compactor }), signal);
    expect(sawHistoryLen).toBe(40); // the pre-step actually ran, on the full pre-compaction history
    expect(out.outcome).toBe('resolved'); // and the turn still reached the single emit edge
  });

  it('a compaction error abstains the whole turn BEFORE reasoning (fail-closed end to end)', async () => {
    const boom: HistoryCompactor = {
      async compact() {
        throw new Error('summarizer unavailable');
      },
    };
    // explodingReasoner throws if reached — proving compaction failure short-circuits to abstain first.
    const out = await runAgent(makeState(), makeDeps({ compaction: boom, reasoner: explodingReasoner() }), signal);
    expect(out.outcome).toBe('disqualified'); // abstain — never reasoned, never emitted
    expect(out.reason).toContain('compaction error');
  });
});

// ── AbortSignal conformance (2.4) ─────────────────────────────────────────────
// The canonical @tenet/core contract makes AbortSignal REQUIRED so a cancelled turn
// releases the in-flight model call and never ships. These prove the turn honors it
// end to end. A reasoner that must NOT run is `explodingReasoner` (throws if called).

describe('runAgent — AbortSignal conformance', () => {
  it('a PRE-aborted signal → abstain, and no node ever runs (cancelled turn never ships)', async () => {
    const ac = new AbortController();
    ac.abort();
    let retrieverRan = false;
    const retriever: Retriever = { async query() { retrieverRan = true; return HITS; } };
    // explodingReasoner would throw 'should not be reached' if the graph reached it.
    const out = await runAgent(makeState(), makeDeps({ retriever, reasoner: explodingReasoner() }), ac.signal);
    expect(out.outcome).toBe('disqualified'); // abstain, never resolved
    expect(out.reason).toContain('aborted');
    expect(retrieverRan).toBe(false); // sequential short-circuits on the aborted signal before any node
  });

  it('threads the CALLER AbortSignal through to the reasoner (contract conformance)', async () => {
    let received: AbortSignal | undefined;
    const capturing: Reasoner = {
      async reason(_state, sig) {
        received = sig;
        return { kind: 'answer', draft: 'The limit is 5%.', citations: [CITATION] };
      },
    };
    const ac = new AbortController();
    const out = await runAgent(makeState(), makeDeps({ reasoner: capturing }), ac.signal);
    expect(out.outcome).toBe('resolved'); // sanity: happy path
    expect(received).toBe(ac.signal); // the SAME signal object reached the model turn
  });

  it('an abort DURING the turn stops it and abstains (in-flight cancellation, never ships)', async () => {
    const ac = new AbortController();
    const abortingReasoner: Reasoner = {
      async reason() {
        ac.abort(); // the caller cancels mid-turn
        return { kind: 'tool', calls: [{ id: 't1', name: 'kb.lookup', input: {} }] };
      },
    };
    const out = await runAgent(makeState(), makeDeps({ reasoner: abortingReasoner }), ac.signal);
    expect(out.outcome).toBe('disqualified'); // the next loop check sees the abort → abstain
    expect(out.reason).toContain('aborted');
  });
});
