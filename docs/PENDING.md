# Pending — Research + Architecture Triage

**As of:** 2026-06-04. Lists what's queued, why, and how I'd rank it.

Companion to [ROADMAP.md](ROADMAP.md). This doc is the "what to read / build / verify next." Roadmap is the "what ships in which phase."

---

## Bucket A — Open research questions (carried from pass 1)

Pass 1 of the deep-research workflow surfaced these as unverified after 3-vote adversarial verification. They affect specific phase-2/3 architecture decisions; we move forward without them at our own risk.

| # | Question | Why it matters | Cost to research | Suggested when |
|---|---|---|---|---|
| A1 | Closed-tool architecture clues (Decagon / Sierra / Cresta / Aisera / Moveworks): model routing, retrieval stack, eval harness, multi-tenancy, hand-off model. | Decides whether `@tenet/router` ships fine-tune-aware routing by phase 2 or defers. | medium (engineering blogs, job posts, conference talks, patents) | before phase 2 |
| A2 | Vector store cost-perf at 10M-1B vectors: pgvector vs Qdrant vs Weaviate vs Milvus vs LanceDB vs Pinecone vs Turbopuffer vs Vespa. | Decides phase-2 default. pgvector is the current default by ease-of-self-host, not by measured perf. | high (need own benchmarks or reproducible third-party) | before phase 2 vector-store default lock-in |
| A3 | MCP enterprise adoption signal in named Fortune-500. | Decides whether MCP-native is a launch differentiator or a phase-2 story. | low (announcements, GH issues, vendor pages) | before v1.0 marketing |
| A4 | Eval / observability layer head-to-head: LangSmith vs Braintrust vs Arize Phoenix vs Langfuse vs Helicone + OTel GenAI conformance. | Decides our default recommendation for operators. OTel export covers all of them, but docs need to pick one. | low-medium | before phase-1 eval-as-CI |

## Bucket B — Adversarial review findings deferred from f88a343

From the 6-agent adversarial pass on the c9c9fb0 implementation. Fix #1, #2, #3, #6, #7, #10 landed. These five remain.

| # | Finding | File | Severity | Cost to fix |
|---|---|---|---|---|
| B1 | `buildCitations` 30-char substring head-match drops citations for paraphrased claims. | `packages/verifier/src/verifier.ts:127` | medium | small — replace with swappable `pickBackingSource(claim, sources)` strategy in `@tenet/core` |
| B2 | `PathHandle` brand type promises protection but no `openPath()` factory exists — vapor type safety. | `packages/core/src/types.ts:34` | medium-high (false confidence is worse than no type) | medium — ship `@tenet/core` `openPath()` with allow-list root + abs-path rejection, or delete the type |
| B3 | `ChatModel.chat` lacks `AbortSignal` parameter — zombie HTTP after `withTimeout` reject. | `packages/verifier/src/types.ts:43` | high (real production cost: budget burn + rate-limit exhaustion) | medium — add `signal: AbortSignal` to ChatModel + propagate through `withTimeout` |
| B4 | `OutcomeEmitter` sink-isolation `try/catch` swallows infinite recursion + all programmer mistakes silently. | `packages/telemetry/src/index.ts:76` | medium (operational opacity) | small — add re-entrancy guard + log swallowed errors at warn (without recursing back through emit) |
| B5 | `VerifierConfig` bakes app-specific concepts (`allowedUrlPatterns`, `adversarialExamples`) into framework. | `packages/verifier/src/types.ts:28` | medium (architecture / altitude) | medium — replace with pluggable `ClaimPreFilter` + `JudgePromptDecorator` interfaces |

## Bucket C — MVP packages not yet implemented

Each is in [ROADMAP.md Phase 1](ROADMAP.md). Tracked here for scheduling.

| # | Package | Why it's blocking MVP | Estimated scope |
|---|---|---|---|
| C1 | `@tenet/retrieval` | RAG is the heart of grounded answers — no retrieval, no source-grounding to enforce. | large (chunker, contextualizer, BM25 + dense, RRF fusion, rerank, swappable vector-store adapter) |
| C2 | `@tenet/rate-limit` | Without it any surface adapter has to roll its own; first PR breaks the architecture. | medium (token bucket per (platform, tenant, channel, user), circuit breaker on 401/403 streak) |
| C3 | `@tenet/router` | Adaptive cost-aware routing is core to the cost-per-resolution 100× target. | medium-large (classifier, semantic answer cache, speculative streaming) |
| C4 | `@tenet/memory` | Conversation history can use a stub initially; long-term episodic + semantic is phase 2. | medium (episodic + semantic + working interface; adapters can land later) |
| C5 | `@tenet/guardrails` | PII redaction + input/output filters. Required before any prod traffic. | medium |
| C6 | `surfaces/telegram` | First reference surface. Proves the adapter pattern. | medium (grammY adapter, formatter, rate-limit policy wiring) |
| C7 | `models/bedrock` | First model adapter. Implements `ChatModel`. | small-medium |
| C8 | `stores/vector/pgvector` | First vector store. Implements the swappable interface. | medium |
| C9 | `stores/state/redis` | Session + cache state. | small |
| C10 | `apps/community-bot` | First reference deployment. End-to-end MVP gate. | medium (Telegram + Bedrock + pgvector + Redis + community config) |
| C11 | `eval/harness` | Eval-as-CI requires a runner before any eval-set growth makes sense. | medium-large (golden dataset loader, LLM-as-judge, regression gate) |

## Bucket D — Fresh research worth doing on current state of the field

Pass 1 was on 2026-06-03. The agent-framework field churns monthly. These are worth a focused pass before phase 1 implementation locks in choices.

| # | Topic | Reason | Estimated cost |
|---|---|---|---|
| D1 | Anthropic Claude Agent SDK + Opus 4.8 + Haiku 4.5 — actual SDK feature surface as of today (compaction, batch, structured outputs, prompt caching, MCP integration). | We picked Opus 4.8 + Haiku 4.5 in BENCHMARKS.md but didn't verify the SDK shape. Affects `models/anthropic` and the router. | low |
| D2 | MCP spec changelog since pass 1 — transport stability (stdio vs SSE vs Streamable HTTP), OAuth ratification status, server-registry consolidation. | "MCP-native" is a marketed differentiator; spec drift would change the story. | low |
| D3 | OpenTelemetry GenAI semconv stable version + which exporters fully implement it. | We claim "OTel GenAI semconv native" — need to confirm what version we conform to. | low |
| D4 | New / evolved OSS frameworks: Letta long-term-memory, Mastra TS-first, Pydantic-AI v1, Inkeep, Smolagents, OpenAI Agents SDK. | We need to know what to compete on. | medium |
| D5 | Vectara HHEM-2.1 vs newer hallucination judges (latest leaderboard). | Hallucination CI gate depends on this choice. | low |
| D6 | Cohere Rerank 3.5 vs Voyage Rerank vs BGE-Reranker-v2-M3 vs jina-reranker-v2.5 (head-to-head). | Reranker is part of the contextual-retrieval recipe; current pick was BENCHMARKS.md-era. | low |

---

## Suggested execution order

Strict-precedence rule: if a row in a later bucket can fail because of an unresolved row in an earlier bucket, do the earlier one first.

1. **D3, D5, A4** (~15 min research total) — pick OTel semconv version, hallucination judge, eval-layer recommendation. These unblock Bucket C without code.
2. **B3** (AbortSignal) — block phase-1 prod traffic; a production-relevant correctness fix.
3. **B2** (PathHandle factory) — settle the "framework-promise vs reality" gap before the fs package lands.
4. **C7 + C8 + C2** (models/bedrock + pgvector + rate-limit) — smallest unit that lets `@tenet/verifier` actually fire on real outputs.
5. **C1** (`@tenet/retrieval`) — the heart of source-grounding. After it lands, the verifier has something to ground on.
6. **D4** (refreshed OSS framework landscape) — feeds the next architecture review.
7. **A2** (vector-store benchmark) — only matters once we have non-trivial corpus. Defer until MVP shows real traffic.
8. **A1** (closed-tool architecture) + **D1, D2, D6** — informs phase-2 polish, not phase-1 ship.
9. **B5** (`VerifierConfig` altitude refactor) — best done once we have a second app under `apps/` to prove the pluggability claim.

---

## What I'm NOT doing without explicit ask

- Running a Round-2 deep-research workflow (~3M tokens). Pass 1 produced enough to ship phase 1.
- Pre-emptive vector-store benchmark (D2 requires us to host hardware or pay for a benchmark service).
- Closed-tool reverse engineering (A1) — high research cost, low immediate yield.

Open an issue tagged `research` or `architecture` if you want any of these run.
