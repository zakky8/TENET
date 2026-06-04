import type { Source } from '@tenet/core';
import type { ScoredSource, VectorRecord, VectorStore } from './types.js';

/**
 * In-memory dense vector store with linear cosine scan.
 *
 * Useful for tests, examples, and tiny dev datasets. Production
 * deployments use the pgvector / Qdrant / LanceDB adapter packages.
 */
export class InMemoryVectorStore implements VectorStore {
  private records = new Map<string, { source: Source; embedding: number[]; tenantId?: string }>();

  async upsert(records: ReadonlyArray<VectorRecord>): Promise<void> {
    for (const r of records) {
      this.records.set(r.source.id, {
        source: r.source,
        embedding: r.embedding.slice(),
        ...(r.tenantId !== undefined ? { tenantId: r.tenantId } : {}),
      });
    }
  }

  async query(args: {
    embedding: number[];
    k: number;
    tenantId?: string;
    filter?: Readonly<Record<string, string | number | boolean>>;
    signal?: AbortSignal;
  }): Promise<ReadonlyArray<ScoredSource>> {
    if (args.signal?.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    const out: ScoredSource[] = [];
    for (const r of this.records.values()) {
      if (args.tenantId !== undefined && r.tenantId !== args.tenantId) continue;
      if (args.filter) {
        const meta = r.source.metadata ?? {};
        let pass = true;
        for (const [k, v] of Object.entries(args.filter)) {
          if (meta[k] !== v) {
            pass = false;
            break;
          }
        }
        if (!pass) continue;
      }
      const score = cosine(args.embedding, r.embedding);
      out.push({ source: r.source, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, args.k);
  }

  async delete(ids: ReadonlyArray<string>): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }

  /** Test helper. */
  size(): number {
    return this.records.size;
  }
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch a=${a.length} b=${b.length}`);
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
