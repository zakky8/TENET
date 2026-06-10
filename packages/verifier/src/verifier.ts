import type { Citation, SourcePicker } from '@tenet/core';
import { extractClaims } from './claimExtractor.js';
import { defaultSourcePicker } from './defaultSourcePicker.js';
import { judgeBatched } from './judge.js';
import { runPreChecks } from './deterministic.js';
import { effectivePreFilters } from './strategies.js';
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

  // Pre-pass: claims that pass any filter auto-trust (no judge call)
  const preFilters = effectivePreFilters(config);
  const claimPasses = (claim: string): boolean =>
    preFilters.some((f) => f.passesWithoutJudging(claim));
  const urlClaims: string[] = [];
  const afterFilters: string[] = [];
  for (const c of allClaims) {
    if (claimPasses(c)) urlClaims.push(c);
    else afterFilters.push(c);
  }
  const urlVerdicts: ClaimVerdict[] = urlClaims.map((claim) => ({
    claim,
    supported: true,
    reason: '',
  }));

  // Deterministic pre-check tier (P16): settle claims by string/numeric
  // evidence before spending judge calls. 'fail' here is FINAL — the
  // permissive judge never sees it (a fabricated number is hard
  // evidence, and LLM judges are exactly the layer that misses it).
  const preChecks = config.claimPreChecks ?? [];
  const deterministicVerdicts: ClaimVerdict[] = [];
  const claimsToJudge: string[] = [];
  for (const claim of afterFilters) {
    const r = runPreChecks(preChecks, claim, input.sources);
    if (r.verdict === 'pass') {
      deterministicVerdicts.push({ claim, supported: true, reason: 'deterministic: verbatim-grounded' });
    } else if (r.verdict === 'fail') {
      deterministicVerdicts.push({ claim, supported: false, reason: `deterministic: ${r.reason ?? 'fabrication evidence'}` });
    } else {
      claimsToJudge.push(claim);
    }
  }
  const deterministicFails = deterministicVerdicts.filter((v) => !v.supported);

  if (claimsToJudge.length === 0) {
    const merged = [...deterministicVerdicts, ...urlVerdicts];
    const pass = deterministicFails.length === 0;
    return {
      pass,
      critique: pass ? '' : critiqueFrom(deterministicFails),
      verdicts: merged,
      approvedCitations: pass ? buildCitations(input, merged) : [],
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
    const merged = [...strictVerdicts, ...deterministicVerdicts, ...urlVerdicts];
    const pass = deterministicFails.length === 0;
    return {
      pass,
      critique: pass ? '' : critiqueFrom(deterministicFails),
      verdicts: merged,
      approvedCitations: pass ? buildCitations(input, merged) : [],
    };
  }

  // Permissive re-judge of failures only.
  //
  // Index-based merge (not Map-by-claim-string): when two strict-failed
  // claims happen to be identical strings (extractor non-determinism,
  // duplicate factual assertions in the draft), keying the permissive
  // verdicts by string collapses to a single Map entry and both strict
  // failures get the wrong permissive result. Tracking by original index
  // keeps the alignment exact.
  const strictFailIndices: number[] = [];
  strictVerdicts.forEach((v, i) => {
    if (!v.supported) strictFailIndices.push(i);
  });
  const permissiveClaims = strictFailIndices.map((i) => strictVerdicts[i]!.claim);
  const permissiveVerdicts = await judgeBatched(
    model,
    input.sources,
    permissiveClaims,
    true,
    config,
  );

  const merged: ClaimVerdict[] = strictVerdicts.map((strict, i) => {
    if (strict.supported) return strict;
    const failOrder = strictFailIndices.indexOf(i);
    const permissive = failOrder >= 0 ? permissiveVerdicts[failOrder] : undefined;
    if (permissive && permissive.supported) {
      return { ...strict, supported: true, reason: '' };
    }
    return strict;
  });
  merged.push(...deterministicVerdicts, ...urlVerdicts);

  const stillFailed = merged.filter((v) => !v.supported);
  if (stillFailed.length === 0) {
    return {
      pass: true,
      critique: '',
      verdicts: merged,
      approvedCitations: buildCitations(input, merged),
    };
  }

  return { pass: false, critique: critiqueFrom(stillFailed), verdicts: merged, approvedCitations: [] };
}

function critiqueFrom(failed: ReadonlyArray<ClaimVerdict>): string {
  return failed.length === 1
    ? `Unsupported claim: "${failed[0]!.claim}". Either remove it or rewrite using only what's in the knowledge.`
    : `Unsupported claims: ${failed
        .map((v) => `"${v.claim}"`)
        .join('; ')}. Either remove them or rewrite using only what's in the knowledge.`;
}

function buildCitations(
  input: VerifyInput,
  verdicts: ReadonlyArray<ClaimVerdict>,
): ReadonlyArray<Citation> {
  if (!input.sourceRecords || input.sourceRecords.length === 0) return [];
  const picker: SourcePicker = input.sourcePicker ?? defaultSourcePicker;
  const supported = verdicts.filter((v) => v.supported);
  return supported.flatMap((v) => {
    const citation = picker.pick(v.claim, input.sourceRecords!);
    return citation ? [citation] : [];
  });
}
