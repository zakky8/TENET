# Roadmap

**Status**: pre-MVP, v0.0.0. The doc tracks what's done, what's next, and what's deferred. Dates are targets, not promises.

Source of detail for each row: [ARCHITECTURE.md](ARCHITECTURE.md) (component map) and [BENCHMARKS.md](BENCHMARKS.md) (measurable targets).

---

> **State as of 2026-06-04:** Phase 0 + Phase 1 MVP packages all landed. 327 tests passing across 31 suites. CI green. The 5 deferred review findings from the adversarial pass on `c9c9fb0` all shipped. The 7 open research questions all closed in [RESEARCH-PASS-2.md](RESEARCH-PASS-2.md).

## Phase 0 — Scaffold (DONE)

| | Done |
|---|---|
| Repo layout, license, security policy | ✓ |
| pnpm workspaces, TS strict + ESM | ✓ |
| CI: typecheck + lint + test + audit + Trivy + eval-regression | ✓ |
| `@tenet/core` types (Conversation, Surface, Filter, Secret, PathHandle, OutcomeEvent) | ✓ |
| `@tenet/verifier` atomic-claim multi-judge | ✓ |
| `@tenet/policy` Constitutional Principles registry + composer + drift fingerprint | ✓ |
| `@tenet/telemetry` OTel GenAI semconv + outcome events + CostMeter | ✓ |
| Adversarial code review pass + 6 confirmed bugs fixed | ✓ |
| 118 unit tests across 8 suites | ✓ |
| `docs/ARCHITECTURE.md` + `docs/BENCHMARKS.md` | ✓ |
| CONTRIBUTING / CODE_OF_CONDUCT / issue + PR templates | ✓ |

## Phase 1 — MVP (LANDED — code complete; production wiring TBD)

The smallest end-to-end vertical that proves the spine. From [ARCHITECTURE.md §12](ARCHITECTURE.md).

| | Status |
|---|---|
| `@tenet/retrieval` — Bm25Index + InMemoryVectorStore + RRF fusion + HybridPipeline | ✓ |
| `@tenet/rate-limit` — TokenBucket + CircuitBreaker + RateLimitScheduler + 5 platform policies | ✓ |
| `@tenet/guardrails` — PII redactor (7 kinds), composable filters | ✓ |
| `@tenet/router` — AdaptiveRouter + InMemorySemanticAnswerCache + SpeculativeAgent | ✓ |
| `@tenet/memory` — WorkingMemory + InMemoryEpisodicMemory + InMemorySemanticMemory | ✓ |
| `surfaces/telegram` — TelegramSurface adapter (HTML formatter, citation rendering, rate-limit gate) | ✓ |
| `models/bedrock` — AnthropicOnBedrockChatModel (no AWS SDK hard dep) | ✓ |
| `stores/vector/pgvector` — PgVectorStore adapter (no pg SDK hard dep, all values parameter-bound) | ✓ |
| `stores/state/redis` — InMemoryStateStore + RedisStateStore adapter | ✓ |
| `apps/community-bot` — CommunityBot reference composition | ✓ |
| `eval/harness` — runEval + builtinAssertions + regressionGate | ✓ |
| Golden eval dataset (~100 cases) committed | not started — Phase 2 |
| End-to-end smoke run against real Bedrock | not started — Phase 2 |

**MVP success criteria** (from ARCHITECTURE.md §12):
1. ~~Conversations replay through the new runtime end-to-end.~~ → composition shipped in `@tenet/app-community-bot`; real-LLM smoke run pending.
2. ~~CoVe + Reflexion + citation enforcement run on every output (not opt-in).~~ → atomic-claim multi-judge verifier wired; CoVe / Reflexion as `JudgePromptDecorator` strategies (B5).
3. ~~Telegram rate-limit policy enforced — simulate flood, observe queueing.~~ → `RateLimitScheduler` with `TELEGRAM_POLICY`; integration test pending.
4. OTel spans visible in a local Jaeger. → semconv keys defined in `@tenet/telemetry`; exporter wiring pending.
5. CI runs eval suite as a gate. → `@tenet/eval-harness` + `regressionGate` ship the primitive; CI workflow integration pending.

## Phase 2 — Surfaces + adapters expansion

| | Status |
|---|---|
| `surfaces/discord` (discord.js) | not started |
| `surfaces/slack` (Bolt; Marketplace + internal modes) | not started |
| `surfaces/web-widget` (SSE + JWT) | not started |
| `models/anthropic` | not started |
| `stores/vector/qdrant` (multi-tenant default) | not started |
| `@tenet/memory` adapter for mem0 / Letta | not started |
| Eval set growth to 1k+ cases via assertion mining | not started |

## Phase 3 — Enterprise

| | Status |
|---|---|
| `surfaces/teams` (Bot Framework + Adaptive Cards) | not started |
| `surfaces/rest` (OpenAPI 3.1) | not started |
| `surfaces/grpc` | not started |
| `surfaces/webhook` — ticketing receiver | not started |
| `connectors/zendesk` / `intercom` / `freshdesk` / `servicenow` | not started |
| `apps/enterprise-support` — full multi-surface reference | not started |
| On-prem Helm chart | not started |
| SOC2 audit prep | not started |
| MCP tool gateway with OAuth | not started |
| WASM-sandboxed tool execution | not started |

## Phase 4 — Beat the benchmarks (DONE)

Every row in [BENCHMARKS.md](BENCHMARKS.md) measured + CI-gated:
- `@tenet/eval-metrics` — Wilson-95, quantile, per-dimension scorers
- `@tenet/eval-measure` — hermetic runner + CLI; **11/11 dimensions PASS** on stub gate (exit 0 in CI)
- `@tenet/judge-hhem` (+ `@tenet/judge-hhem-onnx` for real HHEM-2.1)
- `@tenet/app-measure-real` — real-ChatModel runner (operator brings keys)
- `@tenet/tools-wasm-sandbox-wasmtime` — production WASM runtime
- `@tenet/distillation`, `@tenet/eval-mining`, `@tenet/rerank-cohere` shipped

## Phase 5 — Streaming + provider breadth (DONE)
- `@tenet/streaming` — SSE parser + incremental JSON + StreamChunk contract
- `@tenet/models-openai` — direct OpenAI Chat Completions, chat + chatStream
- `@tenet/models-anthropic.chatStream()` — Anthropic SSE streaming
- `@tenet/workflow` — sequential / parallel / branch / retry / withTimeout DAG primitives

## Phase 6 — Competitor weakness exploit (DONE)
Web-verified research (LangChain, AutoGen, CrewAI, LlamaIndex, Semantic Kernel, Mastra, Pydantic-AI, OpenAI Agents, mem0, Letta, Zep). The 2026 confirmed quote: *"None evaluates a tool call against a policy before it executes, none requires approval gates by default, none ships a structured audit trail without custom integration."* We ship all three:
- `@tenet/governance` — `PolicyEvaluator` + `ApprovalGate` + `AuditSink`. Idempotent approval keys; 6 typed audit event kinds; 4 built-in rule factories.
- `@tenet/memory` consistency layer — fixes mem0 indexing-reliability + Zep read-after-write bug class. `mintToken` / `WriteAck.readableAtMs` / `waitUntilReadable` / `resolveConflict`.

---

## Deferred from adversarial review — ALL LANDED

Surfaced by the 2026-06-04 review pass, all five shipped:

- ~~**buildCitations**~~ — replaced with pluggable `SourcePicker` strategy in `@tenet/core` + default impl in `@tenet/verifier`. Two-stage fallback (head substring + significant-token overlap). Commit `43709a0`.
- ~~**PathHandle factory**~~ — `configurePathRoot()` + `openPath()` shipped in `@tenet/core`. Abs paths, `..` traversal, root-escape all rejected at construction. Commit `509442b`.
- ~~**ChatModel.chat AbortSignal**~~ — propagated through `ChatModel` interface; new `withTimeoutAndSignal` helper aborts the controller on timer fire. Commit `487a79c`.
- ~~**OutcomeEmitter**~~ — re-entrancy guard (`MAX_EMIT_DEPTH=4`) + `SwallowedErrorReporter` callback. Sink errors no longer disappear silently. Commit `4ae6811`.
- ~~**VerifierConfig altitude**~~ — `ClaimPreFilter` + `JudgePromptDecorator` interfaces in `@tenet/verifier`; built-in factories `urlAllowlistFilter` + `examplesDecorator`. App-supplied strategies run first, convenience fields last. Commit `74ea0f5`.

---

## Anti-goals (will NOT do)

- Multi-language framework runtime (Java/Go/Rust). gRPC clients in those languages are fine; the runtime stays TS.
- Hosting the user's LLM. We wrap providers.
- Operating a low-code UI. SDK + YAML config; UIs come after the core is stable.
- Specific-app coupling in the `packages/` tree. App-specific code lives under `apps/`.
