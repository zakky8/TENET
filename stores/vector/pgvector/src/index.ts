/**
 * pgvector VectorStore adapter for @tenet/retrieval.
 *
 * Design — no pg SDK as a hard dep: callers inject any node-postgres /
 * postgres.js / connection-pool client that implements PgQueryExecutor.
 * All filter values flow through PARAMETER BINDING — never string
 * interpolation. Filter keys validated via @tenet/core's
 * validateFilterKey to block CVE-2025-67644-class SQL injection.
 *
 * Schema (default):
 *   CREATE TABLE tenet_vectors (
 *     id TEXT PRIMARY KEY,
 *     tenant_id TEXT,
 *     embedding VECTOR(N),
 *     uri TEXT NOT NULL,
 *     text TEXT NOT NULL,
 *     confidence DOUBLE PRECISION NOT NULL,
 *     metadata JSONB
 *   );
 *   CREATE INDEX tenet_vectors_tenant_idx ON tenet_vectors (tenant_id);
 *   CREATE INDEX tenet_vectors_hnsw ON tenet_vectors
 *     USING hnsw (embedding vector_cosine_ops);
 *
 * Operators pass `tableName` if they use a different name.
 */

import { validateFilterKey } from '@tenet/core';
import type { Source } from '@tenet/core';

export interface PgQueryExecutor {
  query(sql: string, params: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
}

export interface ScoredSource {
  source: Source;
  score: number;
}

export interface VectorRecord {
  source: Source;
  embedding: number[];
  tenantId?: string;
}

export interface PgVectorStoreOptions {
  tableName?: string;
}

export class PgVectorStore {
  private readonly tableName: string;

  constructor(
    private readonly client: PgQueryExecutor,
    opts: PgVectorStoreOptions = {},
  ) {
    this.tableName = opts.tableName ?? 'tenet_vectors';
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(this.tableName)) {
      throw new Error(`PgVectorStore: invalid tableName ${JSON.stringify(this.tableName)}`);
    }
  }

  async upsert(records: ReadonlyArray<VectorRecord>): Promise<void> {
    if (records.length === 0) return;
    // Build values placeholders ($1..$N). Pg supports up to 65535 params per query.
    const rows: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const r of records) {
      placeholders.push(`($${p++}, $${p++}, $${p++}::vector, $${p++}, $${p++}, $${p++}, $${p++}::jsonb)`);
      rows.push(
        r.source.id,
        r.tenantId ?? null,
        embeddingLiteral(r.embedding),
        r.source.uri,
        r.source.text,
        r.source.confidence,
        JSON.stringify(r.source.metadata ?? {}),
      );
    }
    const sql = `INSERT INTO ${this.tableName} (id, tenant_id, embedding, uri, text, confidence, metadata) VALUES ${placeholders.join(', ')} ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, embedding=EXCLUDED.embedding, uri=EXCLUDED.uri, text=EXCLUDED.text, confidence=EXCLUDED.confidence, metadata=EXCLUDED.metadata`;
    await this.client.query(sql, rows);
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
    if (args.k <= 0) return [];

    const params: unknown[] = [embeddingLiteral(args.embedding)];
    const wheres: string[] = [];
    let p = 2;

    if (args.tenantId !== undefined) {
      wheres.push(`tenant_id = $${p++}`);
      params.push(args.tenantId);
    }

    if (args.filter) {
      for (const [key, value] of Object.entries(args.filter)) {
        validateFilterKey(key);
        // jsonb extraction via ->> for text comparison. Filter values are
        // bound; the validated key is safe to interpolate as an SQL string.
        wheres.push(`metadata->>'${key}' = $${p++}`);
        params.push(String(value));
      }
    }

    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    params.push(args.k);
    const sql = `SELECT id, uri, text, confidence, metadata, 1 - (embedding <=> $1::vector) AS score FROM ${this.tableName} ${whereClause} ORDER BY embedding <=> $1::vector ASC LIMIT $${p}`;

    const { rows } = await this.client.query(sql, params);
    return rows.map((r) => {
      const meta = r.metadata as Record<string, string | number | boolean> | null;
      return {
        source: {
          id: String(r.id),
          uri: String(r.uri),
          text: String(r.text),
          confidence: Number(r.confidence),
          ...(meta ? { metadata: meta } : {}),
        },
        score: Number(r.score),
      };
    });
  }

  async delete(ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    await this.client.query(
      `DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`,
      ids,
    );
  }
}

/** Format a number[] as a pgvector text literal ("[v1,v2,...]"). */
function embeddingLiteral(v: number[]): string {
  return '[' + v.join(',') + ']';
}

export const VERSION = '0.0.0';
