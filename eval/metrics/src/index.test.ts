import {
  quantile,
  wilson95,
  hallucinationRate,
  groundednessRate,
  costPerResolution,
  ttftP95,
  e2eLatencyP95,
  toolCallSuccessRate,
  injectionBlockRate,
  retrievalRecallAtK,
  routerDecisionAccuracy,
  determinismRate,
  gate,
  type BenchmarkTarget,
} from './index.js';

describe('quantile', () => {
  it('exact-position quantile returns the value at that index', () => {
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it('between-position quantile linearly interpolates', () => {
    // 4 samples, p=0.95 → pos = 0.95*3 = 2.85, between idx 2 (=3) and idx 3 (=4)
    expect(quantile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 5);
  });

  it('throws on empty input', () => {
    expect(() => quantile([], 0.5)).toThrow();
  });

  it('throws on out-of-range p', () => {
    expect(() => quantile([1], 1.1)).toThrow();
    expect(() => quantile([1], -0.1)).toThrow();
  });

  it('handles unsorted input', () => {
    expect(quantile([5, 1, 4, 2, 3], 0.5)).toBe(3);
  });
});

describe('wilson95', () => {
  it('returns [0,0] for n=0', () => {
    expect(wilson95(0, 0)).toEqual([0, 0]);
  });

  it('produces lo < phat < hi for typical proportion', () => {
    const [lo, hi] = wilson95(50, 100);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
  });

  it('clamps to [0,1] at boundaries', () => {
    const [, hi] = wilson95(10, 10);
    expect(hi).toBeLessThanOrEqual(1);
    const [lo] = wilson95(0, 10);
    expect(lo).toBeGreaterThanOrEqual(0);
  });
});

describe('hallucinationRate', () => {
  it('zero verdicts → 0 rate', () => {
    const r = hallucinationRate([]);
    expect(r.value).toBe(0);
    expect(r.sampleSize).toBe(0);
  });

  it('1 hallucination out of 10 → 0.1 with CI', () => {
    const verdicts = [
      ...Array.from({ length: 9 }, (_, i) => ({ caseId: `s${i}`, supported: true })),
      { caseId: 'f1', supported: false },
    ];
    const r = hallucinationRate(verdicts);
    expect(r.value).toBeCloseTo(0.1, 5);
    expect(r.unit).toBe('rate');
    expect(r.ci95).toBeDefined();
    expect(r.ci95![0]).toBeLessThan(0.1);
    expect(r.ci95![1]).toBeGreaterThan(0.1);
  });
});

describe('groundednessRate', () => {
  it('all grounded → 1', () => {
    const r = groundednessRate([
      { claimId: 'a', grounded: true },
      { claimId: 'b', grounded: true },
    ]);
    expect(r.value).toBe(1);
  });

  it('empty → 1 (vacuous)', () => {
    expect(groundednessRate([]).value).toBe(1);
  });

  it('half grounded → 0.5', () => {
    const r = groundednessRate([
      { claimId: 'a', grounded: true },
      { claimId: 'b', grounded: false },
    ]);
    expect(r.value).toBe(0.5);
  });
});

describe('costPerResolution', () => {
  it('divides only over resolved conversations', () => {
    const r = costPerResolution([
      { conversationId: 'a', resolved: true, costUsd: 0.05 },
      { conversationId: 'b', resolved: true, costUsd: 0.03 },
      { conversationId: 'c', resolved: false, costUsd: 0.50 },
    ]);
    expect(r.value).toBeCloseTo(0.04, 5);
    expect(r.sampleSize).toBe(2);
    expect(r.extra).toEqual({ resolved_count: 2, total_count: 3 });
  });

  it('no resolutions → 0', () => {
    expect(costPerResolution([]).value).toBe(0);
  });
});

describe('latency p95', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    caseId: `c${i}`,
    ttftMs: 100 + i * 10,
    e2eMs: 500 + i * 50,
  }));

  it('ttftP95 finds the upper-tail value', () => {
    const r = ttftP95(samples);
    expect(r.value).toBeGreaterThan(250);
    expect(r.unit).toBe('ms');
  });

  it('e2eLatencyP95 finds upper-tail', () => {
    expect(e2eLatencyP95(samples).value).toBeGreaterThan(1300);
  });

  it('empty → 0', () => {
    expect(ttftP95([]).value).toBe(0);
    expect(e2eLatencyP95([]).value).toBe(0);
  });
});

describe('toolCallSuccessRate', () => {
  it('mixed outcomes', () => {
    const r = toolCallSuccessRate([
      { id: 'a', success: true },
      { id: 'b', success: true },
      { id: 'c', success: false },
    ]);
    expect(r.value).toBeCloseTo(2 / 3, 5);
    expect(r.ci95).toBeDefined();
  });

  it('empty → 1', () => {
    expect(toolCallSuccessRate([]).value).toBe(1);
  });
});

describe('injectionBlockRate', () => {
  it('blocks all → 1', () => {
    const r = injectionBlockRate(
      Array.from({ length: 50 }, (_, i) => ({ attemptId: `a${i}`, blocked: true })),
    );
    expect(r.value).toBe(1);
  });

  it('1 leak in 100', () => {
    const r = injectionBlockRate([
      ...Array.from({ length: 99 }, (_, i) => ({ attemptId: `a${i}`, blocked: true })),
      { attemptId: 'leak', blocked: false },
    ]);
    expect(r.value).toBe(0.99);
  });
});

describe('retrievalRecallAtK', () => {
  it('hit-all → 1', () => {
    const r = retrievalRecallAtK(
      [{ queryId: 'q', returnedIds: ['x', 'y', 'z'], relevantIds: ['x', 'y'] }],
      10,
    );
    expect(r.value).toBe(1);
  });

  it('partial hit', () => {
    const r = retrievalRecallAtK(
      [{ queryId: 'q', returnedIds: ['x', 'a', 'b'], relevantIds: ['x', 'y'] }],
      10,
    );
    expect(r.value).toBe(0.5);
  });

  it('skips queries with no relevant labels', () => {
    const r = retrievalRecallAtK(
      [
        { queryId: 'q1', returnedIds: ['x'], relevantIds: [] },
        { queryId: 'q2', returnedIds: ['x'], relevantIds: ['x'] },
      ],
      5,
    );
    expect(r.value).toBe(1);
    expect(r.sampleSize).toBe(1);
  });

  it('k truncates returned ids', () => {
    const r = retrievalRecallAtK(
      [{ queryId: 'q', returnedIds: ['a', 'b', 'c', 'd', 'x'], relevantIds: ['x'] }],
      3,
    );
    expect(r.value).toBe(0); // x is at idx 4, not in top-3
  });

  it('throws on k<=0', () => {
    expect(() => retrievalRecallAtK([], 0)).toThrow();
  });
});

describe('routerDecisionAccuracy', () => {
  it('majority match', () => {
    const r = routerDecisionAccuracy([
      { caseId: 'a', chosen: 'haiku', oracle: 'haiku' },
      { caseId: 'b', chosen: 'opus', oracle: 'opus' },
      { caseId: 'c', chosen: 'haiku', oracle: 'opus' },
    ]);
    expect(r.value).toBeCloseTo(2 / 3, 5);
  });
});

describe('determinismRate', () => {
  it('all stable → 1', () => {
    const r = determinismRate([
      { caseId: 'a', outputs: ['x', 'x', 'x'] },
      { caseId: 'b', outputs: ['y', 'y'] },
    ]);
    expect(r.value).toBe(1);
  });

  it('one drift → 0.5', () => {
    const r = determinismRate([
      { caseId: 'a', outputs: ['x', 'x'] },
      { caseId: 'b', outputs: ['y', 'z'] },
    ]);
    expect(r.value).toBe(0.5);
  });

  it('ignores single-output samples', () => {
    const r = determinismRate([{ caseId: 'a', outputs: ['x'] }]);
    expect(r.sampleSize).toBe(0);
    expect(r.value).toBe(1);
  });
});

describe('gate', () => {
  const measured = [
    hallucinationRate(
      Array.from({ length: 1000 }, (_, i) => ({ caseId: `c${i}`, supported: i !== 0 })),
    ),
    costPerResolution([{ conversationId: 'a', resolved: true, costUsd: 0.009 }]),
    ttftP95([{ caseId: 'a', ttftMs: 150, e2eMs: 1000 }]),
  ];

  const targets: BenchmarkTarget[] = [
    { metric: 'hallucination_rate', target: 0.001, unit: 'rate', direction: 'minimize' },
    { metric: 'cost_per_resolution_usd', target: 0.01, unit: 'usd', direction: 'minimize' },
    { metric: 'ttft_p95_ms', target: 200, unit: 'ms', direction: 'minimize' },
    { metric: 'missing_metric', target: 0, unit: 'count', direction: 'minimize' },
  ];

  it('reports pass / fail / missing per target', () => {
    const verdicts = gate(measured, targets);
    expect(verdicts).toHaveLength(4);

    // hallucination: 1/1000 = 0.001, exactly at target → pass
    expect(verdicts[0]!.kind).toBe('pass');
    // cost: 0.009 <= 0.01 → pass
    expect(verdicts[1]!.kind).toBe('pass');
    // ttft: 150 <= 200 → pass
    expect(verdicts[2]!.kind).toBe('pass');
    // missing entirely
    expect(verdicts[3]!.kind).toBe('missing');
  });

  it('fails when measured exceeds target on minimize direction', () => {
    const verdicts = gate(measured, [
      { metric: 'ttft_p95_ms', target: 100, unit: 'ms', direction: 'minimize' },
    ]);
    expect(verdicts[0]!.kind).toBe('fail');
  });

  it('fails on regression vs baseline even when target met', () => {
    const verdicts = gate(measured, [
      {
        metric: 'ttft_p95_ms',
        target: 200,
        unit: 'ms',
        direction: 'minimize',
        baseline: 100,
        regressionToleranceAbs: 20,
      },
    ]);
    // measured = 150, baseline = 100, regression = 50, tol = 20 → fail
    expect(verdicts[0]!.kind).toBe('fail');
    if (verdicts[0]!.kind === 'fail') {
      expect(verdicts[0]!.reason).toMatch(/regression/);
    }
  });

  it('passes on maximize when measured >= target', () => {
    const m = [toolCallSuccessRate([{ id: 'a', success: true }, { id: 'b', success: true }])];
    const verdicts = gate(m, [
      { metric: 'tool_call_success_rate', target: 0.99, unit: 'rate', direction: 'maximize' },
    ]);
    expect(verdicts[0]!.kind).toBe('pass');
  });
});
