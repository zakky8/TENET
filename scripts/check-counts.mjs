#!/usr/bin/env node
/**
 * Single source of truth for the repo's test-count claims: the LIVE jest run.
 *
 * A hard-coded "N tests across M suites" in a README or doc is a number in the repo's
 * own voice — and a stale one is a hallucination. This gate runs the suite, reads the
 * real `numTotalTests` / `numTotalTestSuites`, then checks every count-claim in the
 * tracked docs against it and FAILS (exit 1) on any drift. Wire it in CI so a doc count
 * can never silently fall behind the suite again.
 *
 * Historical counts (CHANGELOG deltas like "1051 → 1117", "was 83 / 1051") are NOT
 * checked — only files listed in DOCS, and only the current-claim patterns below.
 *
 * Usage: `node scripts/check-counts.mjs`  (or `pnpm counts:check`)
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DOCS = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/ROADMAP.md',
  'docs/marketing/LAUNCH-COPY.md',
  'docs/marketing/AWESOME-LIST-SUBMISSIONS.md',
];

// Each pattern captures a test-count and/or a suite-count group from the exact phrasings
// used across the docs. [regex, testGroup | null, suiteGroup | null].
const PATTERNS = [
  [/tests-(\d+)(?:%20| )passing/gi, 1, null], // shields.io badge
  [/(\d[\d,]*)\s+tests\s+across\s+(\d+)\s+suites/gi, 1, 2], // "N tests across M suites"
  [/(\d[\d,]*)\s+tests\s+passing\s+across\s+(\d+)\s+suites/gi, 1, 2], // ROADMAP banner
  [/(\d+)\s+suites\s*\/\s*(\d[\d,]*)\s+tests/gi, 2, 1], // "M suites / N tests"
  [/(\d[\d,]*)\s+tests,\s+(\d+)\s+suites/gi, 1, 2], // "N tests, M suites"
  [/(\d+)\s+workspace\s+packages,\s+(\d[\d,]*)\s+tests/gi, 2, null], // "62 workspace packages, N tests"
  [/live\s+(\d[\d,]*)\s+tests\s*\/\s*(\d+)\s+suites/gi, 1, 2], // "live N tests / M suites"
];

const num = (s) => Number(String(s).replaceAll(',', ''));

function liveCounts() {
  const raw = execSync('node --experimental-vm-modules node_modules/jest/bin/jest.js --json --silent', {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  return { tests: json.numTotalTests, suites: json.numTotalTestSuites };
}

const { tests, suites } = liveCounts();
console.log(`live suite: ${tests} tests / ${suites} suites`);

const errors = [];
for (const doc of DOCS) {
  let text;
  try {
    text = readFileSync(doc, 'utf8');
  } catch {
    continue; // a doc may not exist; skip rather than fail
  }
  for (const [re, tg, sg] of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (tg !== null && num(m[tg]) !== tests) {
        errors.push(`${doc}: "${m[0].trim()}" — test count ${num(m[tg])} ≠ live ${tests}`);
      }
      if (sg !== null && num(m[sg]) !== suites) {
        errors.push(`${doc}: "${m[0].trim()}" — suite count ${num(m[sg])} ≠ live ${suites}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`\n✗ STALE COUNTS — a number in the repo's own voice is a hallucination:`);
  for (const e of errors) console.error(`  ${e}`);
  console.error(`\nUpdate the docs to ${tests} tests / ${suites} suites, or re-run after fixing.`);
  process.exit(1);
}
console.log(`✓ all doc count-claims match the live suite (${tests}/${suites})`);
