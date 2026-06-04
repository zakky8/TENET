# @tenet/memory-adapters

External memory adapters for **mem0 / Letta / Zep**. Each vendor exposes a slightly different REST shape but all three fit a small `MemoryProvider` contract. The generic `ExternalMemoryAdapter` implements `SemanticMemory` from `@tenet/memory` and dispatches through whichever provider you wire.

No vendor SDK is a hard dep — each provider takes a fetch-compatible HTTP client.

```ts
const provider = mem0Provider(httpClient, { apiKey: process.env.MEM0_KEY! });
const memory = new ExternalMemoryAdapter(provider);
```
