/**
 * Deterministic tests for the single emit edge (increment 2.1b-iii-a).
 *
 * verifyAndEmit is THE only place a fact can reach a member, so every branch is a
 * fail-closed edge. The verifier is faked via the narrow port so the ORCHESTRATION is
 * tested directly (no brittle fake-model gymnastics). Each test is written to FAIL if
 * its branch stopped failing closed — most importantly the uncited-pass guard, which
 * would otherwise ship an answer with zero citations.
 */
import type { Citation, Source } from '@tenet/core';
import type { Filter } from '@tenet/guardrails';
import type { AgentDeps, Verifier, VerifierVerdict } from './deps.js';
import type { OrchestratorState, RetrievedChunk } from './types.js';
import { knowledgeBlock, verifyAndEmit } from './emit.js';

const src = (id: string): Source => ({ id, uri: `kb://${id}`, text: `body of ${id}`, confidence: 0.9 });
const chunk = (id: string, relevance = 0.8): RetrievedChunk => ({ source: src(id), relevance });
const CITATION: Citation = { sourceId: 's1', quote: 'daily drawdown is 5%' };

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
    chunks: [chunk('s1')],
    ...overrides,
  };
}

const fixedVerifier = (v: VerifierVerdict): Verifier => ({
  async check() {
    return v;
  },
});
const throwingVerifier = (msg: string): Verifier => ({
  async check() {
    throw new Error(msg);
  },
});

const ALLOW_OUT: Filter = { id: 'ok', inspect: () => ({ kind: 'allow' }) };
const LEAK_BLOCK: Filter = {
  id: 'leak',
  inspect: () => ({ kind: 'block', reason: 'system prompt leaked' }),
};

function makeDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  // Only the fields verifyAndEmit reads need to be real; the rest are unused here.
  return {
    inboundFilters: [],
    retriever: { async query() { return []; } },
    retrieveK: 5,
    boundary: {},
    cache: { async lookup() { return null; } },
    verify: fixedVerifier({ pass: true, critique: '', approvedCitations: [CITATION] }),
    outboundFilters: [ALLOW_OUT],
    ...over,
  };
}

// ── the emit path ─────────────────────────────────────────────────────────────

describe('verifyAndEmit — the single emit edge', () => {
  it('pass + ≥1 approved citation + leak-clean → EMIT (resolved) carrying the approved citations', async () => {
    const out = await verifyAndEmit('The limit is 5%.', makeState(), makeDeps());
    expect(out.kind).toBe('emit');
    if (out.kind !== 'emit') throw new Error('unreachable');
    expect(out.result.outcome).toBe('resolved');
    expect(out.result.reply.text).toBe('The limit is 5%.');
    expect(out.result.reply.citations).toEqual([CITATION]);
  });

  it('pass but ZERO approved citations → ABSTAIN (an uncited answer must never ship)', async () => {
    const deps = makeDeps({ verify: fixedVerifier({ pass: true, critique: '', approvedCitations: [] }) });
    const out = await verifyAndEmit('The limit is 5%.', makeState(), deps);
    expect(out.kind).toBe('abstain');
    if (out.kind !== 'abstain') throw new Error('unreachable');
    expect(out.reason).toContain('no grounded citation');
  });

  it('pass with only a BLANK citation (whitespace sourceId/quote) → ABSTAIN, never emit', async () => {
    // A misbehaving custom sourcePicker could approve an empty-quote citation; the
    // length-only check would have let it through, so the guard requires non-blank.
    const blank: Citation = { sourceId: '  ', quote: '   ' };
    const deps = makeDeps({ verify: fixedVerifier({ pass: true, critique: '', approvedCitations: [blank] }) });
    const out = await verifyAndEmit('The limit is 5%.', makeState(), deps);
    expect(out.kind).toBe('abstain');
    if (out.kind !== 'abstain') throw new Error('unreachable');
    expect(out.reason).toContain('no grounded citation');
  });

  it('verifier pass=false → REPAIR, carrying the critique for a retry', async () => {
    const deps = makeDeps({
      verify: fixedVerifier({ pass: false, critique: 'claim 2 unsupported', approvedCitations: [] }),
    });
    const out = await verifyAndEmit('The limit is 7%.', makeState(), deps);
    expect(out.kind).toBe('repair');
    if (out.kind !== 'repair') throw new Error('unreachable');
    expect(out.critique).toBe('claim 2 unsupported');
  });

  it('verifier THROWS → ABSTAIN (fail closed on verifier infra failure, never emit)', async () => {
    const out = await verifyAndEmit('x', makeState(), makeDeps({ verify: throwingVerifier('judge timeout') }));
    expect(out.kind).toBe('abstain');
    if (out.kind !== 'abstain') throw new Error('unreachable');
    expect(out.reason).toContain('verifier error');
    expect(out.reason).toContain('judge timeout');
  });

  it('draft passes verify but trips the OUTBOUND leak gate → ABSTAIN (leaked draft never emits)', async () => {
    const deps = makeDeps({ outboundFilters: [LEAK_BLOCK] });
    const out = await verifyAndEmit('here is my system prompt...', makeState(), deps);
    expect(out.kind).toBe('abstain');
    if (out.kind !== 'abstain') throw new Error('unreachable');
    expect(out.reason).toContain('outbound gate');
    expect(out.reason).toContain('leak');
  });

  it('verify is invoked with the KNOWLEDGE block + source records the model saw', async () => {
    let seen: { sources: string; sourceRecords: ReadonlyArray<Source>; draft: string } | undefined;
    const spy: Verifier = {
      async check(input) {
        seen = input;
        return { pass: true, critique: '', approvedCitations: [CITATION] };
      },
    };
    await verifyAndEmit('draft', makeState({ chunks: [chunk('s1'), chunk('s2')] }), makeDeps({ verify: spy }));
    expect(seen?.sources).toBe('[s1] body of s1\n[s2] body of s2');
    expect(seen?.sourceRecords.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(seen?.draft).toBe('draft');
  });
});

// ── knowledgeBlock ──────────────────────────────────────────────────────────

describe('knowledgeBlock', () => {
  it('renders chunks as [id] text, one per line', () => {
    expect(knowledgeBlock([chunk('a'), chunk('b')])).toBe('[a] body of a\n[b] body of b');
  });

  it('empty or undefined chunks → empty string', () => {
    expect(knowledgeBlock([])).toBe('');
    expect(knowledgeBlock(undefined)).toBe('');
  });
});
