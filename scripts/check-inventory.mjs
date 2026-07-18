#!/usr/bin/env node
/**
 * Inventory gate — the docs' surface/model *adapter counts* AND the total
 * *workspace-package count* must equal the filesystem.
 *
 * A structural count in the repo's own voice ("9 surface adapters", "6 model
 * adapters", "63 workspace packages") is held to §1 like any other claim: the
 * ONLY witness is the tree. This drift is real — `AGENTS.md` once said
 * "Surfaces (12)" while `ls surfaces/` was 9 — exactly the class `counts:check`
 * prevents for the test count. This computes the live counts from `surfaces/`
 * and `models/`, and the workspace-package total from `pnpm-workspace.yaml`'s
 * own globs (so a newly-added top-level glob is counted automatically), and
 * FAILS (exit 1) on any doc whose count claim disagrees, across the digit
 * phrasings the docs actually use.
 *
 * `docs/CHANGELOG.md` is EXCLUDED — it records historical/old counts verbatim
 * (e.g. documenting the "Surfaces (12)"→9 fix), which must not trip the gate.
 * Spelled-out forms ("Six model adapters") are not matched; the docs use digits.
 *
 * Usage: `node scripts/check-inventory.mjs`  (or `pnpm inventory:check`)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const subdirs = (p) =>
  readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

// Live workspace-package count. The source of truth is pnpm-workspace.yaml's
// globs — NOT a hardcoded dir list — so adding a new top-level workspace glob
// is reflected automatically. Each glob is either `DIR/*` (count DIR's
// package.json-bearing subdirs) or a literal path (count 1 if it holds one).
function workspacePackageCount() {
  const ws = readFileSync('pnpm-workspace.yaml', 'utf8');
  const globs = [];
  let inPackages = false;
  for (const line of ws.split(/\r?\n/)) {
    if (/^packages:\s*(#.*)?$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s+-\s*['"]?([^'"#\s]+)['"]?/);
    if (item) {
      globs.push(item[1]);
      continue;
    }
    if (/^\S/.test(line)) break; // dedent to the next top-level key ends the list
  }
  if (globs.length === 0) {
    // Fail closed: an unparseable workspace file must not silently yield 0.
    console.error('✗ could not parse any workspace globs from pnpm-workspace.yaml');
    process.exit(1);
  }
  let count = 0;
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const parent = g.slice(0, -2);
      try {
        for (const name of subdirs(parent)) {
          if (existsSync(join(parent, name, 'package.json'))) count++;
        }
      } catch {
        /* a globbed parent dir may not exist yet → contributes 0 */
      }
    } else if (existsSync(join(g, 'package.json'))) {
      count++;
    }
  }
  return count;
}

// The live inventory — the only witness. `surfaces/core` is shared infra
// (the de-forked JWT verifier + grounded render gate), NOT a surface adapter,
// so it is excluded from the adapter count the docs state.
const surfaceAdapters = subdirs('surfaces').filter((n) => n !== 'core');
const modelAdapters = subdirs('models');
const actual = {
  surface: surfaceAdapters.length,
  model: modelAdapters.length,
  vectorstore: subdirs('stores/vector').length,
  packages: workspacePackageCount(),
};
const LABELS = {
  surface: 'surface adapter',
  model: 'model adapter',
  vectorstore: 'vector store',
  packages: 'workspace package',
};

// Docs that state adapter counts. CHANGELOG excluded (see header).
const DOCS = [
  'README.md',
  'AGENTS.md',
  'docs/index.md',
  'docs/FAQ.md',
  'docs/ARCHITECTURE.md',
  'docs/ROADMAP.md',
  'docs/marketing/LAUNCH-COPY.md',
  'docs/marketing/AWESOME-LIST-SUBMISSIONS.md',
  'llms.txt',
  'llms-full.txt',
];

// Canonical digit phrasings the docs use → the count each asserts.
const PATTERNS = [
  { kind: 'surface', re: /(\d+)\s+surface adapters/gi },
  { kind: 'surface', re: /(\d+)\s+surfaces\b/gi },
  { kind: 'surface', re: /surfaces\s*\((\d+)(?:\s+adapters)?\)/gi },
  { kind: 'model', re: /(\d+)\s+model adapters/gi },
  { kind: 'model', re: /models\s*\((\d+)\)/gi },
  { kind: 'vectorstore', re: /(\d+)\s+vector stores?/gi },
  { kind: 'packages', re: /(\d+)\s+workspace packages/gi },
];

let errors = 0;
let checked = 0;
for (const doc of DOCS) {
  let text;
  try {
    text = readFileSync(doc, 'utf8');
  } catch {
    continue; // a doc may not exist; skip rather than fail
  }
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      checked++;
      const claimed = Number(m[1]);
      if (claimed !== actual[kind]) {
        console.error(`✗ ${doc}: "${m[0].trim()}" — ${LABELS[kind]} count ${claimed} ≠ live ${actual[kind]}`);
        errors++;
      }
    }
  }
}

console.log(
  `live inventory: ${actual.surface} surface adapters / ${actual.model} model adapters / ${actual.vectorstore} vector stores / ${actual.packages} workspace packages`,
);
if (checked === 0) {
  console.error('✗ no inventory-count claims found in the tracked docs — the gate matched nothing');
  process.exit(1);
}
if (errors > 0) {
  console.error(`\n${errors} stale inventory count(s) — a wrong structural count is a hallucination in the repo's own voice.`);
  console.error('Update the docs to match the live inventory above, or re-run after fixing.');
  process.exit(1);
}
console.log(`✓ all ${checked} inventory-count claim(s) match the live inventory`);
