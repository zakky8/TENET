/**
 * Vectara HHEM-2.1 hallucination judge adapter.
 *
 * HHEM-2.1 is a cross-encoder that scores a (premise, hypothesis)
 * pair on [0, 1] where 1 means "fully supported by the premise" and
 * scores below the operator-chosen threshold mean "hallucinated".
 *
 * We DO NOT hard-depend on `@huggingface/transformers` / `onnxruntime`
 * (would force a tokenizer + ONNX runtime install on every consumer).
 * Apps inject any HhemScorer — typically a local `transformers.js`
 * pipeline, an HHEM-hosted endpoint, or a self-hosted Triton instance.
 *
 * Why this matters per BENCHMARKS Dim 1:
 *   The atomic-claim verifier ships an LLM-as-judge by default. LLM
 *   judges agree with themselves and inflate scores (Liang et al.,
 *   2024). HHEM-2.1 is a calibrated independent detector — the
 *   industry-standard third party on the Vectara leaderboard. Using
 *   HHEM as the hallucination row's scorer reduces self-judging bias
 *   and lets us report a real Tier-1 number we did not produce.
 *
 * The interface keeps the verifier-side contract (HallucinationVerdict
 * from @tenet/eval-metrics) so this slots into the existing gate.
 */

import type { HallucinationVerdict } from '@tenet/eval-metrics';

/** Inject any HHEM-shaped scorer. Pure function-call shape. */
export interface HhemScorer {
  /**
   * Score one (premise, hypothesis) pair.
   * @returns Score in [0, 1]. 1 = fully entailed, 0 = contradiction.
   */
  score(args: { premise: string; hypothesis: string; signal?: AbortSignal }): Promise<number>;
}

/** What the verifier produces for a single claim. */
export interface AtomicClaim {
  caseId: string;
  claimId: string;
  /** The model-emitted claim text being judged. */
  hypothesis: string;
  /** Concatenated retrieved source chunks the claim should be entailed by. */
  premise: string;
}

export interface HhemJudgeConfig {
  /** Score below this = hallucinated. Vectara recommends 0.5 for HHEM-2.1. */
  threshold: number;
  /** Max parallel scorer calls. Default 4. */
  concurrency?: number;
}

export class HhemJudgeError extends Error {
  constructor(
    public readonly code: 'scorer_failed' | 'invalid_score' | 'threshold_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'HhemJudgeError';
  }
}

const DEFAULT_CONCURRENCY = 4;

export class HhemJudge {
  constructor(
    private readonly scorer: HhemScorer,
    private readonly config: HhemJudgeConfig,
  ) {
    if (config.threshold < 0 || config.threshold > 1) {
      throw new HhemJudgeError('threshold_invalid', `threshold must be in [0,1], got ${config.threshold}`);
    }
  }

  /**
   * Score one claim. Lifted as a method so callers can use either the
   * bulk `judgeAll` or one-shot for streaming verifier paths.
   */
  async judge(claim: AtomicClaim, signal?: AbortSignal): Promise<HallucinationVerdict & { score: number }> {
    let s: number;
    try {
      s = await this.scorer.score({
        premise: claim.premise,
        hypothesis: claim.hypothesis,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (e) {
      throw new HhemJudgeError('scorer_failed', `HHEM scorer threw: ${(e as Error).message}`);
    }
    if (!Number.isFinite(s) || s < 0 || s > 1) {
      throw new HhemJudgeError('invalid_score', `HHEM scorer returned ${s}, expected [0,1]`);
    }
    return {
      caseId: claim.caseId,
      supported: s >= this.config.threshold,
      score: s,
    };
  }

  /**
   * Score many claims with bounded concurrency. Returns one
   * HallucinationVerdict per input claim, in the same order.
   */
  async judgeAll(
    claims: ReadonlyArray<AtomicClaim>,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<HallucinationVerdict & { score: number; claimId: string }>> {
    const concurrency = Math.max(1, this.config.concurrency ?? DEFAULT_CONCURRENCY);
    const results = new Array<HallucinationVerdict & { score: number; claimId: string }>(claims.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, claims.length) }, async () => {
        while (true) {
          const idx = next++;
          if (idx >= claims.length) return;
          const claim = claims[idx]!;
          const verdict = await this.judge(claim, signal);
          results[idx] = { ...verdict, claimId: claim.claimId };
        }
      }),
    );
    return results;
  }
}

/**
 * Thin reference scorer: a deterministic substring-overlap mock for
 * tests + offline CI. Production swaps in a real HHEM pipeline.
 * Score = |tokens(hypothesis) ∩ tokens(premise)| / |tokens(hypothesis)|.
 */
export const TOKEN_OVERLAP_SCORER: HhemScorer = {
  async score({ premise, hypothesis }) {
    const tk = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const h = tk(hypothesis);
    if (h.length === 0) return 1;
    const p = new Set(tk(premise));
    return h.filter((t) => p.has(t)).length / h.length;
  },
};

export const VERSION = '0.0.0';
