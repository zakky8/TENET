# @tenet/memory

Memory tier interfaces + bounded in-memory implementations:

- **`WorkingMemory`** — ring buffer of the most recent conversation messages with optional token-budget cap.
- **`EpisodicMemory`** — per-conversation long-term history (`recent`, `byTimeRange`).
- **`SemanticMemory`** — cross-conversation distilled facts with tenant + subject scoping, label filtering, confidence-aware eviction.

Production deployments swap the in-memory impls for Postgres / Dynamo / mem0 / Letta / Zep adapters that conform to the same interfaces.
