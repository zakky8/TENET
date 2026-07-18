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

interface NumericToken {
  value: number;
  /** True if the number carried a currency symbol or trailing %. */
  marked: boolean;
}

const MAGNITUDE: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12,
};

/**
 * Mask spans that look like dates, clock times, or numeric ranges so
 * they are NOT extracted as plain values. These need structural
 * comparison the sources routinely phrase differently ("2025-01-15"
 * vs "January 15, 2025", "3:30pm" vs "15:30", "$1-2M" vs "between $1M
 * and $2M"), and treating their component digits as standalone facts
 * is the dominant source of numeric FALSE FAILS (Fable audit H2).
 */
function maskStructuralNumerics(text: string): string {
  return text
    // ISO-ish dates
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, ' ')
    .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, ' ')
    // clock times (optionally with am/pm)
    .replace(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?/gi, ' ')
    // numeric ranges
    .replace(/\d[\d.,]*\s*[-–—]\s*\d[\d.,]*\s*(?:k|m|b|t|bn|mn|tn|thousand|million|billion|trillion|%)?/gi, ' ');
}

// ── Spelled-out cardinals ─────────────────────────────────────────────
// A model that has learned the digit check exists can paraphrase a
// fabricated amount into words ("five hundred dollars" for "$500", "twenty
// percent" for "20%") to slip past it. These maps + parseSpelledNumbers
// close that gap. They feed the SAME extractNumericTokens used for BOTH
// claim and sources, so grounding stays symmetric and never false-fails a
// spelled amount the sources state in digits (or vice-versa).

const SPELLED_ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const SPELLED_TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SPELLED_SCALES: Record<string, number> = {
  hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12,
};
/**
 * Currency- or percent-marker WORDS. A spelled number immediately followed
 * by one of these is `marked` — the spelled analogue of a `$` prefix or a
 * trailing `%`, and (like those) the only spelled numbers that FAIL by
 * default. A bare spelled count ("five reasons") stays unmarked → defers.
 *
 * ONLY whole-unit markers. Sub-unit words (cent/cents/pence) are excluded on
 * purpose: this parser does not scale — "fifty cents" would read as 50, but
 * the grounded digit form "$0.50" reads as 0.5, so treating cents as a marker
 * would false-fail a correctly-grounded amount.
 */
const MARKER_WORDS = new Set<string>([
  'percent', 'pct',
  'dollar', 'dollars', 'usd', 'euro', 'euros', 'eur',
  'pound', 'pounds', 'gbp',
]);

function isSpelledNumberWord(w: string): boolean {
  return w in SPELLED_ONES || w in SPELLED_TENS || w in SPELLED_SCALES;
}

/**
 * Parse fully-spelled cardinal numbers ("five hundred", "twenty-five",
 * "one hundred and fifty thousand") into comparable tokens. Deliberately
 * conservative — when unsure it extracts NOTHING, which only ever defers to
 * the judge (never a false fail):
 *
 *   - a run must contain at least one ONES/TENS leaf word, so a bare scale
 *     ("hundred", "million" on its own) is NOT a number — matching the digit
 *     path, which ignores a magnitude word with no value in front of it;
 *   - "and" is absorbed ONLY between two number words ("one hundred and
 *     fifty"), never as a run starter, so ordinary prose "and" cannot merge
 *     two unrelated values;
 *   - `marked` is set only when a currency/percent WORD immediately follows
 *     the run, mirroring the digit path's marked-fails-by-default policy.
 */
function parseSpelledNumbers(text: string): NumericToken[] {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const out: NumericToken[] = [];
  let i = 0;
  while (i < words.length) {
    let current = 0;
    let result = 0;
    let hasLeaf = false;
    let consumed = false;
    let j = i;
    while (j < words.length) {
      const w = words[j]!;
      if (w in SPELLED_ONES) {
        current += SPELLED_ONES[w]!;
        hasLeaf = true;
        consumed = true;
        j++;
      } else if (w in SPELLED_TENS) {
        current += SPELLED_TENS[w]!;
        hasLeaf = true;
        consumed = true;
        j++;
      } else if (w === 'hundred') {
        current *= 100; // bare "hundred" (current 0) stays 0 → rejected by hasLeaf
        consumed = true;
        j++;
      } else if (w in SPELLED_SCALES) {
        result += current * SPELLED_SCALES[w]!;
        current = 0;
        consumed = true;
        j++;
      } else if (
        w === 'and' &&
        consumed &&
        j + 1 < words.length &&
        isSpelledNumberWord(words[j + 1]!)
      ) {
        j++; // absorb the connector, keep the run going
      } else {
        break;
      }
    }
    if (consumed && hasLeaf) {
      const value = result + current;
      const next = words[j];
      const marked = next !== undefined && MARKER_WORDS.has(next);
      if (Number.isFinite(value)) out.push({ value, marked });
      i = Math.max(j, i + 1);
    } else {
      i++;
    }
  }
  return out;
}

/**
 * Extract comparable numeric tokens from text. Handles thousands
 * separators, decimals, percent, currency prefixes, suffix magnitudes
 * (5k / 1.2M / 3B / 3.5bn) AND spelled magnitudes ("1.2 million"), so
 * a claim's "$1.2M" matches a source's "$1.2 million"; also fully-spelled
 * cardinals ("five hundred", "twenty percent") via parseSpelledNumbers,
 * so a claim's "five hundred dollars" matches a source's "$500". Date/
 * time/range spans are masked out first.
 */
function extractNumericTokens(text: string): NumericToken[] {
  const masked = maskStructuralNumerics(text);
  const out: NumericToken[] = [];
  // value, optional decimal, optional space, optional word/suffix magnitude.
  const re = /([$€£])?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(thousand|million|billion|trillion|bn|mn|tn|[kmbt])?\b(%)?/gi;
  for (const m of masked.matchAll(re)) {
    const currency = m[1];
    const intPart = m[2]!.replaceAll(',', '');
    const frac = m[3] ?? '';
    let value = Number.parseFloat(intPart + frac);
    const mag = m[4]?.toLowerCase();
    const pct = m[5];
    if (mag !== undefined && mag !== '') {
      const factor = MAGNITUDE[mag];
      if (factor !== undefined) value *= factor;
    }
    if (Number.isFinite(value)) {
      out.push({ value, marked: currency !== undefined || pct !== undefined });
    }
  }
  // Digit runs are consumed above; parseSpelledNumbers only matches word
  // cardinals (it requires a spelled leaf), so there is no double-count.
  out.push(...parseSpelledNumbers(masked));
  return out;
}

/**
 * Backwards-compatible value list (drops the marked flag). "1,000"
 * matches "1000"; "1.2M" / "1.2 million" both yield 1_200_000.
 */
export function extractNumericValues(text: string): number[] {
  return extractNumericTokens(text).map((t) => t.value);
}

export interface NumericFabricationOptions {
  /**
   * Relative tolerance when comparing claim values to source values.
   * Default 0 (exact). Set e.g. 0.005 to let "3.14" match "3.14159".
   */
  relativeTolerance?: number;
  /**
   * Also fail on bare (unmarked) numbers absent from sources. Default
   * false — bare integers collide with counts, IDs, versions and years
   * and produced most of the false-fail families in the Fable audit.
   * Leaving this off restricts deterministic FAILs to currency- and
   * percent-marked values, where wrong numbers do real damage and
   * paraphrase-to-words is rare. Bare numbers defer to the judges.
   */
  failBareNumbers?: boolean;
}

/**
 * Fail a claim that asserts a CURRENCY- or PERCENT-marked number which
 * appears nowhere in the sources — the high-confidence fabrication
 * signal ("$499" when the price is "$299", "87%" when uptime is
 * "99%"), including the spelled form ("five hundred dollars", "twenty
 * percent") a model might use to dodge the digit check. This verdict is
 * FINAL (no permissive rescue), so it is deliberately conservative:
 *
 *   - only marked numbers fail by default (failBareNumbers opts in);
 *   - date / time / range spans are masked out (structural, not facts);
 *   - source extraction understands spelled magnitudes and spelled
 *     cardinals, so "$1.2M" matches "$1.2 million" and "five hundred
 *     dollars" matches "$500" — a paraphrase to words does NOT false-fail.
 *
 * A number being PRESENT never PASSES the claim (it could be
 * misattributed) — presence only defers to the judges.
 */
export function numericFabricationCheck(
  opts: NumericFabricationOptions = {},
): ClaimPreCheck {
  const tol = opts.relativeTolerance ?? 0;
  if (tol < 0) throw new Error('relativeTolerance must be >= 0');
  const failBare = opts.failBareNumbers ?? false;
  return {
    check(claim, sources) {
      const claimTokens = extractNumericTokens(claim);
      const candidates = failBare ? claimTokens : claimTokens.filter((t) => t.marked);
      if (candidates.length === 0) return { verdict: 'judge' };
      const sourceValues = extractNumericValues(sources);
      const matches = (v: number): boolean =>
        sourceValues.some((s) => {
          if (s === v) return true;
          if (tol === 0) return false;
          const denom = Math.max(Math.abs(s), Math.abs(v));
          return denom > 0 && Math.abs(s - v) / denom <= tol;
        });
      const missing = candidates.filter((t) => !matches(t.value)).map((t) => t.value);
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
   * Max characters allowed in the claim OUTSIDE the matched quote (after
   * stripping quote marks, whitespace, and terminal punctuation) for an
   * auto-pass. Default 4 — effectively "the claim IS the quote".
   *
   * Why so strict (Fable audit H1): any non-trivial residue can negate
   * ("It is false that \"...\""), misattribute ("CompetitorX says
   * \"...\""), or extend ("\"...\" for 99% of users") the quote while
   * the span itself still matches a source verbatim. Attribution
   * clauses assert something only a judge can check — so we defer them
   * rather than auto-pass.
   */
  maxResidueChars?: number;
}

/** Collapse whitespace + normalize double curly quotes. Apostrophes are
 *  intentionally NOT normalized here — doing so let possessives bracket
 *  a fake "quote" (Fable audit M3). */
function normalizeForMatch(s: string): string {
  return s.replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}

/**
 * Pass claims that ARE a verbatim quote of the sources: the claim is a
 * double-quoted span that (a) is long enough, (b) appears verbatim in
 * the sources (whitespace-normalized), and (c) has only inert residue
 * outside the quote (≤ maxResidueChars of punctuation). Single quotes
 * are not treated as delimiters — too ambiguous with apostrophes.
 */
export function quoteGroundingCheck(opts: QuoteGroundingOptions = {}): ClaimPreCheck {
  const minQuoteChars = opts.minQuoteChars ?? 20;
  const maxResidueChars = opts.maxResidueChars ?? 4;
  if (minQuoteChars <= 0) throw new Error('minQuoteChars must be > 0');
  if (maxResidueChars < 0) throw new Error('maxResidueChars must be >= 0');
  return {
    check(claim, sources) {
      const normClaim = normalizeForMatch(claim);
      const normSources = normalizeForMatch(sources);
      const quoteRe = /"([^"]{1,2000})"/g;
      for (const m of normClaim.matchAll(quoteRe)) {
        // Trim terminal sentence punctuation the author put INSIDE the
        // quote marks but the source span doesn't carry.
        const quote = m[1]!.trim().replace(/[.,;:!?]+$/, '');
        if (quote.length < minQuoteChars) continue;
        if (!normSources.includes(quote)) continue;
        // Residue = claim minus this quoted span (incl. its marks),
        // stripped of whitespace and terminal punctuation. Must be inert.
        const residue = (normClaim.slice(0, m.index) + normClaim.slice(m.index + m[0].length))
          .replace(/[\s.,;:!?—–-]/g, '');
        if (residue.length <= maxResidueChars) return { verdict: 'pass' };
      }
      return { verdict: 'judge' };
    },
  };
}

// ── URL fabrication ───────────────────────────────────────────────────

// Deliberately requires an explicit http(s):// scheme so bare dotted tokens
// (`index.ts`, `Node.js`, `e.g.`, `package.json`) are NEVER mistaken for a URL —
// a false-fail on a non-URL would be worse than missing a schemeless link.
const SCHEMED_URL_RE = /https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)((?:\/[^\s)\]"'>]*)?)/gi;

/**
 * Fail a claim that cites an `http(s)://` URL which appears NOWHERE in the sources —
 * a fabricated link (the model invents a plausible-looking URL). This is TENET's
 * source-grounded-URL thesis enforced deterministically: an answer may only cite URLs
 * that came from its sources. FINAL (no permissive rescue), like numeric fabrication.
 *
 * Conservative by construction: only scheme-bearing URLs are checked, and grounding is a
 * scheme/`www`-insensitive substring match against the sources — so a claim URL that is a
 * parent/child path of a source URL still counts as grounded, and lookalike-domain misses
 * fall through to the judge rather than false-failing. A URL being PRESENT never PASSES a
 * claim (it could be misattributed) — presence only defers.
 */
export function urlFabricationCheck(): ClaimPreCheck {
  return {
    check(claim, sources) {
      const claimUrls = Array.from(claim.matchAll(SCHEMED_URL_RE)).map((m) => {
        const host = (m[1] ?? '').toLowerCase().replace(/^www\./, '');
        // Strip trailing slash AND terminal sentence punctuation the URL picked up at a
        // sentence end (`…/help.`) — otherwise it wouldn't match `…/help` in the sources.
        const path = (m[2] ?? '').replace(/[/.,;:!?]+$/, '');
        return host + path;
      });
      if (claimUrls.length === 0) return { verdict: 'judge' };
      const normSources = sources.toLowerCase().replace(/https?:\/\//g, '').replace(/www\./g, '');
      const fabricated = claimUrls.find((u) => u !== '' && !normSources.includes(u));
      if (fabricated !== undefined) {
        return { verdict: 'fail', reason: `URL not grounded in sources: ${fabricated}` };
      }
      return { verdict: 'judge' };
    },
  };
}

// ── Composition ───────────────────────────────────────────────────────

/**
 * The recommended deterministic tier: quote grounding (pass) + numeric fabrication
 * (fail) + URL fabrication (fail). Order matters — a verbatim quote containing a number
 * or URL the sources state is settled by the quote check first; runPreChecks()
 * short-circuits on the first non-'judge'.
 */
export function defaultPreChecks(): ClaimPreCheck[] {
  return [quoteGroundingCheck(), numericFabricationCheck(), urlFabricationCheck()];
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
