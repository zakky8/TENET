#!/usr/bin/env node
/**
 * tenet-measure — runs every BENCHMARKS dimension against bundled
 * fixtures + the deterministic stub SUT, prints a measurement table,
 * and exits non-zero on any failing gate verdict.
 *
 * Operators replace the stub by importing measureAll() and passing
 * their own ChatModel-backed runner.
 */

import { measureAll, DEFAULT_TARGETS } from './runner.js';

const report = measureAll(DEFAULT_TARGETS);
const jsonOnly = process.argv.includes('--json');

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
  const anyFailJson = report.verdicts?.some((v) => v.kind === 'fail' || v.kind === 'missing') ?? false;
  process.exit(anyFailJson ? 1 : 0);
}

const rows = report.metrics.map((m) => {
  const v = report.verdicts?.find((x) => x.metric === m.metric);
  const status =
    v?.kind === 'pass' ? 'PASS' : v?.kind === 'fail' ? 'FAIL' : v?.kind === 'missing' ? 'MISS' : '----';
  const target =
    v && v.kind !== 'missing' ? String((v as { target: number }).target) : '?';
  return {
    metric: m.metric,
    measured: m.value.toFixed(m.unit === 'rate' || m.unit === 'score' ? 5 : 3),
    unit: m.unit,
    target,
    sampleSize: m.sampleSize,
    status,
  };
});

// One simple table — no deps.
const pad = (s: string, n: number): string => (s + ' '.repeat(n)).slice(0, n);
const header = `${pad('metric', 28)} ${pad('measured', 10)} ${pad('unit', 6)} ${pad('target', 10)} ${pad('n', 6)} status`;
console.log(header);
console.log('-'.repeat(header.length));
for (const r of rows) {
  console.log(
    `${pad(r.metric, 28)} ${pad(r.measured, 10)} ${pad(r.unit, 6)} ${pad(r.target, 10)} ${pad(String(r.sampleSize), 6)} ${r.status}`,
  );
}
console.log('-'.repeat(header.length));
console.log(`SUT: ${report.sut}   fixtures: ${report.manifest.total}`);

const anyFail = report.verdicts?.some((v) => v.kind === 'fail' || v.kind === 'missing') ?? false;
process.exit(anyFail ? 1 : 0);
