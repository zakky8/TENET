/**
 * Semantic memory: distilled facts pulled from conversations and made
 * retrievable across conversations / sessions / tenants.
 *
 * Wire to any vector store implementing the @tenet/retrieval
 * VectorStore interface. Apps configure their preferred dedupe +
 * staleness policies.
 *
 * This module ships only the interface + a minimal in-memory impl.
 * Production deployments use a real vector store via the adapter,
 * with embedding-aware dedupe.
 */

export interface SemanticFact {
  /** Stable id (content-hash recommended). */
  id: string;
  /** Verbatim fact text. */
  text: string;
  /** Tenant the fact belongs to — facts NEVER cross tenants. */
  tenantId: string;
  /** Optional user / subject id within the tenant. */
  subjectId?: string;
  /** Free-form labels for filtering ("preference", "profile", etc.). */
  labels?: ReadonlyArray<string>;
  /** Source conversation id. */
  sourceConversationId?: string;
  /** Wall-clock ms when fact was recorded. */
  recordedAtMs: number;
  /** Confidence 0..1; low confidence dropped first on cap exceed. */
  confidence: number;
}

export interface SemanticMemoryQuery {
  tenantId: string;
  subjectId?: string;
  /** Filter by any label match. */
  anyLabel?: ReadonlyArray<string>;
  /** Max facts returned. */
  limit: number;
}

export interface SemanticMemory {
  upsert(facts: ReadonlyArray<SemanticFact>): Promise<void>;
  /** Lookup without retrieval — exact-match by tenant + optional subject + labels. */
  list(query: SemanticMemoryQuery): Promise<ReadonlyArray<SemanticFact>>;
  delete(ids: ReadonlyArray<string>): Promise<void>;
}

export interface InMemorySemanticMemoryOptions {
  /** Per-tenant cap. Lowest-confidence facts evicted on exceed. Default 10000. */
  perTenantCap?: number;
}

export class InMemorySemanticMemory implements SemanticMemory {
  private readonly cap: number;
  private readonly facts = new Map<string, SemanticFact>();

  constructor(opts: InMemorySemanticMemoryOptions = {}) {
    this.cap = opts.perTenantCap ?? 10_000;
    if (this.cap <= 0) throw new Error('perTenantCap must be > 0');
  }

  async upsert(facts: ReadonlyArray<SemanticFact>): Promise<void> {
    for (const f of facts) {
      if (f.confidence < 0 || f.confidence > 1) {
        throw new Error(`SemanticFact ${f.id}: confidence must be in [0,1]`);
      }
      this.facts.set(f.id, f);
    }
    this.evictPerTenantOverCap();
  }

  async list(query: SemanticMemoryQuery): Promise<ReadonlyArray<SemanticFact>> {
    if (query.limit <= 0) return [];
    const out: SemanticFact[] = [];
    for (const f of this.facts.values()) {
      if (f.tenantId !== query.tenantId) continue;
      if (query.subjectId !== undefined && f.subjectId !== query.subjectId) continue;
      if (query.anyLabel && query.anyLabel.length > 0) {
        const labels = f.labels ?? [];
        if (!labels.some((l) => query.anyLabel!.includes(l))) continue;
      }
      out.push(f);
    }
    // Stable ordering: highest confidence first, then most recent.
    out.sort((a, b) => b.confidence - a.confidence || b.recordedAtMs - a.recordedAtMs);
    return out.slice(0, query.limit);
  }

  async delete(ids: ReadonlyArray<string>): Promise<void> {
    for (const id of ids) this.facts.delete(id);
  }

  private evictPerTenantOverCap(): void {
    const byTenant = new Map<string, SemanticFact[]>();
    for (const f of this.facts.values()) {
      let arr = byTenant.get(f.tenantId);
      if (!arr) {
        arr = [];
        byTenant.set(f.tenantId, arr);
      }
      arr.push(f);
    }
    for (const arr of byTenant.values()) {
      if (arr.length <= this.cap) continue;
      // Drop lowest-confidence, then oldest, until at cap
      arr.sort((a, b) => a.confidence - b.confidence || a.recordedAtMs - b.recordedAtMs);
      const toDrop = arr.length - this.cap;
      for (let i = 0; i < toDrop; i++) {
        this.facts.delete(arr[i]!.id);
      }
    }
  }

  /** Test helper. */
  size(): number {
    return this.facts.size;
  }
}
