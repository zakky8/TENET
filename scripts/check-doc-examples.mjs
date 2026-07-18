#!/usr/bin/env node
/**
 * Doc-example IMPORT/EXPORT + typed-value API-DRIFT gate.
 *
 * A ```ts example in a README/doc that imports a `@tenet/*` export that no longer
 * exists, or misuses an imported/constructed TYPED value, is stale code in the
 * repo's own voice — a hallucination an operator copies. Only
 * `apps/measure-real/README.md` was compile-gated (by `readme:check`); every other
 * illustrative fence shipped un-checked.
 *
 * This gate compile-checks EVERY ts fence in the tracked package READMEs + docs
 * against the built `dist/*.d.ts` of every `@tenet/*` package, and FAILS (exit 1)
 * on an API-DRIFT type error. Because these fences are ILLUSTRATIVE (they reference
 * undeclared context vars and import external packages), it filters to a curated
 * set of DRIFT-only error codes and IGNORES illustrative noise (cannot-find-name,
 * external modules, implicit-any glue, top-level-return/await wrapping).
 *
 * WHAT IT CATCHES (proven non-vacuous):
 *   - IMPORT/EXPORT drift — a fence importing a renamed/removed `@tenet/*` export
 *     (TS2305 / TS2724). This fires regardless of how the symbol is used.
 *   - SHAPE drift on a TYPED value — a wrong constructor arg, or a bad field on an
 *     object passed to an imported/constructed value (e.g. `new AnthropicChatModel(
 *     wrongArgs)`), since the type flows from the import.
 *
 * KNOWN GAP (documented follow-up in .upgrade/PLAN.md): a method call on an
 * UNDECLARED illustrative context var — e.g. refine's `model.chat({ … })` where
 * `model` is undeclared — is typed `any`, so its argument shape is NOT checked.
 * Catching that class needs a per-README declare-sidecar (`declare const model:
 * ChatModel; …`) that types the context; this gate deliberately does not guess
 * those types (a wrong guess would false-FAIL a valid example). Until then, that
 * class is caught only by the manual audit / `readme:check`'s self-contained target.
 *
 * Requires the workspace BUILT first (the imported packages' dist `.d.ts` must
 * exist) — run after `pnpm -r build`, like `readme:check`.
 *
 * Usage: `node scripts/check-doc-examples.mjs`  (or `pnpm examples:check`)
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = process.cwd();

// `apps/measure-real/README.md` is owned by readme:check (full compile); CHANGELOG
// records historical/old API examples verbatim and must not trip the gate.
const DENY = new Set(['docs/CHANGELOG.md', 'apps/measure-real/README.md']);

// API-DRIFT codes only — the example names something the real API does not have/want.
// Everything else (TS2304 cannot-find-name, TS2307 external module, TS70xx implicit-any,
// TS1xxx parse/wrap artifacts, TS25xx possibly-undefined) is illustrative noise, ignored.
const DRIFT =
  /error (TS2353|TS2554|TS2555|TS2559|TS2769|TS2345|TS2739|TS2741|TS2740|TS2339|TS2551|TS2305|TS2724):/;

const FENCE = /```(?:ts|typescript)\r?\n([\s\S]*?)```/g;

/** Every @tenet/* package with a built dist barrel → its .d.ts (absolute). */
function buildPathsMap() {
  const pkgs = execSync('git ls-files', { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((f) => f.endsWith('/package.json'));
  const paths = {};
  for (const pj of pkgs) {
    let name;
    try {
      name = JSON.parse(readFileSync(pj, 'utf8')).name;
    } catch {
      continue;
    }
    const dts = pj.replace(/\/package\.json$/, '/dist/index.d.ts');
    if (typeof name === 'string' && name.startsWith('@tenet/') && existsSync(dts)) {
      paths[name] = [join(REPO, dts)];
    }
  }
  return paths;
}

/** Tracked *.md carrying a ts fence, minus the denylist. */
function gatedDocs() {
  return execSync('git ls-files', { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((f) => f.endsWith('.md') && !DENY.has(f) && !f.includes('/dist/'))
    .filter((f) => /```(?:ts|typescript)/.test(readFileSync(f, 'utf8')));
}

const pathsMap = buildPathsMap();
if (Object.keys(pathsMap).length === 0) {
  console.error('✗ no @tenet/* dist barrels found — run `pnpm -r build` first');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'tenet-docex-'));
const tsconfig = join(tmp, 'tsconfig.json');
writeFileSync(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: true,
      lib: ['ES2024', 'DOM'],
      baseUrl: tmp,
      paths: pathsMap,
    },
    include: ['CHECK.ts'],
  }),
);
const tscBin = join(REPO, 'node_modules/typescript/bin/tsc');

let checked = 0;
let failed = 0;
for (const doc of gatedDocs()) {
  const fences = [...readFileSync(doc, 'utf8').matchAll(FENCE)].map((m) => m[1]);
  fences.forEach((body, i) => {
    checked++;
    // Hoist imports to module top; wrap the rest in an async fn (fences use top-level
    // `return`/`await` that are illegal at module scope). A wrap that mis-parses only
    // yields TS1xxx, which the DRIFT filter ignores — so it can never false-FAIL.
    const lines = body.split('\n');
    const imports = lines.filter((l) => /^\s*import\s/.test(l)).join('\n');
    const rest = lines.filter((l) => !/^\s*import\s/.test(l)).join('\n');
    writeFileSync(join(tmp, 'CHECK.ts'), `${imports}\nasync function __fence${i}() {\n${rest}\n}\n`);
    let out = '';
    try {
      execFileSync(process.execPath, [tscBin, '-p', tsconfig], {
        cwd: tmp,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    const drift = out.split('\n').filter((l) => DRIFT.test(l));
    if (drift.length > 0) {
      failed++;
      console.error(`✗ ${doc} (ts fence #${i + 1}) — a code example names something the real API does not have:`);
      for (const l of drift) console.error(`   ${l.replace(/^CHECK\.ts/, 'fence').trim()}`);
    }
  });
}
rmSync(tmp, { recursive: true, force: true });

console.log(`checked ${checked} ts fence(s) across ${gatedDocs().length} gated doc(s)`);
if (checked === 0) {
  console.error('✗ no ts fences found in the gated docs — the gate matched nothing');
  process.exit(1);
}
if (failed > 0) {
  console.error(`\n${failed} doc example(s) drifted from the real API — a stale example is a hallucination in the repo's own voice.`);
  console.error('Fix the example to match the current API (or fix the export it names).');
  process.exit(1);
}
console.log(`✓ all ${checked} doc ts fence(s) match the real API (no drift-class type errors)`);
