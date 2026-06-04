import type { CacheHit, SemanticAnswerCache } from './types.js';

/**
 * In-memory semantic answer cache.
 *
 * Stores (query, embedding, answer) tuples. Lookup computes cosine
 * similarity against every cached embedding and returns the highest-
 * scoring hit if it clears minSimilarity.
 *
 * Production deployments use a Redis-backed adapter (separate package)
 * that stores embeddings as compressed vectors and indexes them via a
 * small ANN structure. The interface is identical.
 */
export interface InMemorySemanticAnswerCacheOptions {
  /** Max cached entries — LRU eviction beyond this. Default 1000. */
  maxEntries?: number;
  /** Default minimum similarity for a hit. Lookup arg overrides. Default 0.94. */
  defaultMinSimilarity?: number;
  /** Time source. */
  now?: () => number;
}

interface Entry {
  text: string;
  embedding: number[];
  answer: string;
  cachedAtMs: number;
}

export class InMemorySemanticAnswerCache implements SemanticAnswerCache {
  private readonly maxEntries: number;
  private readonly defaultMin: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: InMemorySemanticAnswerCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 1000;
    this.defaultMin = opts.defaultMinSimilarity ?? 0.94;
    this.now = opts.now ?? (() => Date.now());
    if (this.maxEntries <= 0) throw new Error('maxEntries must be > 0');
    if (this.defaultMin < 0 || this.defaultMin > 1) {
      throw new Error('defaultMinSimilarity must be in [0,1]');
    }
  }

  async lookup(args: {
    text: string;
    embedding: number[];
    minSimilarity?: number;
  }): Promise<CacheHit | null> {
    const threshold = args.minSimilarity ?? this.defaultMin;
    let best: { entry: Entry; sim: number } | null = null;
    for (const entry of this.entries.values()) {
      const sim = cosine(args.embedding, entry.embedding);
      if (sim > (best?.sim ?? -Infinity)) best = { entry, sim };
    }
    if (!best || best.sim < threshold) return null;
    return {
      answer: best.entry.answer,
      similarity: best.sim,
      cachedAtMs: best.entry.cachedAtMs,
    };
  }

  async store(args: {
    text: string;
    embedding: number[];
    answer: string;
    timestampMs?: number;
  }): Promise<void> {
    if (this.entries.size >= this.maxEntries && !this.entries.has(args.text)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(args.text, {
      text: args.text,
      embedding: args.embedding.slice(),
      answer: args.answer,
      cachedAtMs: args.timestampMs ?? this.now(),
    });
  }

  async evict(text: string): Promise<void> {
    this.entries.delete(text);
  }

  /** Test helper. */
  size(): number {
    return this.entries.size;
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine dim mismatch a=${a.length} b=${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
