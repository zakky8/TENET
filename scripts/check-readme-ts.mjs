#!/usr/bin/env node
/**
 * README fenced-TypeScript gate.
 *
 * A usage example in a README that no longer COMPILES against the real
 * package API is stale code in the repo's own voice — a hallucination an
 * operator will copy and be misled by. This gate extracts every ```ts /
 * ```typescript block from each tracked README, writes it into the owning
 * package's `examples/` dir (so workspace `@tenet/*` imports and ESM
 * top-level `await` resolve exactly as an operator's copy would), and
 * typechecks it with `tsc --noEmit`. It FAILS (exit 1) the moment a README
 * example drifts from the API it documents.
 *
 * Requires the workspace to be BUILT first (the imported packages' dist
 * `.d.ts` must exist) — run it after `pnpm -r build`, like `counts:check`.
 *
 * Usage: `node scripts/check-readme-ts.mjs`  (or `pnpm readme:check`)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

// Each target: a README, an in-package tsconfig whose `include` covers the
// temp snippet, and the snippet path (must NOT start with '.', or tsc's
// include globbing skips it). The snippet path is git-ignored.
const TARGETS = [
  {
    readme: 'apps/measure-real/README.md',
    tsconfig: 'apps/measure-real/tsconfig.examples.json',
    snippet: 'apps/measure-real/examples/__readme_check__.ts',
  },
];

const FENCE = /```(?:ts|typescript)\r?\n([\s\S]*?)```/g;

let failed = false;
for (const t of TARGETS) {
  const md = readFileSync(t.readme, 'utf8');
  const blocks = [...md.matchAll(FENCE)].map((m) => m[1]);
  if (blocks.length === 0) {
    console.log(`• ${t.readme}: no ts fences — skipped`);
    continue;
  }
  // Multiple fences share one module scope; a README that re-imports the
  // same symbol across blocks would need per-block checking (none do yet).
  writeFileSync(t.snippet, blocks.join('\n\n'));
  try {
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', t.tsconfig], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`✓ ${t.readme}: ${blocks.length} ts fence(s) typecheck against the real API`);
  } catch (e) {
    failed = true;
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    console.error(`\n✗ ${t.readme}: fenced TypeScript does NOT compile:`);
    for (const line of out.split('\n')) {
      if (line.includes('__readme_check__') || line.trim().startsWith('error')) {
        console.error(`  ${line.trim()}`);
      }
    }
  } finally {
    rmSync(t.snippet, { force: true });
  }
}

if (failed) {
  console.error(
    `\nA README code example must compile against the real API — fix the example (or the export it names).`,
  );
  process.exit(1);
}
console.log('✓ all README ts fences compile against the real API');
