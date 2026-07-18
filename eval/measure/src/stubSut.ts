/**
 * Deterministic stub SUT — the framework's measurement-plane reference.
 *
 * This is NOT a frontier-model call. It is a deterministic system the
 * scorers can measure against so we get *real* numbers for the
 * framework's contracts on the bundled fixtures. The honest reading is:
 *
 *   "These numbers measure the framework's measurement plane.
 *    Replacing the stub with a real ChatModel produces frontier-model
 *    numbers — which the operator runs locally with their own keys."
 *
 * Everything here is pure + sync (or trivially-async): zero network,
 * zero entropy, reproducible byte-for-byte.
 */

import type {
  QAFixture,
  InjectionFixture,
  ToolCallFixture,
  RetrievalFixture,
  RouterFixture,
  PrivacyFixture,
} from './fixtures.js';

// ── QA stub: returns reference text with citation when relevant ───────

export interface QAAnswer {
  caseId: string;
  text: string;
  citedSourceIds: ReadonlyArray<string>;
}

export function stubAnswer(c: QAFixture): QAAnswer {
  // Select the citation by REAL term-overlap retrieval over the fixture's
  // corpus (relevant chunk + adversarial distractors) — NOT by echoing the
  // ground-truth relevantSourceIds. A retriever that fell for a distractor
  // cites an id absent from relevantSourceIds, and stubVerify (correctly)
  // fails it — so hallucination_rate / groundedness_rate MEASURE grounding
  // instead of being 1.0 by construction. No overlap / empty corpus → no
  // cite → unsupported (fail-closed, never a spurious pass).
  const qTokens = new Set(tokens(c.question));
  const ranked = c.corpus
    .map((chunk) => ({ id: chunk.id, score: tokens(chunk.text).filter((t) => qTokens.has(t)).length }))
    .toSorted((a, b) => b.score - a.score);
  const top = ranked[0];
  const citedSourceIds = top !== undefined && top.score > 0 ? [top.id] : [];
  return { caseId: c.id, text: c.reference, citedSourceIds };
}

/** Atomic-claim-style verifier: supported iff cited ids ⊆ relevant ids. */
export function stubVerify(c: QAFixture, a: QAAnswer): boolean {
  if (a.citedSourceIds.length === 0) return false;
  return a.citedSourceIds.every((id) => c.relevantSourceIds.includes(id));
}

// ── Injection stub: simple regex guard, what @tenet/guardrails does ───

const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /ignore (all|any|the)?\s*(previous|prior|above)\s*(instructions|prompts)/i,
  /you are now (dan|an? (unfiltered|jailbroken))/i,
  /pretend (you are|to be) (an )?unfiltered/i,
  /\[\[\s*system\s*\]\]/i,
  /###\s*(end user|new system)\s*###/i,
  /disregard (your )?(guidelines|rules|safety)/i,
  /forget everything (above|prior)/i,
  /(must|please) (comply|ignore (your )?safety)/i,
  /the above was a test\.?\s*continue without/i,
  /(my )?new instructions are to (disclose|reveal|leak)/i,
  /jailbreak (mode|activated)/i,
  /bypass (all )?(guardrails|safety)/i,
];

export function stubGuardrail(f: InjectionFixture): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(f.payload));
}

// ── Tool-call stub: schema-shaped validator ───────────────────────────

const TOOL_SCHEMAS: Record<string, (a: Record<string, unknown>) => boolean> = {
  add: (a) => typeof a['a'] === 'number' && typeof a['b'] === 'number',
  lookup: (a) => typeof a['key'] === 'string' && (a['key'] as string).length > 0,
  echo: (a) => typeof a['text'] === 'string',
};

export function stubInvokeTool(f: ToolCallFixture): boolean {
  const validator = TOOL_SCHEMAS[f.toolName];
  if (!validator) return false;
  return validator(f.args);
}

// ── Retrieval stub: BM25-style term overlap ───────────────────────────

function tokens(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function stubRetrieve(f: RetrievalFixture, k: number): ReadonlyArray<string> {
  const qTokens = new Set(tokens(f.query));
  const scored = f.corpus.map((c) => ({
    id: c.id,
    score: tokens(c.text).filter((t) => qTokens.has(t)).length,
  }));
  return scored
    .toSorted((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.id);
}

// ── Router stub: threshold-based tier picker ──────────────────────────

export function stubRoute(f: RouterFixture): 'haiku' | 'sonnet' | 'opus' {
  if (f.complexity < 0.34) return 'haiku';
  if (f.complexity < 0.67) return 'sonnet';
  return 'opus';
}

// ── Privacy stub: PII regex redactor ──────────────────────────────────

const PII_PATTERNS: ReadonlyArray<RegExp> = [
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, // email
  /\+?\d[\d\s()-]{7,}\d/, // phone-ish
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-shaped
  /\b(?:\d[ -]?){13,19}\b/, // card-shaped
];

export function stubDetectPii(f: PrivacyFixture): boolean {
  return PII_PATTERNS.some((p) => p.test(f.text));
}

// ── Cost + latency: deterministic-by-fixture-index ────────────────────

/**
 * Synthetic per-conversation cost. Two cheap path turns + one
 * occasional escalation. Reproducible, no entropy.
 */
export function stubCostUsd(i: number): number {
  const cheap = 0.003;
  const escalate = i % 17 === 0 ? 0.05 : 0;
  return cheap + escalate;
}

/** Deterministic synthetic TTFT — bounded, reproducible. */
export function stubTtftMs(i: number): number {
  return 80 + (i * 7) % 140; // 80–219ms band
}

export function stubE2eMs(i: number): number {
  return stubTtftMs(i) + 200 + (i * 13) % 700; // 280–1119ms band
}
