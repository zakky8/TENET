# @tenet/stores-state-redis

Conversation-state store — minimal KV interface for short-lived state (sessions, idempotency, rate-limit counters when shared across instances, recent-message windows).

Ships three things:

1. **`StateStore` interface** — `get/set/del/incr`. Wire to any KV (Redis, Valkey, Upstash, KeyDB, Cloudflare KV, DynamoDB).
2. **`InMemoryStateStore`** — production-grade for single-instance deploys + tests. TTL respected, LRU eviction at `maxKeys`.
3. **`RedisStateStore`** — adapter on top of any ioredis / node-redis v5-compatible client. Apps construct + inject the client.

See the parent monorepo's [docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md).
