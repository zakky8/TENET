import type { Source } from '@tenet/core';
import type { LexicalScorer, ScoredSource } from './types.js';

/**
 * BM25 implementation — Robertson/Zaragoza's standard "Okapi BM25" with
 * conventional k1=1.2 and b=0.75. Tokenization is intentionally simple:
 * lowercase, split on non-word, drop tokens shorter than minTokenLen.
 *
 * Designed for the in-memory test/dev path and small corpora. The
 * pgvector / Qdrant store adapters will hand BM25 to the DB engine via
 * to-be-built native lexical indexes.
 */
export interface Bm25Options {
  /** Document-length normalization. Default 0.75. */
  b?: number;
  /** Term-frequency saturation. Default 1.2. */
  k1?: number;
  /** Drop tokens shorter than this. Default 2. */
  minTokenLen?: number;
}

interface Doc {
  source: Source;
  tenantId?: string;
  /** token → count */
  termFreq: Map<string, number>;
  length: number;
}

export class Bm25Index implements LexicalScorer {
  private docs: Doc[] = [];
  private docFreq = new Map<string, number>(); // token → # docs containing it
  private avgDocLen = 0;
  private readonly b: number;
  private readonly k1: number;
  private readonly minTokenLen: number;

  constructor(opts: Bm25Options = {}) {
    this.b = opts.b ?? 0.75;
    this.k1 = opts.k1 ?? 1.2;
    this.minTokenLen = opts.minTokenLen ?? 2;
    if (this.b < 0 || this.b > 1) throw new Error('Bm25: b must be in [0,1]');
    if (this.k1 <= 0) throw new Error('Bm25: k1 must be > 0');
  }

  upsert(records: ReadonlyArray<{ source: Source; tenantId?: string }>): void {
    for (const { source, tenantId } of records) {
      const existing = this.docs.findIndex((d) => d.source.id === source.id);
      const tokens = this.tokenize(source.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

      const doc: Doc = { source, tenantId, termFreq: tf, length: tokens.length };

      if (existing >= 0) {
        // Replace — remove old doc's contribution to docFreq
        const old = this.docs[existing]!;
        for (const t of old.termFreq.keys()) {
          const f = this.docFreq.get(t) ?? 0;
          if (f <= 1) this.docFreq.delete(t);
          else this.docFreq.set(t, f - 1);
        }
        this.docs[existing] = doc;
      } else {
        this.docs.push(doc);
      }
      // Add new doc's contribution
      for (const t of tf.keys()) {
        this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
      }
    }
    this.recomputeAvgLen();
  }

  query(args: { text: string; k: number; tenantId?: string }): ReadonlyArray<ScoredSource> {
    if (this.docs.length === 0 || args.k <= 0) return [];
    const queryTokens = this.tokenize(args.text);
    if (queryTokens.length === 0) return [];

    const N = this.docs.length;
    const scored: ScoredSource[] = [];

    for (const doc of this.docs) {
      if (args.tenantId !== undefined && doc.tenantId !== args.tenantId) continue;
      let score = 0;
      for (const qt of queryTokens) {
        const tf = doc.termFreq.get(qt);
        if (!tf) continue;
        const df = this.docFreq.get(qt) ?? 0;
        // IDF with the +1 smoothing of Lucene-style BM25
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const normLen = this.avgDocLen === 0 ? 1 : doc.length / this.avgDocLen;
        const tfComponent = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * normLen));
        score += idf * tfComponent;
      }
      if (score > 0) scored.push({ source: doc.source, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, args.k);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length >= this.minTokenLen);
  }

  private recomputeAvgLen(): void {
    if (this.docs.length === 0) {
      this.avgDocLen = 0;
      return;
    }
    let sum = 0;
    for (const d of this.docs) sum += d.length;
    this.avgDocLen = sum / this.docs.length;
  }
}
