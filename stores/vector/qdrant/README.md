# @tenet/stores-vector-qdrant

Qdrant adapter — Phase-2 default for 100M+ vectors (lowest p50 latency among purpose-built stores per [research pass 2](../../../docs/RESEARCH-PASS-2.md)).

No `@qdrant/js-client-rest` hard dep — inject any fetch-compatible HTTP client.

Multi-tenancy: `tenantId` encoded as the `tenant_id` payload field; queries filter via `filter.must`. Apps with strict isolation can also supply per-tenant `collectionName`.
