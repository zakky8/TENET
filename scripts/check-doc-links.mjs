#!/usr/bin/env node
/**
 * Internal doc-link gate — every relative markdown link must resolve to a file
 * that exists.
 *
 * A link to a doc that isn't there is the repo referencing something that
 * doesn't exist — a stale reference in its own voice, the same §9 defect class
 * as a stale number. This scans every tracked `.md` file, extracts relative
 * links, and FAILS (exit 1) on any whose target file is missing.
 *
 * Correctness details:
 *   - Code is stripped BEFORE extraction — fenced blocks (``` … ```) and inline
 *     spans (` … `) — so an illustrative `[label](url)` inside code is not
 *     mistaken for a real link.
 *   - External links (`http(s):`, `mailto:`) and pure anchors (`#foo`) are
 *     skipped; a trailing `#anchor` / `?query` is stripped from a path.
 *   - Jekyll authors `.html` links from `.md` sources, so a `.html` target also
 *     resolves if the sibling `.md` exists.
 *
 * Usage: `node scripts/check-doc-links.mjs`  (or `pnpm links:check`)
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

const files = execSync('git ls-files "*.md"', { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const LINK = /\[[^\]]*\]\(([^)]+)\)/g;

let broken = 0;
let checked = 0;
for (const f of files) {
  const raw = readFileSync(f, 'utf8');
  // Strip fenced code first, then inline code, so links inside code are ignored.
  const text = raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const base = dirname(f);
  for (const m of text.matchAll(LINK)) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|#)/i.test(target)) continue; // external / anchor-only
    target = target.split('#')[0].split('?')[0]; // drop anchor + query
    if (target === '') continue;
    checked++;
    const candidates = [target];
    if (target.endsWith('.html')) candidates.push(target.replace(/\.html$/, '.md'));
    if (!candidates.some((c) => existsSync(resolve(base, c)))) {
      console.error(`✗ ${f}: link target does not exist — [..](${m[1].trim()})`);
      broken++;
    }
  }
}

console.log(`checked ${checked} relative link(s) across ${files.length} markdown file(s)`);
if (broken > 0) {
  console.error(`\n${broken} broken internal link(s) — a reference to a file that isn't there is a hallucination in the repo's own voice.`);
  process.exit(1);
}
console.log('✓ all internal doc links resolve');
