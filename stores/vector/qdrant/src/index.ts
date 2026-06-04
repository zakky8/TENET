/**
 * Qdrant VectorStore adapter — Phase 2 default for 100M+ vectors per
 * research pass 2 (lowest p50 latency among purpose-built stores).
 *
 * Design — no @qdrant/js-client-rest hard dep: callers inject any
 * fetch-compatible HTTP client. We talk Qdrant's REST API directly.
 *
 * Multi-tenancy: tenantId is encoded as a payload key and queried via
 * `filter.must` so a single collection can host many tenants safely.
 * Apps with strict tenant isolation provide a per-tenant collectionName.
 *
 * Security: filter keys validated via @tenet/core's validateFilterKey.
 * Collection name validated against /^[a-zA-Z0-9_-]{1,64}$/.
 */

import { validateFilterKey } from '@tenet/core';
import type { Source } from '@tenet/core';

export interface QdrantHttp {
  fetch(input: string, init: {
    method: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{
    status: number;
    text(): Promise<string>;
  }>;
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

export interface QdrantVectorStoreOptions {
  /** Qdrant collection name. */
  collectionName: string;
  /** Base URL. Default 'http://localhost:6333'. */
  baseUrl?: string;
  /** Optional API key (qdrant Cloud). */
  apiKey?: string;
}

export class QdrantVectorStore {
  private readonly collectionName: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(private readonly http: QdrantHttp, opts: QdrantVectorStoreOptions) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(opts.collectionName)) {
      throw new Error(`QdrantVectorStore: invalid collectionName ${JSON.stringify(opts.collectionName)}`);
    }
    this.collectionName = opts.collectionName;
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:6333').replace(/\/+$/, '');
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey;
  }

  async upsert(records: ReadonlyArray<VectorRecord>): Promise<void> {
    if (records.length === 0) return;
    const points = records.map((r) => ({
      id: r.source.id,
      vector: r.embedding,
      payload: {
        uri: r.source.uri,
        text: r.source.text,
        confidence: r.source.confidence,
        ...(r.tenantId !== undefined ? { tenant_id: r.tenantId } : {}),
        ...(r.source.metadata ? { ...r.source.metadata } : {}),
      },
    }));
    const res = await this.req(
      'PUT',
      `/collections/${this.collectionName}/points?wait=true`,
      { points },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new QdrantError(res.status, await res.text());
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
    if (args.k <= 0) return [];

    const mustConditions: unknown[] = [];
    if (args.tenantId !== undefined) {
      mustConditions.push({ key: 'tenant_id', match: { value: args.tenantId } });
    }
    if (args.filter) {
      for (const [key, value] of Object.entries(args.filter)) {
        validateFilterKey(key);
        mustConditions.push({ key, match: { value } });
      }
    }

    const body: Record<string, unknown> = {
      vector: args.embedding,
      limit: args.k,
      with_payload: true,
    };
    if (mustConditions.length > 0) {
      body.filter = { must: mustConditions };
    }

    const res = await this.req(
      'POST',
      `/collections/${this.collectionName}/points/search`,
      body,
      args.signal,
    );
    if (res.status < 200 || res.status >= 300) {
      throw new QdrantError(res.status, await res.text());
    }
    return parseSearchResponse(await res.text());
  }

  async delete(ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;
    const res = await this.req(
      'POST',
      `/collections/${this.collectionName}/points/delete?wait=true`,
      { points: ids },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new QdrantError(res.status, await res.text());
    }
  }

  private async req(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; text(): Promise<string> }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers['api-key'] = this.apiKey;
    return this.http.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  }
}

function parseSearchResponse(text: string): ScoredSource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Qdrant response invalid JSON: ${(e as Error).message}`);
  }
  const result = (parsed as { result?: unknown }).result;
  if (!Array.isArray(result)) {
    throw new Error('Qdrant response.result must be an array');
  }
  const out: ScoredSource[] = [];
  for (const r of result) {
    if (r === null || typeof r !== 'object') continue;
    const point = r as { id?: unknown; score?: unknown; payload?: unknown };
    const payload = (point.payload ?? {}) as Record<string, unknown>;
    const meta = stripReservedKeys(payload);
    out.push({
      source: {
        id: String(point.id ?? ''),
        uri: String(payload['uri'] ?? ''),
        text: String(payload['text'] ?? ''),
        confidence: Number(payload['confidence'] ?? 0),
        ...(Object.keys(meta).length > 0 ? { metadata: meta as Record<string, string | number | boolean> } : {}),
      },
      score: Number(point.score ?? 0),
    });
  }
  return out;
}

const RESERVED_PAYLOAD_KEYS = new Set(['uri', 'text', 'confidence', 'tenant_id']);
function stripReservedKeys(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!RESERVED_PAYLOAD_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      out[k] = v;
    }
  }
  return out;
}

export class QdrantError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Qdrant ${status}: ${body.slice(0, 200)}`);
    this.name = 'QdrantError';
  }
}

export const VERSION = '0.0.0';
