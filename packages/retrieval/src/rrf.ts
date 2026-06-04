import type { ScoredSource } from './types.js';

/**
 * Reciprocal Rank Fusion (RRF) — Cormack et al. 2009.
 *
 * Fuse N ranked lists into one. Each list contributes 1/(k + rank) to
 * each item's score. k defaults to 60 per the paper. Higher k softens
 * the rank decay; lower k makes top ranks dominate.
 */
export interface RrfOptions {
  k?: number;
  /** Final result size cap. Default infinite. */
  limit?: number;
}

export function reciprocalRankFusion(
  lists: ReadonlyArray<ReadonlyArray<ScoredSource>>,
  opts: RrfOptions = {},
): ReadonlyArray<ScoredSource> {
  const k = opts.k ?? 60;
  if (k <= 0) throw new Error('RRF: k must be > 0');

  const fused = new Map<string, { source: ScoredSource['source']; score: number }>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const entry = list[rank]!;
      const id = entry.source.id;
      const contrib = 1 / (k + rank + 1); // rank is 0-indexed; RRF formula uses 1-indexed
      const prev = fused.get(id);
      if (prev) prev.score += contrib;
      else fused.set(id, { source: entry.source, score: contrib });
    }
  }

  // ES2023 Array.prototype.toSorted — non-mutating sort, no .slice() needed.
  const out = Array.from(fused.values()).toSorted((a, b) => b.score - a.score);
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}
