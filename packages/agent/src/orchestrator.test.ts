/**
 * Deterministic tests for the orchestrator graph mechanics (increment 2.1b-i).
 *
 * Two properties are load-bearing for the anti-hallucination guarantee:
 *  1. `finalize` FAILS CLOSED — a graph that ends without a terminal ABSTAINS; it
 *     never returns an empty or unverified answer.
 *  2. `halting` makes a node a no-op once `halt` is set, so a terminal reached early
 *     cannot be overwritten (or bypassed) by a later node.
 * Each test fails if either property regresses.
 */
import type { StepContext } from '@tenet/workflow';
import type { OrchestratorState } from './types.js';
import { finalize, halting } from './orchestrator.js';
import { abstainResult, emitResult, handoffResult } from './terminals.js';

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    event: {
      surface: 'test',
      tenantId: 'tenant-1',
      conversationId: 'conv-1',
      userId: 'user-1',
      text: 'hello',
      receivedAt: 0,
    },
    history: [{ role: 'user', content: 'hello' }],
    intent: 'question',
    sources: [],
    attempts: 0,
    ...overrides,
  };
}

const ctx: StepContext = { signal: new AbortController().signal, runId: 'run-1', stepId: 'step-1' };

describe('finalize — the fail-CLOSED default', () => {
  it('abstains when the graph ended WITHOUT a terminal (never emits an empty answer)', () => {
    const r = finalize(makeState());
    expect(r).toEqual(abstainResult('graph ended without a terminal'));
    expect(r.outcome).toBe('disqualified');
    expect(r.reply.citations).toEqual([]);
  });

  it('returns the carried emit terminal unchanged when the graph set one', () => {
    const emitted = emitResult('The limit is 5%.', [{ sourceId: 's', quote: 'q' }]);
    expect(finalize(makeState({ halt: emitted }))).toBe(emitted);
  });

  it('returns the carried handoff terminal unchanged (does not override with abstain)', () => {
    const handed = handoffResult('billing', 'refund');
    expect(finalize(makeState({ halt: handed }))).toBe(handed);
  });
});

describe('halting — short-circuit once a terminal is carried', () => {
  it('SKIPS the wrapped node when halt is set and passes the exact state through', async () => {
    let called = false;
    const node = halting(async (s) => {
      called = true;
      return { ...s, attempts: s.attempts + 1 };
    });
    const halted = makeState({ halt: abstainResult('already done'), attempts: 5 });
    const out = await node(halted, ctx);
    expect(called).toBe(false); // the node body never ran
    expect(out).toBe(halted); // the same object flows through, untouched
    expect(out.attempts).toBe(5); // and its fields are unmodified
  });

  it('RUNS the wrapped node when no terminal is carried', async () => {
    const node = halting(async (s) => ({ ...s, attempts: s.attempts + 1 }));
    const out = await node(makeState({ attempts: 2 }), ctx);
    expect(out.attempts).toBe(3);
    expect(out.halt).toBeUndefined();
  });
});
