import type { Citation } from '@tenet/core';
import { extractClaims } from './claimExtractor.js';
import { isClaimAboutAllowedUrl, judgeBatched } from './judge.js';
import {
  DEFAULT_VERIFIER_CONFIG,
  type ChatModel,
  type ClaimVerdict,
  type VerifierConfig,
  type VerifyInput,
  type VerifyResult,
} from './types.js';

/**
 * Atomic-claim multi-judge verifier.
 *
 * Pipeline:
 *   1. Extract atomic claims from the draft (one LLM call).
 *   2. Pre-pass: claims about allowlisted URLs auto-PASS.
 *   3. Strict judge in parallel batches.
 *   4. Permissive re-judge of strict-failures only.
 *   5. A claim FAILs only if BOTH strict and permissive disagree.
 *
 * Catch-rate vs single-pass (per FP-discord measurement):
 *   single-pass FAIL/PASS catches ~50% of hallucinations.
 *   atomic + multi-judge catches ~85%.
 */
export async function verifyDraft(
  model: ChatModel,
  input: VerifyInput,
  configOverrides: Partial<VerifierConfig> = {},
): Promise<VerifyResult> {
  const config: VerifierConfig = { ...DEFAULT_VERIFIER_CONFIG, ...configOverrides };

  const allClaims = await extractClaims(model, input.draft, config);
  if (allClaims.length === 0) {
    return { pass: true, critique: '', verdicts: [], approvedCitations: [] };
  }

  // URL pre-pass
  const urlClaims = allClaims.filter((c) =>
    isClaimAboutAllowedUrl(c, config.allowedUrlPatterns),
  );
  const claimsToJudge = allClaims.filter(
    (c) => !isClaimAboutAllowedUrl(c, config.allowedUrlPatterns),
  );
  const urlVerdicts: ClaimVerdict[] = urlClaims.map((claim) => ({
    claim,
    supported: true,
    reason: '',
  }));

  if (claimsToJudge.length === 0) {
    return {
      pass: true,
      critique: '',
      verdicts: urlVerdicts,
      approvedCitations: buildCitations(input, urlVerdicts),
    };
  }

  // Strict pass
  const strictVerdicts = await judgeBatched(
    model,
    input.sources,
    claimsToJudge,
    false,
    config,
  );
  const strictFails = strictVerdicts.filter((v) => !v.supported);

  if (strictFails.length === 0) {
    const merged = [...strictVerdicts, ...urlVerdicts];
    return {
      pass: true,
      critique: '',
      verdicts: merged,
      approvedCitations: buildCitations(input, merged),
    };
  }

  // Permissive re-judge of failures only
  const permissiveVerdicts = await judgeBatched(
    model,
    input.sources,
    strictFails.map((v) => v.claim),
    true,
    config,
  );
  const permissiveByClaim = new Map(permissiveVerdicts.map((v) => [v.claim, v]));

  const merged: ClaimVerdict[] = strictVerdicts.map((strict) => {
    if (strict.supported) return strict;
    const permissive = permissiveByClaim.get(strict.claim);
    if (permissive && permissive.supported) {
      return { ...strict, supported: true, reason: '' };
    }
    return strict;
  });
  merged.push(...urlVerdicts);

  const stillFailed = merged.filter((v) => !v.supported);
  if (stillFailed.length === 0) {
    return {
      pass: true,
      critique: '',
      verdicts: merged,
      approvedCitations: buildCitations(input, merged),
    };
  }

  const critique =
    stillFailed.length === 1
      ? `Unsupported claim: "${stillFailed[0]!.claim}". Either remove it or rewrite using only what's in the knowledge.`
      : `Unsupported claims: ${stillFailed
          .map((v) => `"${v.claim}"`)
          .join('; ')}. Either remove them or rewrite using only what's in the knowledge.`;

  return { pass: false, critique, verdicts: merged, approvedCitations: [] };
}

function buildCitations(
  input: VerifyInput,
  verdicts: ReadonlyArray<ClaimVerdict>,
): ReadonlyArray<Citation> {
  if (!input.sourceRecords || input.sourceRecords.length === 0) return [];
  const supported = verdicts.filter((v) => v.supported);
  return supported.flatMap((v) => {
    // Naive backing-source pick: first source whose text mentions the claim's first 30 chars
    const head = v.claim.slice(0, 30).toLowerCase();
    const backing = input.sourceRecords!.find((s) =>
      s.text.toLowerCase().includes(head),
    );
    if (!backing) return [];
    return [{ sourceId: backing.id, quote: backing.text.slice(0, 240) }];
  });
}
