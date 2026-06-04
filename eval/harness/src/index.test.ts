import {
  containsAssertion,
  doesNotContainAssertion,
  eqAssertion,
  gate,
  matchesAssertion,
  predicateAssertion,
  runEval,
  summarize,
  type EvalCase,
  type EvalDataset,
} from './index.js';

const SAMPLE: EvalDataset = {
  name: 'sample',
  version: '1',
  cases: [
    {
      id: 'a',
      input: 'hello',
      assertions: [
        eqAssertion('eq', 'HELLO'),
        containsAssertion('contains', 'HELL'),
        matchesAssertion('matches', /^HELLO$/),
      ],
    },
    {
      id: 'b',
      input: 'world',
      labels: ['cohort1'],
      assertions: [eqAssertion('eq', 'WORLD')],
    },
  ],
};

const upperSut = async (input: unknown): Promise<unknown> => String(input).toUpperCase();

describe('runEval — happy path', () => {
  it('runs all cases and reports correct counts', async () => {
    const r = await runEval(SAMPLE, upperSut);
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.errored).toBe(0);
    expect(r.results).toHaveLength(2);
  });

  it('attaches durations to results', async () => {
    const r = await runEval(SAMPLE, upperSut);
    for (const c of r.results) expect(c.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runEval — assertions fail', () => {
  it('marks case as failed when ANY assertion fails', async () => {
    const ds: EvalDataset = {
      name: 'x',
      version: '1',
      cases: [
        {
          id: 'a',
          input: 'hello',
          assertions: [eqAssertion('eq', 'NOPE'), containsAssertion('c', 'HELL')],
        },
      ],
    };
    const r = await runEval(ds, upperSut);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.results[0]!.assertions[0]!.result.kind).toBe('fail');
    expect(r.results[0]!.assertions[1]!.result.kind).toBe('pass');
  });
});

describe('runEval — sut error', () => {
  it('reports errored with message', async () => {
    const ds: EvalDataset = {
      name: 'x',
      version: '1',
      cases: [{ id: 'a', input: 'hi', assertions: [] }],
    };
    const sut = async () => {
      throw new Error('boom');
    };
    const r = await runEval(ds, sut);
    expect(r.errored).toBe(1);
    expect(r.results[0]!.error).toBe('boom');
  });
});

describe('runEval — label filtering', () => {
  it('runs only cases with matching label', async () => {
    const r = await runEval(SAMPLE, upperSut, { labelFilter: ['cohort1'] });
    expect(r.results.filter((x) => x !== undefined).length).toBe(1);
    expect(r.results[0]!.caseId).toBe('b');
  });
});

describe('runEval — concurrency cap', () => {
  it('respects max concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const ds: EvalDataset = {
      name: 'x',
      version: '1',
      cases: Array.from(
        { length: 10 },
        (_, i): EvalCase => ({ id: String(i), input: i, assertions: [] }),
      ),
    };
    const sut = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return 0;
    };
    await runEval(ds, sut, { concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('builtin assertions', () => {
  it('eq: pass/fail', async () => {
    const a = eqAssertion('e', 'x');
    expect((await a.check({ output: 'x', case: {} as EvalCase })).kind).toBe('pass');
    expect((await a.check({ output: 'y', case: {} as EvalCase })).kind).toBe('fail');
  });

  it('doesNotContain: blocks forbidden substring', async () => {
    const a = doesNotContainAssertion('safe', 'secret');
    expect((await a.check({ output: 'hello world', case: {} as EvalCase })).kind).toBe('pass');
    expect((await a.check({ output: 'a secret leaked', case: {} as EvalCase })).kind).toBe('fail');
  });

  it('predicate: arbitrary check', async () => {
    const a = predicateAssertion('long', (o) => String(o).length >= 5);
    expect((await a.check({ output: 'hello', case: {} as EvalCase })).kind).toBe('pass');
    expect((await a.check({ output: 'hi', case: {} as EvalCase })).kind).toBe('fail');
  });
});

describe('regressionGate', () => {
  it('passes when pass-rate is at baseline', async () => {
    const r = await runEval(SAMPLE, upperSut);
    const verdict = gate(r, summarize(r));
    expect(verdict.ok).toBe(true);
  });

  it('fails when pass-rate regresses past tolerance', async () => {
    const r = await runEval(SAMPLE, upperSut);
    const baseline = { ...summarize(r), passRate: 1 };
    // Simulate a regressed report
    const regressed = { ...r, passed: 0, failed: 2 };
    const verdict = gate(regressed, baseline, { maxPassRateDropAbs: 0.1 });
    expect(verdict.ok).toBe(false);
  });

  it('rejects dataset mismatch', () => {
    const r = {
      datasetName: 'A',
      datasetVersion: '1',
      results: [],
      passed: 0,
      failed: 0,
      errored: 0,
    };
    const baseline = { datasetName: 'B', datasetVersion: '1', passRate: 1 };
    const verdict = gate(r, baseline);
    expect(verdict.ok).toBe(false);
  });

  it('tolerates regression within maxPassRateDropAbs', async () => {
    const r = await runEval(SAMPLE, upperSut);
    const baseline = { ...summarize(r), passRate: 0.95 };
    const verdict = gate(r, baseline, { maxPassRateDropAbs: 0.1 });
    expect(verdict.ok).toBe(true);
  });
});
