/**
 * @tenet/refine — answer-quality orchestration above the verifier.
 *
 * Four model-agnostic levers, composable independently:
 *
 *   1. knowledgeBoundaryGate — abstain BEFORE drafting when retrieval
 *      coverage is weak. The cheapest possible point to stop wrong
 *      info (no draft, no judges, no cost), and the honest answer when
 *      the knowledge base simply doesn't cover the question.
 *
 *   2. repairDraft — when verification fails, don't abstain wholesale:
 *      rewrite ONLY the unsupported claims and re-verify, bounded
 *      rounds. More useful answers, identical safety bar (the final
 *      draft still has to pass the full verifier).
 *
 *   3. bestOfN — sample N drafts in parallel, verify each, return the
 *      one with the highest supported-claim ratio. Buys answer quality
 *      from ANY model — including small/local ones — by spending
 *      parallel tokens instead of requiring a smarter model.
 *
 *   4. selfConsistency — claims that appear in most samples are
 *      stable; claims that flip between samples are confabulation
 *      signals (the SelfCheckGPT observation, applied at claim level).
 *
 * Everything takes injected functions; nothing here knows about a
 * specific provider.
 */

// ── Shared shapes (structural copies of @tenet/verifier results) ──────

export interface ClaimVerdictLike {
  claim: string;
  supported: boolean;
  reason: string;
}

export interface VerifyResultLike {
  pass: boolean;
  critique: string;
  verdicts: ReadonlyArray<ClaimVerdictLike>;
}

export interface DraftFn {
  (signal?: AbortSignal): Promise<string>;
}

export interface VerifyFn {
  (draft: string, signal?: AbortSignal): Promise<VerifyResultLike>;
}

export interface RewriteFn {
  (args: { draft: string; critique: string; signal?: AbortSignal }): Promise<string>;
}

// ── 1. Knowledge-boundary gate ────────────────────────────────────────

export interface RetrievalHitLike {
  /** Retrieval score — same scale the caller's retriever produces. */
  score: number;
}

export interface BoundaryGateOptions {
  /** Minimum hits required to attempt an answer. Default 1. */
  minHits?: number;
  /** The top hit must score at least this. Default 0 (disabled). */
  minTopScore?: number;
  /** Sum of all hit scores must reach this. Default 0 (disabled). */
  minTotalScore?: number;
}

export interface BoundaryDecision {
  proceed: boolean;
  reason: string;
}

/**
 * Decide whether the retrieved evidence is strong enough to draft at
 * all. Thresholds are in the caller's own score scale (BM25 scores,
 * cosine similarities, reranker scores — whatever the pipeline emits);
 * calibrate against your corpus with a handful of in/out-of-scope
 * probes.
 */
export function knowledgeBoundaryGate(
  hits: ReadonlyArray<RetrievalHitLike>,
  opts: BoundaryGateOptions = {},
): BoundaryDecision {
  const minHits = opts.minHits ?? 1;
  const minTopScore = opts.minTopScore ?? 0;
  const minTotalScore = opts.minTotalScore ?? 0;
  if (minHits < 0) throw new Error('minHits must be >= 0');

  if (hits.length < minHits) {
    return { proceed: false, reason: `retrieved ${hits.length} source(s), need ${minHits}` };
  }
  // Fail CLOSED: when a top-score floor is set, zero hits cannot clear
  // it (Fable audit M1 — the old `hits.length > 0` guard let an empty
  // hit list bypass the floor when minHits was 0).
  const top = hits.reduce((m, h) => Math.max(m, h.score), -Infinity);
  if (minTopScore > 0 && top < minTopScore) {
    return {
      proceed: false,
      reason: hits.length === 0
        ? `no sources; top-score floor ${minTopScore} unmet`
        : `top retrieval score ${top} below ${minTopScore}`,
    };
  }
  const total = hits.reduce((sum, h) => sum + h.score, 0);
  if (total < minTotalScore) {
    return { proceed: false, reason: `total retrieval score ${total} below ${minTotalScore}` };
  }
  return { proceed: true, reason: 'coverage ok' };
}

// ── 2. Claim repair loop ──────────────────────────────────────────────

export interface RepairOptions {
  /** Max rewrite rounds after the initial verification. Default 2. */
  maxRounds?: number;
  signal?: AbortSignal;
}

export interface RepairResult {
  draft: string;
  result: VerifyResultLike;
  /** 0 = passed on first verification, N = passed after N rewrites. */
  rounds: number;
  repaired: boolean;
}

/**
 * Verify a draft; on failure, hand the verifier's critique to the
 * rewrite function and re-verify, up to maxRounds. Returns the first
 * passing draft, or the LAST attempt (still failing) so the caller can
 * abstain with full diagnostics.
 *
 * The safety bar is unchanged: a repaired draft is only returned as
 * passing if the FULL verifier passes it.
 */
export async function repairDraft(
  initialDraft: string,
  verify: VerifyFn,
  rewrite: RewriteFn,
  opts: RepairOptions = {},
): Promise<RepairResult> {
  const maxRounds = opts.maxRounds ?? 2;
  if (maxRounds < 0) throw new Error('maxRounds must be >= 0');

  let draft = initialDraft;
  let result = await verify(draft, opts.signal);
  let rounds = 0;

  while (!result.pass && rounds < maxRounds) {
    if (opts.signal?.aborted) break;
    draft = await rewrite({
      draft,
      critique: result.critique,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    result = await verify(draft, opts.signal);
    rounds++;
  }

  return { draft, result, rounds, repaired: rounds > 0 && result.pass };
}

// ── 3. Best-of-N verifier-ranked selection ────────────────────────────

export interface ScoredDraft {
  draft: string;
  result: VerifyResultLike;
  /** supported claims / total claims; 1 for claim-free passing drafts. */
  supportRatio: number;
  index: number;
}

export interface BestOfNOptions {
  signal?: AbortSignal;
}

export interface BestOfNResult {
  best: ScoredDraft;
  all: ScoredDraft[];
}

function scoreOf(result: VerifyResultLike): number {
  if (result.verdicts.length === 0) return result.pass ? 1 : 0;
  return result.verdicts.filter((v) => v.supported).length / result.verdicts.length;
}

/**
 * Run every draft function in parallel, verify each draft, and pick
 * the winner: highest supported-claim ratio, ties broken by passing
 * the verifier, then by more total supported claims (richer answer).
 *
 * Cost model: N drafts + N verifications, all parallel — wall-clock is
 * ~one round-trip more than a single draft, spend is N×. Use N=2..3
 * with a cheap/fast model to beat a single shot from the same model.
 */
export async function bestOfN(
  drafts: ReadonlyArray<DraftFn>,
  verify: VerifyFn,
  opts: BestOfNOptions = {},
): Promise<BestOfNResult> {
  if (drafts.length === 0) throw new Error('bestOfN: at least one draft fn required');

  const scored = await Promise.all(drafts.map(async (draftFn, index): Promise<ScoredDraft> => {
    const draft = await draftFn(opts.signal);
    const result = await verify(draft, opts.signal);
    return { draft, result, supportRatio: scoreOf(result), index };
  }));

  const best = scored.reduce((a, b) => {
    if (b.supportRatio !== a.supportRatio) return b.supportRatio > a.supportRatio ? b : a;
    if (b.result.pass !== a.result.pass) return b.result.pass ? b : a;
    const aSupported = a.result.verdicts.filter((v) => v.supported).length;
    const bSupported = b.result.verdicts.filter((v) => v.supported).length;
    return bSupported > aSupported ? b : a;
  });

  return { best, all: scored };
}

// ── 4. Self-consistency across samples ────────────────────────────────

export interface ConsistencyReport {
  /** Claims supported in >= threshold fraction of samples. */
  stable: string[];
  /** Claims that appear but flip support across samples — confabulation signal. */
  unstable: string[];
  /** Per-claim support fraction across the samples it appeared in. */
  fractions: Map<string, number>;
}

/**
 * Normalize claims for cross-sample matching. Number tokens are
 * PRESERVED (digits, decimal points, and % kept) — stripping them
 * collapsed "1.2%" and "12%" to the same key and hid exactly the
 * numeric confabulation flips this function exists to detect (Fable
 * audit H3).
 */
function claimKey(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%. ]/gu, ' ') // keep letters, digits, %, decimal point
    .replace(/(?<!\d)\.(?!\d)/g, ' ')    // drop non-decimal dots (sentence periods)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compare claim verdicts across N independently sampled drafts. The
 * support fraction is over ALL samples (not just the samples a claim
 * appeared in — Fable audit M2), so a claim present in only 1 of N
 * samples scores 1/N: low cross-sample frequency IS the confabulation
 * signature (facts the model KNOWS recur across samples; facts it
 * INVENTS vary run to run — the SelfCheckGPT observation). A claim at
 * or above `threshold` is stable; the rest are flagged.
 */
export function selfConsistency(
  verdictSets: ReadonlyArray<ReadonlyArray<ClaimVerdictLike>>,
  opts: { threshold?: number } = {},
): ConsistencyReport {
  const threshold = opts.threshold ?? 1;
  if (threshold <= 0 || threshold > 1) throw new Error('threshold must be in (0,1]');

  const totalSamples = verdictSets.length;
  const seen = new Map<string, { claim: string; supportedSamples: number }>();
  for (const set of verdictSets) {
    // De-dupe within a sample: a claim repeated in one draft counts once,
    // and counts as supported only if every occurrence in that sample is.
    const present = new Map<string, boolean>();
    for (const v of set) {
      const key = claimKey(v.claim);
      if (key === '') continue;
      present.set(key, (present.get(key) ?? true) && v.supported);
      if (!seen.has(key)) seen.set(key, { claim: v.claim, supportedSamples: 0 });
    }
    for (const [key, supported] of present) {
      if (supported) seen.get(key)!.supportedSamples++;
    }
  }

  const stable: string[] = [];
  const unstable: string[] = [];
  const fractions = new Map<string, number>();
  for (const { claim, supportedSamples } of seen.values()) {
    const fraction = totalSamples === 0 ? 0 : supportedSamples / totalSamples;
    fractions.set(claim, fraction);
    if (fraction >= threshold) stable.push(claim);
    else unstable.push(claim);
  }
  return { stable, unstable, fractions };
}

export const VERSION = '0.0.0';
