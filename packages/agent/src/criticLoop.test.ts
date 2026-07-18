/**
 * Deterministic tests for the turn driver (increment 2.1b-iii-b-ii-1).
 *
 * criticLoop composes verifyAndEmit + runTools + the reasoner. Everything is faked
 * through the narrow ports and a scripted reasoner, so the LOOP's control flow and its
 * fail-closed edges are tested directly. Each test reddens if an edge stops failing
 * closed — e.g. if a denied tool executed, a verify failure emitted, or an exhausted
 * loop shipped something.
 */
import type { Citation } from '@tenet/core';
import type { Filter } from '@tenet/guardrails';
import { PolicyEvaluator, type PolicyRule } from '@tenet/governance';
import type { StepContext } from '@tenet/workflow';
import type { AgentDeps, RewriteFn, ToolExecutor, Verifier, VerifierVerdict } from './deps.js';
import type { OrchestratorState, ReasonerOutput, Reasoner } from './types.js';
import { criticLoop } from './criticLoop.js';

const CITATION: Citation = { sourceId: 's1', quote: 'daily drawdown is 5%' };
const PASS: VerifierVerdict = { pass: true, critique: '', approvedCitations: [CITATION] };
const FAIL: VerifierVerdict = { pass: false, critique: 'claim 2 unsupported', approvedCitations: [] };

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
    chunks: [{ source: { id: 's1', uri: 'kb://s1', text: 'Daily drawdown is 5%.', confidence: 0.9 }, relevance: 0.8 }],
    ...overrides,
  };
}

function ctxWith(aborted = false): StepContext {
  const ac = new AbortController();
  if (aborted) ac.abort();
  return { signal: ac.signal, runId: 'run-1', stepId: 'critic' };
}

/** Reasoner that returns a scripted sequence, one output per call. */
function scriptedReasoner(outputs: ReasonerOutput[]): Reasoner {
  let i = 0;
  return {
    async reason() {
      return outputs[i++] ?? { kind: 'abstain', reason: 'script exhausted' };
    },
  };
}
const throwingReasoner = (msg: string): Reasoner => ({
  async reason() {
    throw new Error(msg);
  },
});

const fixedVerifier = (v: VerifierVerdict): Verifier => ({ async check() { return v; } });
const recordingExecutor = (): ToolExecutor & { ran: string[] } => {
  const ran: string[] = [];
  return { ran, async execute(c) { ran.push(c.name); return { content: `ran ${c.name}`, isError: false }; } };
};

const ALLOW_OUT: Filter = { id: 'ok', inspect: () => ({ kind: 'allow' }) };

function makeDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    inboundFilters: [],
    retriever: { async query() { return []; } },
    retrieveK: 5,
    boundary: {},
    cache: { async lookup() { return null; } },
    verify: fixedVerifier(PASS),
    outboundFilters: [ALLOW_OUT],
    reasoner: scriptedReasoner([{ kind: 'answer', draft: 'The limit is 5%.', citations: [CITATION] }]),
    maxAttempts: 3,
    policy: new PolicyEvaluator([]),
    tools: recordingExecutor(),
    rewrite: async ({ draft }) => draft, // identity by default (no repair unless a test overrides)
    maxRepairRounds: 0,
    ...over,
  };
}

/** Verifier that returns a scripted sequence of verdicts, one per check() call. */
function scriptedVerifier(verdicts: VerifierVerdict[]): Verifier {
  let i = 0;
  return {
    async check() {
      return verdicts[i++] ?? PASS;
    },
  };
}

/** Rewrite fn that records every call and transforms the draft. */
function recordingRewrite(transform: (draft: string) => string = (d) => `rewritten(${d})`): {
  fn: RewriteFn;
  calls: Array<{ draft: string; critique: string }>;
} {
  const calls: Array<{ draft: string; critique: string }> = [];
  const fn: RewriteFn = async ({ draft, critique }) => {
    calls.push({ draft, critique });
    return transform(draft);
  };
  return { fn, calls };
}

describe('criticLoop — the turn driver', () => {
  it('answer that verifies → resolved (the single emit edge)', async () => {
    const out = await criticLoop(makeDeps())(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('resolved');
    expect(out.halt?.reply.text).toBe('The limit is 5%.');
    expect(out.halt?.reply.citations).toEqual([CITATION]);
  });

  it('answer that FAILS verify with NO repair budget → abstain (fail closed; no emit, no ship)', async () => {
    const deps = makeDeps({ verify: fixedVerifier(FAIL), maxRepairRounds: 0 });
    const out = await criticLoop(deps)(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toContain('unverified');
  });

  it('reasoner abstain → abstain with its reason', async () => {
    const deps = makeDeps({ reasoner: scriptedReasoner([{ kind: 'abstain', reason: 'out of scope' }]) });
    const out = await criticLoop(deps)(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toBe('out of scope');
  });

  it('reasoner handoff → handed_off to the requested target', async () => {
    const deps = makeDeps({
      reasoner: scriptedReasoner([
        { kind: 'handoff', handoff: { kind: 'handoff', target: 'billing', reason: 'refund' } },
      ]),
    });
    const out = await criticLoop(deps)(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('handed_off');
    expect(out.halt?.reason).toBe('billing: refund');
  });

  it('tool → runs (governance-allowed), folds results into history, then answers → resolved', async () => {
    const exec = recordingExecutor();
    const deps = makeDeps({
      tools: exec,
      reasoner: scriptedReasoner([
        { kind: 'tool', calls: [{ id: 't1', name: 'kb.lookup', input: {} }] },
        { kind: 'answer', draft: 'The limit is 5%.', citations: [CITATION] },
      ]),
    });
    const out = await criticLoop(deps)(makeState(), ctxWith());
    expect(exec.ran).toEqual(['kb.lookup']); // the tool actually executed
    expect(out.halt?.outcome).toBe('resolved');
  });

  it('tool DENIED by policy → ops handoff, tool NEVER executes (fail closed)', async () => {
    const exec = recordingExecutor();
    const denyAll: PolicyRule = () => ({ kind: 'deny', reason: 'kb.write forbidden' });
    const deps = makeDeps({
      tools: exec,
      policy: new PolicyEvaluator([denyAll]),
      reasoner: scriptedReasoner([{ kind: 'tool', calls: [{ id: 't1', name: 'kb.write', input: {} }] }]),
    });
    const out = await criticLoop(deps)(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('handed_off');
    expect(out.halt?.reason).toContain('tool denied');
    expect(exec.ran).toEqual([]); // never ran the denied tool
  });

  it('a verified cache hit resolves through the emit edge (never around it)', async () => {
    const out = await criticLoop(makeDeps())(makeState({ cachedDraft: 'cached 5% answer' }), ctxWith());
    expect(out.halt?.outcome).toBe('resolved');
    expect(out.halt?.reply.text).toBe('cached 5% answer'); // the cached draft, but only after verify passed
  });

  it('a cache hit that FAILS verify falls through to reasoning (does NOT abstain the turn)', async () => {
    // verify fails the cache candidate but passes the fresh answer → the turn still resolves.
    let call = 0;
    const verify: Verifier = {
      async check() {
        call += 1;
        return call === 1 ? FAIL : PASS; // 1st check = cache candidate (fail), 2nd = fresh answer (pass)
      },
    };
    const deps = makeDeps({
      verify,
      reasoner: scriptedReasoner([{ kind: 'answer', draft: 'fresh 5% answer', citations: [CITATION] }]),
    });
    const out = await criticLoop(deps)(makeState({ cachedDraft: 'stale answer' }), ctxWith());
    expect(out.halt?.outcome).toBe('resolved');
    expect(out.halt?.reply.text).toBe('fresh 5% answer'); // not the stale cache
  });

  it('reasoner throws → abstain (fail closed)', async () => {
    const out = await criticLoop(makeDeps({ reasoner: throwingReasoner('model 500') }))(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toContain('reasoner error');
    expect(out.halt?.reason).toContain('model 500');
  });

  it('an already-aborted signal → abstain before any reasoning', async () => {
    const exec = recordingExecutor();
    const spyReasoner: Reasoner = { async reason() { throw new Error('should not be called'); } };
    const out = await criticLoop(makeDeps({ reasoner: spyReasoner, tools: exec }))(makeState(), ctxWith(true));
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toBe('aborted');
  });

  // ── rewrite-retry (2.1b-v) ──────────────────────────────────────────────────

  it('a draft that fails, then a rewrite that verifies → resolved (repair recovers)', async () => {
    const rw = recordingRewrite((d) => `fixed(${d})`);
    const deps = makeDeps({
      verify: scriptedVerifier([FAIL, PASS]), // 1st draft fails, rewritten draft passes
      rewrite: rw.fn,
      maxRepairRounds: 1,
    });
    const out = await criticLoop(deps)(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('resolved');
    expect(out.halt?.reply.text).toBe('fixed(The limit is 5%.)'); // the REWRITTEN draft emitted
    expect(rw.calls).toHaveLength(1);
    expect(rw.calls[0]?.critique).toBe('claim 2 unsupported'); // the verifier critique drove the rewrite
  });

  it('repair budget exhausted (still failing after N rewrites) → abstain (fail closed)', async () => {
    const rw = recordingRewrite();
    const deps = makeDeps({ verify: fixedVerifier(FAIL), rewrite: rw.fn, maxRepairRounds: 2 });
    const out = await criticLoop(deps)(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toContain('unverified after 2 repair round(s)');
    expect(rw.calls).toHaveLength(2); // rewrote exactly maxRepairRounds times, then gave up
  });

  it('a rewrite that THROWS → abstain (fail closed), never ships', async () => {
    const throwingRewrite: RewriteFn = async () => {
      throw new Error('rewriter down');
    };
    const deps = makeDeps({ verify: fixedVerifier(FAIL), rewrite: throwingRewrite, maxRepairRounds: 2 });
    const out = await criticLoop(deps)(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toContain('repair failed');
    expect(out.halt?.reason).toContain('rewriter down');
  });

  it('an ABSTAIN verdict (verifier throw) is NOT repairable — abstain immediately, no rewrite', async () => {
    const rw = recordingRewrite();
    const throwingVerify: Verifier = {
      async check() {
        throw new Error('judge down');
      },
    };
    const deps = makeDeps({ verify: throwingVerify, rewrite: rw.fn, maxRepairRounds: 3 });
    const out = await criticLoop(deps)(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toContain('verifier error');
    expect(rw.calls).toHaveLength(0); // a non-repairable abstain must not trigger a rewrite
  });

  it('endless tool calls exhaust maxAttempts → abstain, never ships (fail closed)', async () => {
    const toolForever = Array.from({ length: 10 }, (): ReasonerOutput => ({
      kind: 'tool',
      calls: [{ id: 't', name: 'kb.lookup', input: {} }],
    }));
    const exec = recordingExecutor();
    const deps = makeDeps({ maxAttempts: 2, tools: exec, reasoner: scriptedReasoner(toolForever) });
    const out = await criticLoop(deps)(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('disqualified');
    expect(out.halt?.reason).toContain('no answer within 2 attempts');
    expect(exec.ran).toHaveLength(2); // EXACTLY maxAttempts passes — not maxAttempts+1 (off-by-one guard)
  });

  it('an UNEXPECTED reasoner decision kind → abstain IMMEDIATELY (fail closed, does not burn maxAttempts)', async () => {
    // A buggy/future ReasonerOutput variant the switch cannot map must fail CLOSED at once —
    // never ship, and never fall through to re-reason (which would waste maxAttempts model
    // calls on the same unmappable decision). The exhaustiveness `default` guarantees this.
    let reasonCalls = 0;
    const unmappable: Reasoner = {
      async reason() {
        reasonCalls++;
        return { kind: 'telepathy', draft: 'ungrounded' } as unknown as ReasonerOutput;
      },
    };
    const out = await criticLoop(makeDeps({ reasoner: unmappable, maxAttempts: 5 }))(makeState(), ctxWith());
    expect(out.halt?.outcome).toBe('disqualified'); // abstain, never resolved
    expect(out.halt?.reason).toContain('unexpected reasoner decision');
    expect(reasonCalls).toBe(1); // IMMEDIATE — did not loop 5 times before abstaining
  });
});
