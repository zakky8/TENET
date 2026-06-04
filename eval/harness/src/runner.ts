import type {
  CaseResult,
  EvalCase,
  EvalDataset,
  RunReport,
  Sut,
} from './types.js';

export interface RunOptions {
  /** Max concurrent cases. Default 4. */
  concurrency?: number;
  /** Filter cases by label match. */
  labelFilter?: ReadonlyArray<string>;
  /** Hard timeout per case, ms. Default 30s. */
  perCaseTimeoutMs?: number;
}

/** Execute a dataset against a sut and score. */
export async function runEval(
  dataset: EvalDataset,
  sut: Sut,
  opts: RunOptions = {},
): Promise<RunReport> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const timeout = opts.perCaseTimeoutMs ?? 30_000;
  const labelFilter = opts.labelFilter ?? [];

  const cases = dataset.cases.filter(
    (c) =>
      labelFilter.length === 0 ||
      (c.labels ?? []).some((l) => labelFilter.includes(l)),
  );

  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= cases.length) return;
        results[idx] = await runOne(cases[idx]!, sut, timeout);
      }
    }),
  );

  // ES2024 Object.groupBy — partition results by outcome in one pass.
  const buckets = Object.groupBy(results, (r) =>
    r.error !== undefined ? 'errored' : r.passed ? 'passed' : 'failed',
  );
  return {
    datasetName: dataset.name,
    datasetVersion: dataset.version,
    results,
    passed: buckets.passed?.length ?? 0,
    failed: buckets.failed?.length ?? 0,
    errored: buckets.errored?.length ?? 0,
  };
}

async function runOne(c: EvalCase, sut: Sut, timeoutMs: number): Promise<CaseResult> {
  const start = Date.now();
  let output: unknown;
  let errorMsg: string | undefined;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    output = await sut(c.input, ctrl.signal);
  } catch (e) {
    errorMsg = (e as Error)?.message ?? String(e);
  } finally {
    clearTimeout(timer);
  }

  if (errorMsg !== undefined) {
    return {
      caseId: c.id,
      passed: false,
      assertions: [],
      durationMs: Date.now() - start,
      error: errorMsg,
    };
  }

  const assertionResults = await Promise.all(
    c.assertions.map(async (a) => ({ id: a.id, result: await a.check({ output, case: c }) })),
  );
  const allPassed = assertionResults.every((r) => r.result.kind === 'pass');
  return {
    caseId: c.id,
    passed: allPassed,
    assertions: assertionResults,
    durationMs: Date.now() - start,
  };
}
