#!/usr/bin/env node
/**
 * JSON-LD validity gate.
 *
 * Structured data is machine-readable content the repo emits in its own
 * voice — a malformed, empty, or mistyped `application/ld+json` block is a
 * broken promise to crawlers (no rich result) shipped silently, the same
 * class of defect as a stale number. This parses every JSON-LD block in the
 * tracked docs and FAILS (exit 1) on a parse error, a wrong `@context`, a
 * missing `@type`, or a `FAQPage` without a non-empty `mainEntity`.
 *
 * Usage: `node scripts/check-jsonld.mjs`  (or `pnpm jsonld:check`)
 */
import { readFileSync } from 'node:fs';

const DOCS = ['docs/index.md', 'docs/FAQ.md'];
const BLOCK = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

let errors = 0;
let blocks = 0;

for (const doc of DOCS) {
  let text;
  try {
    text = readFileSync(doc, 'utf8');
  } catch {
    continue; // a doc may not exist yet; skip rather than fail
  }
  for (const m of text.matchAll(BLOCK)) {
    blocks++;
    let obj;
    try {
      obj = JSON.parse(m[1]);
    } catch (e) {
      console.error(`✗ ${doc}: JSON-LD does not parse — ${e.message}`);
      errors++;
      continue;
    }
    if (obj['@context'] !== 'https://schema.org') {
      console.error(`✗ ${doc}: JSON-LD @context must be "https://schema.org"`);
      errors++;
    }
    if (typeof obj['@type'] !== 'string' || obj['@type'] === '') {
      console.error(`✗ ${doc}: JSON-LD is missing a non-empty string @type`);
      errors++;
    }
    if (obj['@type'] === 'FAQPage') {
      if (!Array.isArray(obj.mainEntity) || obj.mainEntity.length === 0) {
        console.error(`✗ ${doc}: FAQPage is missing a non-empty mainEntity array`);
        errors++;
      } else {
        for (const q of obj.mainEntity) {
          const answer = q?.acceptedAnswer?.text;
          if (typeof q?.name !== 'string' || typeof answer !== 'string' || answer.trim() === '') {
            console.error(`✗ ${doc}: a FAQPage Question is missing a name or a non-blank acceptedAnswer.text`);
            errors++;
            break;
          }
        }
      }
    }
  }
}

if (blocks === 0) {
  console.error('✗ no JSON-LD blocks found in the tracked docs — AEO structured data missing');
  process.exit(1);
}
if (errors > 0) {
  console.error(`\n${errors} JSON-LD error(s) — structured data must be valid to earn a rich result.`);
  process.exit(1);
}
console.log(`✓ ${blocks} JSON-LD block(s) valid (parse + @context + @type + FAQPage shape)`);
