/**
 * Deterministic tests for the terminal Result builders (increment 2.1b-i).
 *
 * The anti-hallucination guarantee made concrete: `emitResult` is the ONLY terminal
 * that puts model-generated text in front of the member. `abstain` and `handoff`
 * return a FIXED safe message and carry the real cause only in `Result.reason`
 * (telemetry). Each test is written to FAIL if a terminal leaked model text into the
 * reply, dropped its diagnostic reason, or recorded the wrong outcome.
 */
import type { Citation } from '@tenet/core';
import {
  ABSTAIN_REPLY,
  HANDOFF_REPLY,
  abstainResult,
  emitResult,
  handoffResult,
} from './terminals.js';

describe('emitResult — the ONLY terminal that surfaces model text', () => {
  it('carries the draft and citations verbatim with a resolved outcome', () => {
    const citations: Citation[] = [{ sourceId: 'src-1', quote: 'daily drawdown is 5%' }];
    expect(emitResult('The limit is 5%.', citations)).toEqual({
      reply: { text: 'The limit is 5%.', citations },
      outcome: 'resolved',
    });
  });

  it('attaches NO diagnostic reason (a resolved turn has nothing to explain)', () => {
    // Non-vacuous: `in` is false only because emitResult omits the key entirely.
    expect('reason' in emitResult('x', [])).toBe(false);
  });
});

describe('abstainResult — fail-CLOSED terminal', () => {
  it('returns the FIXED abstain message, never model text, with an empty citation list', () => {
    const r = abstainResult('answer without a grounded citation');
    expect(r.reply.text).toBe(ABSTAIN_REPLY);
    expect(r.reply.citations).toEqual([]);
    expect(r.outcome).toBe('disqualified');
  });

  it('carries the real reason for telemetry (not shown to the member)', () => {
    expect(abstainResult('graph ended without a terminal').reason).toBe(
      'graph ended without a terminal',
    );
  });

  it('emits an identical safe message regardless of the internal cause (no detail leak)', () => {
    const a = abstainResult('kb index unreachable');
    const b = abstainResult('judge model timeout');
    expect(a.reply.text).toBe(b.reply.text);
    expect(a.reason).not.toBe(b.reason); // ...yet the causes are still distinguishable in telemetry
  });
});

describe('handoffResult — routed to a human', () => {
  it('returns the FIXED handoff message, never model text, with an empty citation list', () => {
    const r = handoffResult('billing-team', 'refund request');
    expect(r.reply.text).toBe(HANDOFF_REPLY);
    expect(r.reply.citations).toEqual([]);
    expect(r.outcome).toBe('handed_off');
  });

  it('preserves the routing target and reason in Result.reason', () => {
    expect(handoffResult('billing-team', 'refund request').reason).toBe('billing-team: refund request');
  });
});

describe('the fixed safe messages themselves', () => {
  it('are non-empty and distinct, so abstain and handoff never read identically', () => {
    expect(ABSTAIN_REPLY.length).toBeGreaterThan(0);
    expect(HANDOFF_REPLY.length).toBeGreaterThan(0);
    expect(ABSTAIN_REPLY).not.toBe(HANDOFF_REPLY);
  });
});
