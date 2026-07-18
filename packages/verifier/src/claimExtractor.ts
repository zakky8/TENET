import type { ChatModel, VerifierConfig } from './types.js';
import { responseText, textMessage } from '@tenet/core';
import { withTimeoutAndSignal } from './timeout.js';

const EXTRACT_SYSTEM = (maxClaims: number) =>
  `You extract atomic factual claims from a draft response for fact-checking.

A "claim" is a single specific factual assertion: a number, date, name, rule, relationship, or feature. Each claim must be standalone (no pronouns).

OUTPUT FORMAT: one claim per line. No numbering, no bullets, no commentary. Maximum ${maxClaims} claims.

EXCLUDE: greetings, follow-up questions, clarifying questions, generic filler, opinion words ("great", "amazing"), "I can't see your account"-style disclaimers.

If the draft has NO factual claims (it's just a greeting / clarifying question / filler), output exactly the word: NONE`;

/** Thrown by `extractClaims` ONLY when `config.failClosed` is set — the extractor errored,
 *  the extraction was TRUNCATED (max_tokens, so the claim list is cut off), or the draft has
 *  MORE claims than `maxClaims` (so some would be dropped unverified). Lets `verifyDraft`
 *  distinguish "cannot fully verify" (→ fail closed) from "the draft genuinely has no
 *  claims" (→ empty list, safe). */
export class ClaimExtractionError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(reason);
    this.name = 'ClaimExtractionError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Extract up to config.maxClaims atomic claims from a draft. On an extractor error the
 *  default is fail-OPEN (returns []); when `config.failClosed` is set it throws
 *  `ClaimExtractionError` on an extractor error, on a TRUNCATED (max_tokens) response, AND
 *  when the model over-produces past `maxClaims` (in every case some claims would otherwise
 *  ship un-extracted or unverified). */
export async function extractClaims(
  model: ChatModel,
  draft: string,
  config: VerifierConfig,
): Promise<string[]> {
  if (!draft || draft.trim().length === 0) return [];

  let raw: string;
  let truncated = false;
  try {
    const res = await withTimeoutAndSignal(
      (signal) =>
        model.chat({
          system: EXTRACT_SYSTEM(config.maxClaims),
          messages: [textMessage('user', `DRAFT:\n${draft}\n\nClaims:`)],
          maxTokens: 256,
          signal,
        }),
      config.extractionTimeoutMs,
      'extract',
    );
    raw = responseText(res);
    // A max_tokens stop means the extractor was CUT OFF mid-enumeration — the claim list
    // is incomplete. responseText() drops stopReason, so capture it here before flattening.
    truncated = res.stopReason === 'max_tokens';
  } catch (err) {
    if (config.failClosed) throw new ClaimExtractionError('claim extraction failed', err); // FAIL CLOSED
    return []; // fail-open default (preserves existing callers)
  }

  // FAIL CLOSED: a truncated (max_tokens) extraction is an INCOMPLETE claim list — the
  // model stopped before emitting the draft's later claims, so verifying only what came
  // back would ship the un-extracted claims unchecked. Symmetric to the over-cap guard
  // below ("cannot fully verify" → don't let the draft pass); the over-cap guard can never
  // catch this because truncation yields FEWER lines, not more. Default stays fail-OPEN
  // (returns the partial list, preserving existing callers).
  if (config.failClosed && truncated) {
    throw new ClaimExtractionError(
      'claim extraction truncated (max_tokens) — cannot fully enumerate the draft claims',
    );
  }

  const text = raw.trim();
  if (/^NONE$/i.test(text)) return [];

  // List-marker strip: ONLY strip recognized list prefixes ("1. ", "1) ",
  // "(1) ", "- ", "* ", "• ") plus surrounding whitespace. Do NOT eat bare
  // leading digits — claims like "2025 EU regulation" or "5000 units per
  // shipment" must survive verbatim.
  const LIST_MARKER_RE = /^\s*(?:\d+[.)]\s+|\(\d+\)\s+|[-*•]\s+)/;
  const claims = text
    .split('\n')
    .map((l) => l.replace(LIST_MARKER_RE, '').trim())
    .filter((l) => l.length >= 8 && l.length <= 240);

  // FAIL CLOSED: if the model over-produced past maxClaims, `.slice` would silently drop
  // the extras — and a dropped claim is NEVER verified, so a fabrication hiding in it would
  // ship. A draft too claim-dense to fully verify must not pass; signal it to verifyDraft.
  if (config.failClosed && claims.length > config.maxClaims) {
    throw new ClaimExtractionError(
      `draft has ${claims.length} claims, exceeds maxClaims (${config.maxClaims}) — cannot fully verify`,
    );
  }
  return claims.slice(0, config.maxClaims);
}
