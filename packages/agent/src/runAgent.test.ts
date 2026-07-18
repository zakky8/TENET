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
import type { AgentDeps, AnswerCache, Retriever, ScoredResult, Verifier, VerifierVerdict } from './deps.js';
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
