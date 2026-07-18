# Roadmap

**Status**: pre-1.0, v0.0.0 (branch `upgrade/top-1pct`). The product-roadmap phases below (0–5) are **code-complete in the monorepo** — scaffold, MVP spine, all surface + connector adapters, the BENCHMARKS gate, and streaming/provider breadth (surfaces take an injected transport; production wiring is per-operator). On top of that, the canonical `ChatModel` contract and the `@tenet/agent` orchestrator (`runAgent` drives the fail-closed turn end-to-end) are shipped. The current-state banner just below is the single canonical live status. Dates are targets, not promises.

Source of detail for each row: [ARCHITECTURE.md](ARCHITECTURE.md) (component map) and [BENCHMARKS.md](BENCHMARKS.md) (measurable targets).

---

> **State as of 2026-07-18 (branch `upgrade/top-1pct`):** 1288 tests passing across 97 suites, all green; 63 workspace packages. CI green. The 5 deferred review findings from the adversarial pass on `c9c9fb0` all shipped. The 7 open research questions all closed in [RESEARCH-PASS-2.md](RESEARCH-PASS-2.md).
>
> **Canonical-contract upgrade (complete):** `@tenet/core` now defines ONE `ChatModel` contract — a `ModelMessage[]` array, a REQUIRED `AbortSignal`, tool round-trips (`ContentBlock`: text | tool_use | tool_result), and a lossless `StopReason` union (`packages/core/src/model.ts`). It replaced four duplicated single-string `chat({system, user}): Promise<string>` interfaces. All 6 model adapters (anthropic, bedrock, google, mistral, ollama, openai) migrated, fixing three provider "abnormal stop" bugs that had reported an abnormal stop as a clean completion: Anthropic streaming truncation, Mistral `model_length` context overflow (`models/mistral/src/index.ts:60`), and Google content-block reasons — PROHIBITED_CONTENT / SPII / BLOCKLIST / IMAGE_SAFETY (`models/google/src/index.ts:73-76`) — now map to `max_tokens` / `refusal` instead of `end_turn`. `@tenet/verifier`, `@tenet/router`, `@tenet/streaming` (re-exports the canonical `StreamChunk`), `@tenet/ag-ui`, `apps/quickstart`, `apps/measure-real`, and `apps/community-bot` all speak the canonical contract; the transitional migration bridges were deleted — every consumer speaks the canonical contract, no bridges remain. The `${role}: ${content}` turn-spoof is gone from community-bot — history is structured `ModelMessage[]`, so a user message containing `assistant:` can no longer forge a prior assistant turn (`apps/community-bot/src/index.ts:114`), guarded by a wire-level role-spoof regression test in the Anthropic adapter.
>
> **Agent orchestrator (shipped):** the `@tenet/agent` package drives the full turn. `runAgent` (`packages/agent/src/orchestrator.ts`) executes `OrchestratorState` as a `@tenet/workflow` graph — `injectionGate → retrieveNode → cacheNode → criticLoop`, all fail-closed. The decides-and-drafts Reasoner (`modelReasoner` + `parseEnvelope`) is grounded-or-abstain (no answer without a non-blank citation; every ambiguity → `abstain`). `verifyAndEmit` is the single emit edge (verify → ≥1 grounded citation → outbound leak gate); tools run through governance (`runTools`); terminals are carried in `state.halt` with a `finalize` default + a top-level catch that fails closed on any error. A failed draft is rewritten (`deps.rewrite`) and re-verified through the same emit edge up to `maxRepairRounds`, then abstains. Follow-up (does not weaken the guarantee): real-model validation of the decides-and-drafts prompt.

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

## Phase 2 — Surfaces + adapters expansion (SHIPPED except where noted)

> AS-BUILT status, verified against the monorepo 2026-07-18. ✓ = adapter/code present; surfaces take an
> INJECTED transport (no hard SDK dependency), wired to the concrete client by the operator at composition.
> The current-state banner at the top of this doc is the single canonical live status.

| | Status |
|---|---|
| `surfaces/discord` (injected client, no discord.js hard dep) | ✓ |
| `surfaces/slack` | ✓ |
| `surfaces/web-widget` (SSE + JWT) | ✓ |
| `models/anthropic` — canonical `ChatModel` + `chatStream` (SSE), StopReason mapping | ✓ |
| `stores/vector/qdrant` | ✓ |
| `@tenet/memory-adapters` — mem0 / Letta / Zep providers | ✓ |
| Eval set growth to 1k+ cases via assertion mining | not started |

## Phase 3 — Enterprise (SHIPPED except where noted)

| | Status |
|---|---|
| `surfaces/teams` (Bot Framework + Adaptive Cards) | ✓ |
| `surfaces/rest` (OpenAPI 3.1) | ✓ |
| `surfaces/grpc` | ✓ |
| Ticketing webhook receiver (`connectors/ticketing`, HMAC-verified) | ✓ |
| `connectors/ticketing` — zendesk / intercom / freshdesk / servicenow modules | ✓ |
| `apps/enterprise-support` — full multi-surface reference | ✓ |
| On-prem Helm chart (`infra/helm/tenet`) | ✓ |
| SOC2 audit prep | not started (process; no code artifact) |
| MCP tool gateway with OAuth (`@tenet/tools-mcp-gateway`) | ✓ |
| WASM-sandboxed tool execution (`@tenet/tools-wasm-sandbox` + `-wasmtime`) | ✓ |

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

## Phase 6 — Pre-tool-call governance + memory consistency (DONE)
Two first-class layers most agent frameworks leave to custom integration — evaluating a tool call against policy *before* it executes, and read-after-write consistency for agent memory — ship here as code:
- `@tenet/governance` — `PolicyEvaluator` + `ApprovalGate` + `AuditSink`. Per-tool deny/allow/require-approval, idempotent approval keys, 6 typed audit event kinds, 4 built-in rule factories; the tool executor only ever sees policy-allowed calls.
- `@tenet/memory` consistency layer — a read-after-write consistency guarantee (`mintToken` / `WriteAck.readableAtMs` / `waitUntilReadable` / `resolveConflict`) so a just-written memory is readable before the next turn depends on it.

## Phases 7–14 — Breadth + protocols + security (DONE)
Shipped 2026-06-04: Gemini/Mistral/Ollama adapters, Bedrock + Anthropic streaming, OTLP wiring, voice surface (@tenet/voice + OpenAI Realtime + Twilio Media Streams), SKILL.md loader, Matrix surface, Dockerfile + health endpoints + pre-commit, @tenet/tool-call-repair + @tenet/net-policy, @tenet/acp (Agent Client Protocol), and a 23-finding vuln-test triage (44 bugs caught cumulatively across three adversarial review passes).

## Phase 15 — Top-0.01% market gaps (DONE, 2026-06-10)
Fresh A-to-Z audit (3 parallel reviewers) + live June-2026 market research identified the three TypeScript open lanes; all shipped:
- `@tenet/durable` — step-level durable execution: name-keyed journal replay, `interrupt()` HITL surviving process restarts, durable sleep, `StateStoreJournal` over Redis/Postgres.
- `@tenet/a2a` — Agent2Agent v1 server + client (Linux Foundation spec; ADK/CrewAI/MS-AF interop).
- `@tenet/ag-ui` — AG-UI event protocol + `streamChunksToAgUi` bridge from all 6 streaming model adapters.
- `@tenet/harness` — context compaction + todo ledger + bounded-concurrency subagents + handoff.
- `apps/quickstart` — `pnpm quickstart` zero-key REPL through the full retrieve→draft→verify pipeline.
- Truth restoration: Bedrock streaming actually shipped (task #83 had claimed it falsely), `stores/state/postgres` filled (was an empty dir), empty `surfaces/webhook` removed, README counts reconciled (see the current-state banner above for the live 1288 tests / 97 suites / 63 packages).

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
