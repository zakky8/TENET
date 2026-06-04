# Changelog

All notable changes to TENET are recorded here. Format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 the API surface and behavior may change without major bumps. We will pin breaking changes by minor version (`0.X.Y`).

## [Unreleased]

### Added — Phase 7 (competitor weakness exploit, 2026-06-04)
Web-verified competitor research (LangChain, LangGraph, AutoGen, CrewAI, LlamaIndex, Semantic Kernel, Mastra, Pydantic-AI, OpenAI Agents, mem0, Letta, Zep) surfaced specific weaknesses. We shipped fixes for the ones we can exploit.
- **`@tenet/governance`** — the unfilled OSS gap. 2026 research: *"None evaluates a tool call against a policy before it executes, none requires approval gates by default, none ships a structured audit trail without custom integration."* We ship all three: `PolicyEvaluator` with deny/allow/require_approval, `ApprovalGate` with idempotency cache, `AuditSink` with 6 typed event kinds, built-in rules (`allowListRule`, `tagRequiresApprovalRule`, `denyArgPatternRule`, `numericLimitRule`), stable approval keys (argument-order independent). 17 tests.
- **`@tenet/memory` consistency layer** — fixes the mem0 indexing-reliability + Zep post-ingestion-retrieval bug class. `mintToken` (deterministic idempotency), `WriteAck.readableAtMs`, `waitUntilReadable` with exponential backoff + abort, `resolveConflict` with explicit policies (last_write_wins / first_write_wins / merge). 13 tests.
- **`@tenet/models-anthropic.chatStream()`** — SSE-streamed Anthropic Messages API. Closes our last own gap. Honors `content_block_delta`, `message_delta` usage, `message_stop`. Emits `StreamChunk` shapes from `@tenet/streaming` so the verifier and `measureTtft` see one consistent shape across providers.

### Added — Phase 6 (close 3 OSS gaps, 2026-06-04)
- **`@tenet/streaming`** — non-breaking streaming ChatModel contract + SSE parser + incremental JSON parser (Pydantic-AI's structured-output pattern, generalised).
- **`@tenet/models-openai`** — direct OpenAI Chat Completions adapter, no SDK dep. Implements both `chat()` and `chatStream()`.
- **`@tenet/workflow`** — deterministic DAG primitives: sequential / parallel / branch / retry / withTimeout + per-step trace events.

### Added — Phase 5 (research-led residuals, 2026-06-04)
- `@tenet/distillation` — verified flagship trace capture + LoRA JSONL emitter.
- `@tenet/eval-mining` — assertion miner + cosine dedup + EvalCase emitter.
- `@tenet/rerank-cohere` — Cohere Rerank v2 API adapter, fetch-injected.
- `packages/judge-hhem-onnx/examples/transformers-pipeline.ts` — operator wiring for real HHEM-2.1.
- `.github/workflows/measure-real.yml` — secret-gated real-model harness on cron.
- `docs/RESEARCH-PASS-3.md` — operator-led research scaffold per source-hierarchy rules.

### Added — Phase 4 (BENCHMARKS gated in CI, 2026-06-04)
- `@tenet/eval-metrics` — Wilson-95 + quantile + per-dimension scorers.
- `@tenet/eval-measure` — hermetic measurement runner + CLI; 11/11 dimensions PASS on stub gate.
- `@tenet/judge-hhem` — Vectara HHEM-2.1 contract + reference token-overlap scorer.
- `@tenet/app-measure-real` — real-ChatModel runner + PUBLIC_SLICE (`tenet-public-slice-0.1.0`).
- `@tenet/tools-wasm-sandbox-wasmtime` — production wasmtime WasmRuntime adapter.
- `.github/workflows/ci.yml` benchmarks-gate job — fails any PR on FAIL/MISSING; uploads measured.json artifact.

### Added — Phase 1 MVP packages — all landed:
  - `@tenet/rate-limit` — `TokenBucket` + `CircuitBreaker` + `RateLimitScheduler` with 5 platform policies (Telegram, Discord, Slack, Teams, Zendesk).
  - `@tenet/guardrails` — `PiiRedactor` (7 kinds) + composable `Filter` chain (`lengthFilter`, `denylistFilter`, `runFilterChain`).
  - `@tenet/retrieval` — `Bm25Index` (Okapi BM25 with Lucene-style IDF smoothing) + `InMemoryVectorStore` + `reciprocalRankFusion` (Cormack 2009) + `HybridPipeline` with per-stage metrics.
  - `@tenet/router` — `AdaptiveRouter` (classifier-driven tier picking + flagship fallback) + `InMemorySemanticAnswerCache` (cosine LRU) + `SpeculativeAgent` (cheap + flagship in parallel, verifier-driven promotion).
  - `@tenet/memory` — `WorkingMemory` (ring buffer with token-budget cap) + `InMemoryEpisodicMemory` (per-conversation history) + `InMemorySemanticMemory` (cross-conversation facts with confidence-aware eviction).
  - `@tenet/models-bedrock` — `AnthropicOnBedrockChatModel`; no AWS SDK hard dep (injected invoker).
  - `@tenet/stores-vector-pgvector` — `PgVectorStore`; no pg SDK hard dep (injected query executor); all values parameter-bound; table name validated against `/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`.
  - `@tenet/stores-state-redis` — `StateStore` interface + `InMemoryStateStore` (TTL + LRU eviction) + `RedisStateStore` adapter.
  - `@tenet/surface-telegram` — `TelegramSurface` adapter with HTML escaping, citation rendering, optional rate-limit gate.
  - `@tenet/eval-harness` — `runEval` + 5 builtin assertions + `regressionGate` for eval-as-CI.
  - `@tenet/app-community-bot` — reference composition wiring all of the above.
- **Adversarial-review bug fixes (5):**
  - B1 — `SourcePicker` strategy replaces `buildCitations`' naive head-substring match.
  - B2 — `openPath()` factory shipped; `PathHandle` type is no longer vapor.
  - B3 — `ChatModel.chat` accepts `AbortSignal`; `withTimeoutAndSignal` aborts the controller on timer fire.
  - B4 — `OutcomeEmitter` re-entrancy guard (`MAX_EMIT_DEPTH=4`) + `SwallowedErrorReporter` callback.
  - B5 — `ClaimPreFilter` + `JudgePromptDecorator` interfaces; `urlAllowlistFilter` + `examplesDecorator` factories.
- Scaffolded the four MVP packages: `@tenet/core`, `@tenet/verifier`, `@tenet/policy`, `@tenet/telemetry`.
- `Secret<T>` opaque type that refuses `JSON.stringify`, blocks the LangChain CVE-2025-68664-class secret-leak.
- `Filter<TKey>` + `validateFilterKey` that reject `--`, `..`, and any non-`[a-zA-Z0-9_.-]` characters in metadata filter keys — blocks the CVE-2025-67644-class SQL-injection path.
- `PathHandle` branded type for path-allowlisted file I/O (factory pending).
- `TenetError` with stable error codes (`VERIFIER_FAILED`, `RETRIEVAL_FAILED`, `MODEL_FAILED`, `RATE_LIMITED`, `TIMEOUT`, `INVALID_INPUT`, `PERMISSION_DENIED`, `INTERNAL`).
- `OutcomeEvent` first-class telemetry primitive (`resolved` / `handed_off` / `disqualified` / `qualified` / `pending`).
- `OutcomeEmitter` with sink isolation — a broken sink can't kill the telemetry pipeline.
- `CostMeter` with per-model pricing; throws by default on unknown model to surface config typos.
- `PrincipleRegistry` for Constitutional-Principles composition + drift `fingerprint()`.
- Atomic-claim multi-judge verifier (strict pass + permissive re-judge of failures only).
- Index-based permissive merge that survives duplicate-claim strings (fix #10).
- 118 unit tests across 8 suites.
- ARCHITECTURE.md, BENCHMARKS.md, ROADMAP.md.
- CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, issue + PR templates.
- GitHub Actions CI: build / typecheck / lint / test / audit / Trivy / eval-regression.
- Apache-2.0 LICENSE, `.gitattributes`, `.editorconfig`, `.nvmrc`.

### Changed
- `isClaimAboutAllowedUrl` switched from case-insensitive substring match to URL-extraction + hostname normalization. Fixes the lookalike-domain bypass (`notexample.com` ⊁ `example.com`).
- `claimExtractor` list-marker strip narrowed from `/^[\s\-•*\d.)]+/` to recognised markers only (`1.`, `1)`, `(1)`, `-`, `*`, `•`). Bare leading digits in claims are preserved.
- `judge.ts` partial-parse fallback split: when SOME lines parsed, missing indices default to UNSUPPORTED (fail-closed). When ZERO lines parsed, missing default to supported (fail-open on judge total breakage). Stops silently shipping fabrications.
- `PrincipleRegistry.replace()` now runs the same `validate()` as `register()` — empty rules and version < 1 are rejected on replace.
- `CostMeter.record()` now throws on unknown model by default; opt-in `'skip'` policy preserves silent-skip for allowlist mode.
- Removed `composite: true` from base tsconfig + project references. Each package builds with plain `tsc` in pnpm-topological order.
- Removed `.github/dependabot.yml` to enforce a single-branch policy. Dep updates land as explicit commits on main.

### Security
- `SECURITY.md` routes vulnerability reports through GitHub Private Vulnerability Reporting; no mailbox.
- Trivy + pnpm audit run in CI (informational pre-1.0; gates tighten at v1.0).
