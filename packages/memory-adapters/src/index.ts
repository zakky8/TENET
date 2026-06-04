/**
 * External memory adapters — mem0 / Letta / Zep.
 *
 * Each vendor exposes a slightly different REST shape, but the
 * primitives we need are common: add a memory, list/query memories,
 * delete by id.
 *
 * This package ships a generic ExternalMemoryAdapter that conforms to
 * @tenet/memory's SemanticMemory interface and dispatches through a
 * MemoryProvider — the small per-vendor adapter shipping the actual
 * HTTP calls. Three provider factories ship (mem0Provider, lettaProvider,
 * zepProvider); apps wire their preferred vendor.
 *
 * No vendor SDK is a hard dep. Each provider accepts an injected
 * fetch-compatible HTTP client.
 */

import type {
  SemanticFact,
  SemanticMemory,
  SemanticMemoryQuery,
} from '@tenet/memory';

// ── HTTP contract ──────────────────────────────────────────────────────

export interface MemoryHttp {
  fetch(input: string, init: {
    method: string;
    headers: Readonly<Record<string, string>>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string> }>;
}

// ── Provider contract — implement once per vendor ─────────────────────

export interface MemoryProvider {
  /** Vendor name, e.g. 'mem0', 'letta', 'zep'. */
  name: string;
  /** Add facts. Vendor maps them onto its own memory shape. */
  upsert(facts: ReadonlyArray<SemanticFact>): Promise<void>;
  /** List facts matching a query. */
  list(query: SemanticMemoryQuery): Promise<ReadonlyArray<SemanticFact>>;
  /** Delete by SemanticFact.id. */
  delete(ids: ReadonlyArray<string>): Promise<void>;
}

// ── Generic adapter — SemanticMemory implementation ───────────────────

export class ExternalMemoryAdapter implements SemanticMemory {
  constructor(private readonly provider: MemoryProvider) {}

  async upsert(facts: ReadonlyArray<SemanticFact>): Promise<void> {
    for (const f of facts) {
      if (f.confidence < 0 || f.confidence > 1) {
        throw new Error(`SemanticFact ${f.id}: confidence must be in [0,1]`);
      }
    }
    return this.provider.upsert(facts);
  }

  list(query: SemanticMemoryQuery): Promise<ReadonlyArray<SemanticFact>> {
    return this.provider.list(query);
  }

  delete(ids: ReadonlyArray<string>): Promise<void> {
    return this.provider.delete(ids);
  }

  /** Vendor name — exposed for telemetry / debugging. */
  providerName(): string {
    return this.provider.name;
  }
}

// ── mem0 provider ──────────────────────────────────────────────────────

export interface Mem0Options {
  apiKey: string;
  baseUrl?: string;
}

export function mem0Provider(http: MemoryHttp, opts: Mem0Options): MemoryProvider {
  if (!opts.apiKey) throw new Error('mem0Provider: apiKey required');
  const baseUrl = (opts.baseUrl ?? 'https://api.mem0.ai').replace(/\/+$/, '');
  const headers = {
    'content-type': 'application/json',
    Authorization: `Token ${opts.apiKey}`,
  } as const;

  return {
    name: 'mem0',
    async upsert(facts) {
      // mem0 ingestion is per-memory; batch into one request when shape allows.
      const body = JSON.stringify({
        memories: facts.map((f) => ({
          memory_id: f.id,
          messages: [{ role: 'user', content: f.text }],
          user_id: f.subjectId,
          metadata: {
            tenant_id: f.tenantId,
            confidence: f.confidence,
            recorded_at: f.recordedAtMs,
            ...(f.labels ? { labels: f.labels } : {}),
          },
        })),
      });
      const res = await http.fetch(`${baseUrl}/v1/memories`, { method: 'POST', headers, body });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`mem0 upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    },
    async list(query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.subjectId) params.set('user_id', query.subjectId);
      const res = await http.fetch(`${baseUrl}/v1/memories?${params}`, { method: 'GET', headers });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`mem0 list ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return parseMem0List(await res.text(), query.tenantId);
    },
    async delete(ids) {
      for (const id of ids) {
        const res = await http.fetch(`${baseUrl}/v1/memories/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`mem0 delete ${res.status}`);
        }
      }
    },
  };
}

function parseMem0List(body: string, tenantId: string): ReadonlyArray<SemanticFact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const items = (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(items)) return [];
  const out: SemanticFact[] = [];
  for (const m of items) {
    if (m === null || typeof m !== 'object') continue;
    const mm = m as Record<string, unknown>;
    const meta = (mm.metadata as Record<string, unknown> | undefined) ?? {};
    if (meta.tenant_id !== tenantId) continue;
    out.push({
      id: String(mm.memory_id ?? mm.id ?? ''),
      text: String(mm.memory ?? mm.text ?? ''),
      tenantId,
      ...(typeof mm.user_id === 'string' ? { subjectId: mm.user_id } : {}),
      ...(Array.isArray(meta.labels) ? { labels: meta.labels as ReadonlyArray<string> } : {}),
      recordedAtMs: typeof meta.recorded_at === 'number' ? meta.recorded_at : 0,
      confidence: typeof meta.confidence === 'number' ? meta.confidence : 1,
    });
  }
  return out;
}

// ── Letta provider ─────────────────────────────────────────────────────

export interface LettaOptions {
  apiKey: string;
  baseUrl?: string;
  /** Letta agent id this memory belongs to. */
  agentId: string;
}

export function lettaProvider(http: MemoryHttp, opts: LettaOptions): MemoryProvider {
  if (!opts.apiKey) throw new Error('lettaProvider: apiKey required');
  if (!opts.agentId) throw new Error('lettaProvider: agentId required');
  const baseUrl = (opts.baseUrl ?? 'https://api.letta.com').replace(/\/+$/, '');
  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${opts.apiKey}`,
  } as const;
  const path = `${baseUrl}/v1/agents/${encodeURIComponent(opts.agentId)}/archival-memory`;

  return {
    name: 'letta',
    async upsert(facts) {
      for (const f of facts) {
        const body = JSON.stringify({
          text: f.text,
          metadata: {
            id: f.id,
            tenant_id: f.tenantId,
            subject_id: f.subjectId,
            confidence: f.confidence,
            recorded_at: f.recordedAtMs,
            labels: f.labels,
          },
        });
        const res = await http.fetch(path, { method: 'POST', headers, body });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`letta upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
      }
    },
    async list(query) {
      const res = await http.fetch(`${path}?limit=${query.limit}`, { method: 'GET', headers });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`letta list ${res.status}`);
      }
      return parseLettaList(await res.text(), query.tenantId, query.subjectId);
    },
    async delete(ids) {
      for (const id of ids) {
        const res = await http.fetch(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE', headers });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`letta delete ${res.status}`);
        }
      }
    },
  };
}

function parseLettaList(body: string, tenantId: string, subjectId: string | undefined): ReadonlyArray<SemanticFact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const out: SemanticFact[] = [];
  for (const it of items) {
    if (it === null || typeof it !== 'object') continue;
    const itx = it as Record<string, unknown>;
    const meta = (itx.metadata as Record<string, unknown> | undefined) ?? {};
    if (meta.tenant_id !== tenantId) continue;
    if (subjectId !== undefined && meta.subject_id !== subjectId) continue;
    out.push({
      id: String(meta.id ?? itx.id ?? ''),
      text: String(itx.text ?? ''),
      tenantId,
      ...(typeof meta.subject_id === 'string' ? { subjectId: meta.subject_id } : {}),
      ...(Array.isArray(meta.labels) ? { labels: meta.labels as ReadonlyArray<string> } : {}),
      recordedAtMs: typeof meta.recorded_at === 'number' ? meta.recorded_at : 0,
      confidence: typeof meta.confidence === 'number' ? meta.confidence : 1,
    });
  }
  return out;
}

// ── Zep provider ───────────────────────────────────────────────────────

export interface ZepOptions {
  apiKey: string;
  baseUrl?: string;
}

export function zepProvider(http: MemoryHttp, opts: ZepOptions): MemoryProvider {
  if (!opts.apiKey) throw new Error('zepProvider: apiKey required');
  const baseUrl = (opts.baseUrl ?? 'https://api.getzep.com').replace(/\/+$/, '');
  const headers = {
    'content-type': 'application/json',
    Authorization: `Api-Key ${opts.apiKey}`,
  } as const;

  return {
    name: 'zep',
    async upsert(facts) {
      const body = JSON.stringify({
        facts: facts.map((f) => ({
          uuid: f.id,
          fact: f.text,
          user_id: f.subjectId,
          metadata: {
            tenant_id: f.tenantId,
            confidence: f.confidence,
            recorded_at: f.recordedAtMs,
            labels: f.labels,
          },
        })),
      });
      const res = await http.fetch(`${baseUrl}/v3/facts`, { method: 'POST', headers, body });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`zep upsert ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    },
    async list(query) {
      const params = new URLSearchParams({ limit: String(query.limit) });
      if (query.subjectId) params.set('user_id', query.subjectId);
      const res = await http.fetch(`${baseUrl}/v3/facts?${params}`, { method: 'GET', headers });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`zep list ${res.status}`);
      }
      return parseZepList(await res.text(), query.tenantId);
    },
    async delete(ids) {
      for (const id of ids) {
        const res = await http.fetch(`${baseUrl}/v3/facts/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers,
        });
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`zep delete ${res.status}`);
        }
      }
    },
  };
}

function parseZepList(body: string, tenantId: string): ReadonlyArray<SemanticFact> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const items = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(items)) return [];
  const out: SemanticFact[] = [];
  for (const f of items) {
    if (f === null || typeof f !== 'object') continue;
    const fx = f as Record<string, unknown>;
    const meta = (fx.metadata as Record<string, unknown> | undefined) ?? {};
    if (meta.tenant_id !== tenantId) continue;
    out.push({
      id: String(fx.uuid ?? fx.id ?? ''),
      text: String(fx.fact ?? fx.text ?? ''),
      tenantId,
      ...(typeof fx.user_id === 'string' ? { subjectId: fx.user_id } : {}),
      ...(Array.isArray(meta.labels) ? { labels: meta.labels as ReadonlyArray<string> } : {}),
      recordedAtMs: typeof meta.recorded_at === 'number' ? meta.recorded_at : 0,
      confidence: typeof meta.confidence === 'number' ? meta.confidence : 1,
    });
  }
  return out;
}

export const VERSION = '0.0.0';
