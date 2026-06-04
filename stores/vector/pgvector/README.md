# @tenet/stores-vector-pgvector

pgvector adapter for the `VectorStore` interface in `@tenet/retrieval`.

**No `pg` SDK as a hard dep.** Inject any node-postgres / postgres.js / connection-pool client that implements `PgQueryExecutor`.

**Production sweet spot:** single-tenant + <50M vectors. Beyond that, see [docs/RESEARCH-PASS-2.md §A2](../../../docs/RESEARCH-PASS-2.md) — Qdrant or Turbopuffer are better fits for 100M+ at scale.

Schema:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE tenet_vectors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  embedding VECTOR(1536),  -- match your embedder
  uri TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  metadata JSONB
);

CREATE INDEX tenet_vectors_tenant_idx ON tenet_vectors (tenant_id);
CREATE INDEX tenet_vectors_hnsw ON tenet_vectors
  USING hnsw (embedding vector_cosine_ops);
```

Filter keys are validated via `@tenet/core`'s `validateFilterKey` to block CVE-2025-67644-class SQL injection.
