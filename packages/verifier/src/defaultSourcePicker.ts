import type { Citation, Source, SourcePicker } from '@tenet/core';
import { significantTokens } from '@tenet/core';

const HEAD_LEN = 60;
const TOKEN_OVERLAP_THRESHOLD = 3;
const QUOTE_LEN = 240;

/**
 * Default backing-source picker.
 *
 * Two-stage fallback:
 *   1. Case-insensitive substring of the claim's first HEAD_LEN chars
 *      against each source's text. Cheap and works for verbatim
 *      assertions.
 *   2. Significant-token overlap (≥4-char tokens). If the claim and a
 *      source share TOKEN_OVERLAP_THRESHOLD or more significant tokens,
 *      that source backs the claim. Handles paraphrase.
 *
 * Source texts are lowercased ONCE per call, not per claim.
 *
 * Apps with stronger requirements (embedding similarity, source-confidence
 * weighting, RAGAS attribution scoring) supply their own SourcePicker.
 */
export const defaultSourcePicker: SourcePicker = {
  pick(claim: string, sources: ReadonlyArray<Source>): Citation | null {
    if (sources.length === 0) return null;
    const head = claim.slice(0, HEAD_LEN).toLowerCase();
    const claimTokens = significantTokens(claim);

    // Pre-lowercase sources once
    const lowered = sources.map((s) => ({ src: s, lower: s.text.toLowerCase() }));

    // Stage 1 — head substring
    for (const { src, lower } of lowered) {
      if (lower.includes(head)) {
        return { sourceId: src.id, quote: src.text.slice(0, QUOTE_LEN) };
      }
    }

    // Stage 2 — significant-token overlap
    if (claimTokens.size === 0) return null;
    for (const { src, lower } of lowered) {
      const sTokens = significantTokens(lower);
      let overlap = 0;
      for (const t of claimTokens) {
        if (sTokens.has(t)) overlap++;
        if (overlap >= TOKEN_OVERLAP_THRESHOLD) break;
      }
      if (overlap >= TOKEN_OVERLAP_THRESHOLD) {
        return { sourceId: src.id, quote: src.text.slice(0, QUOTE_LEN) };
      }
    }

    return null;
  },
};
