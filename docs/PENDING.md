# Pending — Research + Architecture Triage

**As of:** 2026-07-18 (revised after the canonical-ChatModel upgrade on `upgrade/top-1pct`). Lists what's queued, why, and how I'd rank it.

> **Upgrade update (2026-07-18).** Phase 1 (canonical `ChatModel` migration) landed and Phase 2's agent turn is SHIPPED. B2 and B3 are now RESOLVED (see bucket B); the single-string `ChatModel` schism is resolved by one messages-array contract (`packages/core/src/model.ts`); the model-adapter C-items are done (all 6 adapters exist). The `@tenet/agent` package now ships the full driven turn: `runAgent` (`packages/agent/src/orchestrator.ts`) executes `OrchestratorState` as a fail-closed `@tenet/workflow` graph (nodes → Reasoner → governance-gated tools → verify → single emit edge). B1, B4, B5 remain open. Details inline below.

> **All 26 original rows closed.** See [RESEARCH-PASS-2.md](RESEARCH-PASS-2.md) for buckets A + D (research), [CHANGELOG.md](CHANGELOG.md) for bucket B (5 adversarial fixes) + bucket C (11 MVP packages). This doc is preserved as the historical triage; future open items live in GitHub Issues.

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

From the 6-agent adversarial pass on the c9c9fb0 implementation. Fix #1, #2, #3, #6, #7, #10 landed. B2 and B3 were resolved by the 2026-07-18 upgrade; B1, B4, B5 remain.

| # | Status | Finding | File | Severity | Cost to fix |
|---|---|---|---|---|---|
| B1 | OPEN | `buildCitations` 30-char substring head-match drops citations for paraphrased claims. | `packages/verifier/src/verifier.ts:127` | medium | small — replace with swappable `pickBackingSource(claim, sources)` strategy in `@tenet/core` |
| B2 | **RESOLVED** | `PathHandle` brand type now has a sanctioned `openPath()` factory (allow-list root via `configurePathRoot()`, absolute-path + `..`-traversal + root-escape rejection). No longer vapor type safety. | fixed in `packages/core/src/path.ts:58` (`openPath`); brand at `packages/core/src/types.ts:34` | — | done |
| B3 | **RESOLVED** | The canonical `ChatModel` now takes a **required** `AbortSignal` (`ChatRequest.signal`, non-optional) — its presence is enforced by the type system, so a cancelled turn can release the in-flight call. | fixed in `packages/core/src/model.ts:57` (`readonly signal: AbortSignal`) | — | done |
| B4 | OPEN | `OutcomeEmitter` sink-isolation `try/catch` swallows infinite recursion + all programmer mistakes silently. | `packages/telemetry/src/index.ts:76` | medium (operational opacity) | small — add re-entrancy guard + log swallowed errors at warn (without recursing back through emit) |
| B5 | OPEN | `VerifierConfig` bakes app-specific concepts (`allowedUrlPatterns`, `adversarialExamples`) into framework. | `packages/verifier/src/types.ts:28` | medium (architecture / altitude) | medium — replace with pluggable `ClaimPreFilter` + `JudgePromptDecorator` interfaces |

## Bucket C — MVP packages not yet implemented

Each is in [ROADMAP.md Phase 1](ROADMAP.md). All 11 packages landed (see [CHANGELOG.md](CHANGELOG.md)); the model-adapter and community-bot rows below were re-verified against the code by the 2026-07-18 upgrade.

| # | Status | Package | Why it's blocking MVP | Estimated scope |
|---|---|---|---|---|
| C1 | landed | `@tenet/retrieval` | RAG is the heart of grounded answers — no retrieval, no source-grounding to enforce. | large (chunker, contextualizer, BM25 + dense, RRF fusion, rerank, swappable vector-store adapter) |
| C2 | landed | `@tenet/rate-limit` | Without it any surface adapter has to roll its own; first PR breaks the architecture. | medium (token bucket per (platform, tenant, channel, user), circuit breaker on 401/403 streak) |
| C3 | landed | `@tenet/router` | Adaptive cost-aware routing is core to the cost-per-resolution target. | medium-large (classifier, semantic answer cache, speculative streaming) |
| C4 | landed | `@tenet/memory` | Conversation history can use a stub initially; long-term episodic + semantic is phase 2. | medium (episodic + semantic + working interface; adapters can land later) |
| C5 | landed | `@tenet/guardrails` | PII redaction + input/output filters. Required before any prod traffic. | medium |
| C6 | landed | `surfaces/telegram` | First reference surface. Proves the adapter pattern. | medium (grammY adapter, formatter, rate-limit policy wiring) |
| C7 | **DONE** | `models/bedrock` | First model adapter. Implements `ChatModel`. | done — all 6 adapters exist (`models/{anthropic,bedrock,google,mistral,ollama,openai}/src/index.ts`), migrated to the canonical `ChatModel` contract. |
| C8 | landed | `stores/vector/pgvector` | First vector store. Implements the swappable interface. | medium |
| C9 | landed | `stores/state/redis` | Session + cache state. | small |
| C10 | **DONE** | `apps/community-bot` | First reference deployment. | `apps/community-bot/src/index.ts` exists and is on the canonical contract; history is now STRUCTURED `ModelMessage`s (`textMessage(m.role, m.content)` at `index.ts:114`), killing the `${role}: ${content}` turn-spoof. End-to-end orchestrator now shipped (`runAgent`, see below). |
| C11 | landed | `eval/harness` | Eval-as-CI requires a runner before any eval-set growth makes sense. | medium-large (golden dataset loader, LLM-as-judge, regression gate) |

## Upgrade status — canonical `ChatModel` (Phase 1) + fail-closed Reasoner (Phase 2)

*(2026-07-18, branch `upgrade/top-1pct`.)*

**Landed:**

- **Phase 1 — one canonical `ChatModel` contract in `@tenet/core`.** A messages array (`ModelMessage[]`), a required `AbortSignal`, tool round-trips (`ContentBlock`: `text` | `tool_use` | `tool_result`), and a lossless `StopReason` union (`packages/core/src/model.ts`). This replaced the duplicated single-string `chat({system, user}): Promise<string>` interfaces — the schism the recon flagged as the root of "no conversation memory." Role structure now reaches the model. All 6 adapters were migrated onto it, and the transitional bridges were deleted (no `fromLegacyModel`/`asLegacyModel`/`LegacySingleStringModel`/`LegacyChatArgs` remain in code — every consumer speaks the canonical contract).
- **Phase 2 — the `@tenet/agent` driven turn (SHIPPED).** `runAgent` (`packages/agent/src/orchestrator.ts`) executes `OrchestratorState` as a `@tenet/workflow` graph: `injectionGate → retrieveNode → cacheNode → compactNode → criticLoop`, all fail-closed (`compactNode` = opt-in long-history compaction; a compaction error abstains, never sends a truncated prompt). The FAIL-CLOSED decides-and-drafts Reasoner (`modelReasoner` + `parseEnvelope`) is grounded-or-abstain (no `answer` without a non-blank citation; every ambiguity → `abstain`). `verifyAndEmit` is the single emit edge (verify → ≥1 grounded citation → outbound leak gate); tools run through governance (`runTools`); terminals are carried in `state.halt` with a `finalize` default + a top-level catch that fails closed on any error.

**Still pending (stated honestly):**

- **Real-model validation** of the decides-and-drafts prompt (`buildSystem`) — deferred until an API key exists in the build env. The control-flow guarantee does not depend on it. (The answer repair-retry — `RewriteFn` + re-verify in the `criticLoop` answer branch — is now shipped.)
- The verifier's own fail-CLOSED MODE ships (Phase 3.1 — `VerifierConfig.failClosed`: extractor error / judge error / judge-garbage / a truncated (`max_tokens`) or over-cap extraction → not-supported). The truncation + `maxClaims`-drop hardening (3.3) now ships too — verified in the tree: `claimExtractor.ts` throws under `failClosed` on both an over-cap AND a `max_tokens`-truncated extraction, and `reasoner.ts` abstains on a truncated draft. Still ahead: the non-numeric claim tier (3.2 — named-entity coverage + negation/scope guard).
- REAL-MODEL benchmark numbers still do not exist (no model access in this environment). The hermetic stub remains the only measured plane; keep the stub-vs-real split in the benchmark docs honest — no real-model numbers are claimed.

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
2. ~~**B3** (AbortSignal)~~ — DONE (`packages/core/src/model.ts:57`, required `signal`).
3. ~~**B2** (PathHandle factory)~~ — DONE (`packages/core/src/path.ts:58`, `openPath`).
4. ~~**C7 + C8 + C2** (models/bedrock + pgvector + rate-limit)~~ — DONE; all three packages landed.
5. ~~**C1** (`@tenet/retrieval`)~~ — DONE; package landed.
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
