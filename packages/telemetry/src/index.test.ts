import { jest } from '@jest/globals';
import {
  ATTR,
  OutcomeEmitter,
  CostMeter,
  buildAttributes,
  type ModelPrice,
} from './index.js';
import type { OutcomeEvent } from '@tenet/core';

function event(extras: Partial<OutcomeEvent> = {}): OutcomeEvent {
  return {
    outcome: 'resolved',
    conversationId: 'conv-1',
    tenantId: 'tenant-a',
    durationMs: 1234,
    costUsd: 0.005,
    verifierPassed: true,
    ...extras,
  };
}

describe('ATTR — OTel GenAI semconv key constants', () => {
  it('matches the spec keys (gen_ai.* namespace)', () => {
    expect(ATTR.GEN_AI_SYSTEM).toBe('gen_ai.system');
    expect(ATTR.GEN_AI_REQUEST_MODEL).toBe('gen_ai.request.model');
    expect(ATTR.GEN_AI_USAGE_INPUT_TOKENS).toBe('gen_ai.usage.input_tokens');
    expect(ATTR.GEN_AI_USAGE_OUTPUT_TOKENS).toBe('gen_ai.usage.output_tokens');
  });

  it('TENET-specific keys live under agent.* namespace', () => {
    expect(ATTR.AGENT_OUTCOME).toMatch(/^agent\./);
    expect(ATTR.AGENT_TENANT_ID).toMatch(/^agent\./);
    expect(ATTR.AGENT_COST_USD).toMatch(/^agent\./);
  });
});

describe('OutcomeEmitter', () => {
  it('forwards an event to every registered sink', () => {
    const sink1 = jest.fn();
    const sink2 = jest.fn();
    const em = new OutcomeEmitter([sink1, sink2]);
    em.emit(event());
    expect(sink1).toHaveBeenCalledTimes(1);
    expect(sink2).toHaveBeenCalledTimes(1);
    expect(sink1.mock.calls[0]![0].outcome).toBe('resolved');
  });

  it('rejects unknown outcome values', () => {
    const em = new OutcomeEmitter([jest.fn()]);
    expect(() => em.emit(event({ outcome: 'whatever' as any }))).toThrow(/Invalid outcome/);
  });

  it('rejects negative durationMs', () => {
    const em = new OutcomeEmitter([jest.fn()]);
    expect(() => em.emit(event({ durationMs: -1 }))).toThrow(/durationMs/);
  });

  it('rejects negative costUsd', () => {
    const em = new OutcomeEmitter([jest.fn()]);
    expect(() => em.emit(event({ costUsd: -0.01 }))).toThrow(/costUsd/);
  });

  it('rejects missing conversationId / tenantId', () => {
    const em = new OutcomeEmitter([jest.fn()]);
    expect(() => em.emit(event({ conversationId: '' }))).toThrow();
    expect(() => em.emit(event({ tenantId: '' }))).toThrow();
  });

  it('isolates sink failures — one broken sink does not break the others', () => {
    const broken = jest.fn(() => {
      throw new Error('downstream sink dead');
    });
    const good = jest.fn();
    const em = new OutcomeEmitter([broken, good]);
    expect(() => em.emit(event())).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('accepts every documented outcome literal', () => {
    const em = new OutcomeEmitter([jest.fn()]);
    for (const o of ['resolved', 'handed_off', 'disqualified', 'qualified', 'pending'] as const) {
      expect(() => em.emit(event({ outcome: o }))).not.toThrow();
    }
  });
});

describe('CostMeter', () => {
  const PRICE: Record<string, ModelPrice> = {
    'claude-opus-4-8': { inputPerMillion: 15, outputPerMillion: 75 },
    'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4 },
  };

  it('accumulates cost across calls', () => {
    const m = new CostMeter(PRICE);
    m.record('claude-opus-4-8', 1_000_000, 1_000_000); // $15 + $75 = $90
    expect(m.total()).toBeCloseTo(90, 5);
  });

  it('uses per-model pricing', () => {
    const m = new CostMeter(PRICE);
    m.record('claude-haiku-4-5', 1_000_000, 0); // $0.80
    expect(m.total()).toBeCloseTo(0.8, 5);
  });

  it('handles partial-million token counts proportionally', () => {
    const m = new CostMeter(PRICE);
    m.record('claude-opus-4-8', 100_000, 50_000); // $1.50 + $3.75 = $5.25
    expect(m.total()).toBeCloseTo(5.25, 5);
  });

  it('throws on unknown model by default (prevents silent zero-cost typo class)', () => {
    const m = new CostMeter(PRICE);
    expect(() => m.record('claude-3-5-sonnet-20241022', 1_000_000, 0))
      .toThrow(/Unknown model/);
    expect(m.total()).toBe(0);
  });

  it("opt-in 'skip' policy preserves silent-skip behavior for allowlist mode", () => {
    const m = new CostMeter(PRICE, 'skip');
    m.record('unknown-model', 1_000_000, 1_000_000);
    expect(m.total()).toBe(0);
  });

  it('rejects negative token counts', () => {
    const m = new CostMeter(PRICE);
    expect(() => m.record('claude-opus-4-8', -1, 0)).toThrow(/>= 0/);
    expect(() => m.record('claude-opus-4-8', 0, -1)).toThrow();
  });

  it('reset() zeroes the running total', () => {
    const m = new CostMeter(PRICE);
    m.record('claude-opus-4-8', 1_000_000, 0);
    m.reset();
    expect(m.total()).toBe(0);
  });
});

describe('buildAttributes', () => {
  it('passes through string/number/boolean values', () => {
    expect(buildAttributes({ a: 'x', b: 1, c: true })).toEqual({ a: 'x', b: 1, c: true });
  });

  it('drops undefined and null', () => {
    expect(buildAttributes({ a: undefined, b: null, c: 'keep' })).toEqual({ c: 'keep' });
  });

  it('joins string[] into a comma-separated string', () => {
    expect(buildAttributes({ tags: ['a', 'b', 'c'] })).toEqual({ tags: 'a,b,c' });
  });

  it('drops objects, functions, symbols, mixed arrays', () => {
    expect(
      buildAttributes({
        obj: { foo: 'bar' },
        fn: () => 1,
        sym: Symbol('x'),
        mixed: ['a', 1],
      }),
    ).toEqual({});
  });
});
