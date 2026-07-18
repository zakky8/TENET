/**
 * The single emit edge (design gate §4.3): verify → citation guard → outbound leak
 * gate → emit. This is the ONLY call site in the whole turn that can turn a
 * fact-bearing draft into a member-facing reply, and it fails CLOSED at every branch:
 *
 *   - verifier throws (extractor/judge timeout or error) → abstain
 *   - verifier says pass=false                           → repair (caller may retry)
 *   - verifier passes but approved ZERO citations        → abstain  (see guard below)
 *   - outbound leak filter blocks the draft              → abstain
 *   - only a pass WITH ≥1 approved citation, leak-clean  → emit (resolved)
 *
 * The uncited-pass guard is load-bearing: the concrete verifier returns pass=true with
 * an EMPTY approvedCitations list when a draft has no extractable atomic claims. Emitting
 * that would ship an uncited answer — exactly the fail-open this framework exists to
 * prevent — so a pass with no approved citation abstains, it does not ship.
 */
import { runFilterChain } from '@tenet/guardrails';
import type { AgentDeps, VerifierVerdict } from './deps.js';
import type { OrchestratorState, Result, RetrievedChunk } from './types.js';
import { emitResult } from './terminals.js';

/** The outcome of the emit gate. Discriminated so the critic loop branches correctly:
 *  a verify FAILURE is repairable (retry with the critique); a verifier throw, an
 *  uncited pass, or an outbound leak is NOT repairable — those abstain. */
export type EmitDecision =
  | { readonly kind: 'emit'; readonly result: Result }
  | { readonly kind: 'repair'; readonly critique: string }
  | { readonly kind: 'abstain'; readonly reason: string };

/** Render retrieved chunks into the KNOWLEDGE string the verifier greps for verbatim
 *  grounding. Mirrors the reasoner's block format (`[id] text`) so the verifier checks
 *  the very source text the model was shown. No chunks → empty string. */
export function knowledgeBlock(chunks: ReadonlyArray<RetrievedChunk> | undefined): string {
  if (!chunks || chunks.length === 0) return '';
  return chunks.map((c) => `[${c.source.id}] ${c.source.text}`).join('\n');
}

export async function verifyAndEmit(
  draft: string,
  state: OrchestratorState,
  deps: AgentDeps,
): Promise<EmitDecision> {
  let verdict: VerifierVerdict;
  try {
    verdict = await deps.verify.check({
      sources: knowledgeBlock(state.chunks),
      sourceRecords: (state.chunks ?? []).map((c) => c.source),
      draft,
    });
  } catch (err) {
    // Verifier infra failure (extractor/judge throw or timeout) → FAIL CLOSED.
    return { kind: 'abstain', reason: `verifier error: ${(err as Error).message}` };
  }

  if (!verdict.pass) return { kind: 'repair', critique: verdict.critique };

  // FAIL-CLOSED GUARD: emit only if at least one approved citation is genuinely grounded —
  // a non-blank sourceId AND quote. Catches both the zero-claim pass (verifyDraft returns
  // pass=true with an empty list) and a blank citation from a custom, misbehaving
  // sourcePicker. Either way an uncited answer must never ship.
  const grounded = verdict.approvedCitations.some(
    (c) => c.sourceId.trim() !== '' && c.quote.trim() !== '',
  );
  if (!grounded) {
    return { kind: 'abstain', reason: 'verified but no grounded citation' };
  }

  // Outbound system-prompt / constitution leak gate: a leaked draft never emits.
  const out = runFilterChain(draft, deps.outboundFilters);
  if (out.verdict.kind === 'block') {
    return { kind: 'abstain', reason: `outbound gate blocked by ${out.filterId}: ${out.verdict.reason}` };
  }

  return { kind: 'emit', result: emitResult(draft, verdict.approvedCitations) };
}
