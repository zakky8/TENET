/**
 * Deterministic pre-check tier — runs BEFORE the LLM judges.
 *
 * Three-way verdicts:
 *   'pass'  — claim is grounded by construction; skip the judges
 *   'fail'  — claim contains hard evidence of fabrication; skip the
 *             judges, final (the permissive judge cannot rescue it)
 *   'judge' — no deterministic signal either way; normal judge path
 *
 * Why this tier exists:
 *   - Speed + cost: every deterministically settled claim is one less
 *     judge call (often two — strict then permissive).
 *   - Accuracy: LLM judges themselves mis-verify numbers ("$1.2M" vs
 *     "$1.5M" reads as plausible). String/numeric comparison does not.
 *
 * Soundness rules (why pass/fail are asymmetric):
 *   - A number PRESENT in sources does NOT make a claim supported (it
 *     could be misattributed) → presence never passes, only defers.
 *   - A number ABSENT from sources IS fabrication evidence → fail.
 *   - A claim that is (almost entirely) a verbatim span of the sources
 *     cannot assert anything the sources don't → pass.
 */

export type PreCheckVerdict = 'pass' | 'fail' | 'judge';

export interface PreCheckResult {
  verdict: PreCheckVerdict;
  /** Populated on 'fail' — becomes the claim verdict's reason. */
  reason?: string;
}

export interface ClaimPreCheck {
  check(claim: string, sources: string): PreCheckResult;
}

// ── Numeric fabrication ───────────────────────────────────────────────

/**
 * Extract comparable numeric values from text. Handles thousands
 * separators (1,000), decimals, percent signs, currency prefixes, and
 * magnitude suffixes (5k / 1.2M / 3B). Returns canonical values so
 * "1,000" in a claim matches "1000" in sources and "1.2M" matches
 * "1200000" / "1,200,000".
 */
export function extractNumericValues(text: string): number[] {
  const out: number[] = [];
  const re = /(?<![\w.])[$€£]?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(k|K|m|M|b|B|%)?(?![\w])/g;
  for (const m of text.matchAll(re)) {
    const intPart = m[1]!.replaceAll(',', '');
    const frac = m[2] ?? '';
    let value = Number.parseFloat(intPart + frac);
    const suffix = m[3];
    if (suffix === 'k' || suffix === 'K') value *= 1_000;
    else if (suffix === 'm' || suffix === 'M') value *= 1_000_000;
    else if (suffix === 'b' || suffix === 'B') value *= 1_000_000_000;
    // '%' is not a magnitude — the bare value is what must match.
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

export interface NumericFabricationOptions {
  /**
   * Relative tolerance when comparing claim values to source values.
   * Default 0 (exact). Set e.g. 0.005 to let "3.14" match "3.14159".
   */
  relativeTolerance?: number;
}

/**
 * Fail any claim containing a numeric value that appears NOWHERE in
 * the sources. Claims without numbers, or whose numbers all appear,
 * defer to the judges.
 */
export function numericFabricationCheck(
  opts: NumericFabricationOptions = {},
): ClaimPreCheck {
  const tol = opts.relativeTolerance ?? 0;
  if (tol < 0) throw new Error('relativeTolerance must be >= 0');
  return {
    check(claim, sources) {
      const claimValues = extractNumericValues(claim);
      if (claimValues.length === 0) return { verdict: 'judge' };
      const sourceValues = extractNumericValues(sources);
      const matches = (v: number): boolean =>
        sourceValues.some((s) => {
          if (s === v) return true;
          if (tol === 0) return false;
          const denom = Math.max(Math.abs(s), Math.abs(v));
          return denom > 0 && Math.abs(s - v) / denom <= tol;
        });
      const missing = claimValues.filter((v) => !matches(v));
      if (missing.length === 0) return { verdict: 'judge' };
      return {
        verdict: 'fail',
        reason: `numeric value(s) not present in any source: ${missing.join(', ')}`,
      };
    },
  };
}

// ── Quote grounding ───────────────────────────────────────────────────

export interface QuoteGroundingOptions {
  /** Minimum quoted-span length (chars) to consider. Default 20. */
  minQuoteChars?: number;
  /**
   * The quote must cover at least this fraction of the claim's length
   * for an auto-pass — prevents passing a long fabricated claim that
   * embeds one short real quote. Default 0.6.
   */
  minCoverage?: number;
}

/** Collapse whitespace + normalize curly quotes for span comparison. */
function normalizeForMatch(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

/**
 * Pass claims that are essentially a verbatim quote of the sources:
 * the claim contains a quoted span ("...", '...', or curly equivalents)
 * that (a) is long enough, (b) appears verbatim in the sources after
 * whitespace normalization, and (c) covers most of the claim.
 */
export function quoteGroundingCheck(opts: QuoteGroundingOptions = {}): ClaimPreCheck {
  const minQuoteChars = opts.minQuoteChars ?? 20;
  const minCoverage = opts.minCoverage ?? 0.6;
  if (minQuoteChars <= 0) throw new Error('minQuoteChars must be > 0');
  if (minCoverage <= 0 || minCoverage > 1) throw new Error('minCoverage must be in (0,1]');
  return {
    check(claim, sources) {
      const normClaim = normalizeForMatch(claim);
      const normSources = normalizeForMatch(sources);
      const quoteRe = /["“]([^"“”]{1,2000})["”]|['‘]([^'‘’]{1,2000})['’]/g;
      for (const m of normClaim.matchAll(quoteRe)) {
        const quote = (m[1] ?? m[2] ?? '').trim();
        if (quote.length < minQuoteChars) continue;
        if (quote.length / normClaim.length < minCoverage) continue;
        if (normSources.includes(quote)) return { verdict: 'pass' };
      }
      return { verdict: 'judge' };
    },
  };
}

// ── Composition ───────────────────────────────────────────────────────

/**
 * The recommended deterministic tier: quote grounding (pass) +
 * numeric fabrication (fail). Order matters — a verbatim quote
 * containing a number the sources state is settled by the quote check
 * first; runPreChecks() short-circuits on the first non-'judge'.
 */
export function defaultPreChecks(): ClaimPreCheck[] {
  return [quoteGroundingCheck(), numericFabricationCheck()];
}

/** First non-'judge' verdict wins; all-'judge' defers to the LLM path. */
export function runPreChecks(
  checks: ReadonlyArray<ClaimPreCheck>,
  claim: string,
  sources: string,
): PreCheckResult {
  for (const c of checks) {
    const r = c.check(claim, sources);
    if (r.verdict !== 'judge') return r;
  }
  return { verdict: 'judge' };
}
