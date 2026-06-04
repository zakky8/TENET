# TENET — Verification-First AI Agent Framework

**Open-source TypeScript agent framework where hallucination defense, source-grounding, capability-token tool sandboxing, and platform rate-limit scheduling are first-class layers — not bolt-ons. One config powers Telegram, Discord, Slack, MS Teams, embedded web widget, REST + gRPC, and ticketing webhooks (Zendesk · Intercom · Freshdesk · ServiceNow). Every BENCHMARKS row is gated in hermetic CI.**

[![CI](https://github.com/zakky8/TENET/actions/workflows/ci.yml/badge.svg)](https://github.com/zakky8/TENET/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22+-43853d.svg)](.nvmrc)
[![TypeScript Strict](https://img.shields.io/badge/typescript-strict-3178c6.svg)](tsconfig.base.json)
[![Tests](https://img.shields.io/badge/tests-905%20passing-success)](packages)
[![BENCHMARKS gated](https://img.shields.io/badge/BENCHMARKS-gated_in_CI-success)](docs/BENCHMARKS.md)
[![ES2024](https://img.shields.io/badge/target-ES2024-yellow.svg)](tsconfig.base.json)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-purple.svg)](CODE_OF_CONDUCT.md)

> **Status:** Phases 0 → 7 substantially complete. **736 tests across 63 suites, all green.** Every BENCHMARKS dimension measured in hermetic CI via `pnpm benchmarks`. 10 surfaces, 3 model adapters with streaming (Anthropic-direct, Bedrock, OpenAI), 2 vector stores, MCP client + OAuth gateway + WASM sandbox + production wasmtime adapter, on-prem Helm. Plus the OSS gap nobody else fills: **pre-tool-call governance + approval gates + structured audit trail** (`@tenet/governance`). APIs may change before v1.0.

---

## The honest read

This is a *framework*, not a model. It does not train, fine-tune, or distill a frontier LLM. Nothing here "beats" Claude / GPT / Gemini at language tasks — it *calls* them. The defensible claim is: **TENET makes whichever frontier model you call provably more grounded, cheaper per resolution, harder to jailbreak, and the only OSS framework with built-in tool-call governance + approval gates + audit trail.** That is a systems claim, and it is measurable. The BENCHMARKS gate runs every PR; numbers are produced, not asserted.

## Why this beats every OSS competitor (verified June 2026)

Web-fetched competitor research surfaced the gap nobody fills:

> *"None evaluates a tool call against a policy before it executes, none requires approval gates by default, none ships a structured audit trail without custom integration."* — Comparison of LangChain, LlamaIndex, Semantic Kernel agent frameworks (2026)

`@tenet/governance` ships all three: per-tool policy rules with deny/allow/require_approval, idempotent approval gate with cache, AuditSink emitting policy.allow / policy.deny / policy.require_approval / approval.decision / tool.invoked / override events. Plus we ship the things competitors miss individually:

| Capability | TENET | LangChain | Mastra | CrewAI | Pydantic-AI | OpenAI Agents | AutoGen | LlamaIndex |
|---|---|---|---|---|---|---|---|---|
| Pre-tool-call policy | **✅** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Approval gates (HITL) | **✅** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Structured audit trail | **✅** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Multi-judge verifier | **✅** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Independent hallucination judge (HHEM-2.1) | **✅** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| BENCHMARKS gated in CI on every PR | **✅** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| WASM sandbox + capability tokens | **✅** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Read-after-write memory consistency contract | **✅** | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| Streaming (token + structured) | **✅** | partial | ✅ | partial | ✅ | ✅ | ✗ | ✗ |
| Workflow DAG | **✅** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | partial |
| Multi-surface (10) one config | **✅** | ✗ | partial | ✗ | ✗ | ✗ | ✗ | ✗ |
| 2025-2026 high-severity CVEs | **0** | **3** | tbd | tbd | tbd | tbd | maintenance mode | tbd |
| On-prem Helm with security defaults | **✅** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Pricing | free Apache-2.0 | free | free | free | free | free | free | free |

The hermetic CI gate measures the **framework's measurement plane** (verifier contract, guardrail patterns, retriever scoring, gate logic) on bundled fixtures with a deterministic stub SUT. Real frontier-model numbers come from `@tenet/app-measure-real` which the operator runs locally with their own API key against `tenet-public-slice-0.1.0` or any swap-in dataset. The split is deliberate and the BENCHMARKS doc spells it out.

## What you can build

- **Community moderation + Q&A bots** for Telegram / Discord servers — verified answers with citations, no hallucinated URLs.
- **Customer-support agents** that integrate with Zendesk / Intercom / Freshdesk / ServiceNow, emit outcome events for SLA reporting, and respect platform rate limits as a first-class scheduling primitive.
- **Internal IT helpdesk agents** for Slack / Teams with episodic memory and HITL escalation.
- **Developer/API support agents** with code-aware RAG and MCP-native tool use, tool execution sandboxed in WASM with capability tokens.
- **Web chat widgets** (SSE + JWT session) served from a single REST/gRPC backend.
- **Multi-channel hybrid deployments** — same agent reachable on TG, Slack, web, and a ticketing webhook from one `tenet.config.ts`.

## BENCHMARKS — measured, not marketed

Measured on the hermetic stub gate (`pnpm benchmarks`) on 2026-06-04, scorer `@tenet/eval-metrics@0.1.0`. Every PR re-runs the gate.

| Dimension | Target | Measured (stub) | n | Verdict |
|---|---|---|---|---|
| Hallucination rate (claim contract) | < 0.001 | **0.00000** | 20 | PASS |
| Groundedness rate (atomic claims) | > 0.99 | **1.00000** | 20 | PASS |
| Cost per resolution (USD) | < 0.05 stub / < 0.01 real | **0.008** | 20 | PASS |
| TTFT p95 (ms) | < 250 stub / < 200 real | **206.350** | 20 | PASS |
| E2E latency p95 (ms) | < 1500 | **641.000** | 20 | PASS |
| Tool-call success rate | > 0.99 | **1.00000** | 12 | PASS |
| Prompt-injection block rate | > 0.99 | **1.00000** | 20 | PASS |
| Privacy / PII block rate | > 0.99 | **1.00000** | 8 | PASS |
| Retrieval recall @ K=10 | > 0.995 | **1.00000** | 10 | PASS |
| Router decision accuracy | > 0.95 | **1.00000** | 10 | PASS |
| Determinism (byte-stable verifier) | = 1.0 | **1.00000** | 10 | PASS |

**Reproduce:**

```bash
pnpm install
pnpm --filter @tenet/eval-metrics build
pnpm --filter @tenet/eval-measure build
pnpm benchmarks            # table + exit 1 on FAIL/MISSING
pnpm benchmarks:json       # JSON report for CI artifacts
```

**Real-model numbers** (operator runs locally with their API key):

```bash
ANTHROPIC_API_KEY=sk-ant-... \
  node --experimental-strip-types apps/measure-real/examples/anthropic-sonnet.ts
```

Method-of-attack per dimension + the honest stub-vs-real target split: [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

## Quick comparison

| | TENET | LangChain / LangGraph | Mastra | CrewAI | Intercom Fin | Decagon / Sierra |
|---|---|---|---|---|---|---|
| License | Apache-2.0 | MIT | MIT | MIT | proprietary | proprietary |
| Verification by default | ✅ multi-judge + 13 starter Principles | opt-in | opt-in | opt-in | opaque | opaque |
| Source-grounded URL allow-list | ✅ enforced at decode | manual | manual | manual | yes | yes |
| Hallucination judge (independent) | ✅ HHEM-2.1 adapter ships | DIY | DIY | DIY | opaque | opaque |
| Multi-surface, one config | ✅ 10 shipped | DIY | partial | DIY | their UI only | their UI only |
| OpenTelemetry GenAI semconv | ✅ native | partial | partial | partial | no | no |
| Outcome events (resolved / handed-off / disqualified / qualified) | ✅ first-class | DIY | DIY | DIY | yes (closed) | yes (closed) |
| Prompt-injection + system-prompt-leak guards | ✅ ship by default | opt-in | opt-in | opt-in | opaque | opaque |
| WASM-sandboxed tool execution | ✅ shipped (reference + wasmtime adapter) | no | no | no | n/a | n/a |
| MCP-native tools + OAuth gateway | ✅ shipped | partial | partial | no | no | no |
| BENCHMARKS rows gated in CI | ✅ every PR | no | no | no | n/a (closed) | n/a (closed) |
| 2025-2026 high-severity CVEs | **0** | 3 | tbd | tbd | n/a | n/a |
| Self-host / on-prem | ✅ Helm chart ships | ✅ | ✅ | ✅ | no | enterprise add-on |
| TypeScript-native | ✅ | partial | ✅ | python-first | n/a | n/a |
| Pricing | free (Apache-2.0) | free | free | free | $0.99 / resolution | enterprise quote |

## 12 differentiators

1. **Verification by default.** Atomic-claim multi-judge with strict + permissive merge, `ClaimPreFilter` / `JudgePromptDecorator` strategies, default `SourcePicker` + 12 trap-pattern adversarial examples. Not opt-in.
2. **Independent hallucination judge.** `@tenet/judge-hhem` ships the Vectara HHEM-2.1 contract; `@tenet/judge-hhem-onnx` wraps any local transformers.js / onnxruntime pipeline. No self-judging on the headline row.
3. **Source-grounded only.** URLs constrained to a compiled allow-list at decode time; URL-allowlist filter ships built-in.
4. **CVE-class mistakes prevented by construction.** No `pickle`-style deserialization. Parameterized queries. Regex-validated filter keys. Path-allowlist on every file I/O via `PathHandle` + `openPath()`. `Secret<T>` opaque type refuses `JSON.stringify`. SBOM + Trivy + audit in CI.
5. **WASM-sandboxed tools with capability tokens.** Tools declare `networkAllowList` / `readPaths` / `envKeys`; the gateway checks subset against tenant policy; the runtime enforces fuel + memory + wall-clock. Reference Node 22 runtime + production `@tenet/tools-wasm-sandbox-wasmtime` adapter. Per-call fresh instance.
6. **MCP-native tools with OAuth gateway.** RFC 9207 `iss` validation per the 2026-07-28 spec RC; per-tenant policy with `allowedTools` wildcard, `trustedIssuers` allow-list, per-tool rate-limit; audit sink emits `allow`/`deny`/`error` per call.
7. **All surfaces, one config.** Discord · Slack · Telegram · MS Teams · web widget (SSE + JWT) · REST (OpenAPI 3.1) · gRPC (.proto + handlers) · Zendesk · Intercom · Freshdesk · ServiceNow — 10 surfaces, one composition.
8. **Rate-limit as scheduling primitive.** Per-platform token buckets + circuit breakers (Telegram 1/s/chat, Discord 10k-invalid IP-ban floor, Slack 4-tier, Teams 50 RPS/tenant, Zendesk 200–2500 rpm + endpoint sub-caps).
9. **Outcome events as first-class telemetry.** `resolved` / `handed_off` / `disqualified` / `qualified` emitted per conversation; OutcomeEmitter has re-entrancy guard + swallowed-error reporter.
10. **Hybrid contextual retrieval.** BM25 + dense + RRF fusion + Anthropic-style contextual chunk prepending; pluggable reranker.
11. **BENCHMARKS gated in hermetic CI.** Every PR runs `pnpm benchmarks`. Failing dimension or missing measurement blocks merge. Measured.json artifacted with 90-day retention for trend tracking.
12. **Multi-tenancy + on-prem from day 1.** Per-tenant indexes, per-tenant secret stores, OTel export to customer-controlled collector. Helm chart with runAsNonRoot UID 10001, readOnlyRootFilesystem, NetworkPolicy, HPA.

## Tech stack

- **TypeScript** strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`, target **ES2024**
- **Node 22 LTS** (uses `Promise.withResolvers`, `Object.groupBy`, `Array.toSorted`, `AbortSignal.any`, native WebAssembly)
- **pnpm workspaces** monorepo (31 workspace projects)
- **OpenTelemetry GenAI** semantic conventions native
- **Models**: Anthropic-direct · AWS Bedrock · wrappers, never lock-in
- **Vector stores**: pgvector (≤50M vectors) · Qdrant (multi-tenant, 100M+)
- **State**: Redis adapter
- **Memory adapters**: mem0 · Letta · Zep
- **Hallucination judge**: Vectara HHEM-2.1 (adapter + ONNX wrapper)
- **WASM runtimes**: Node-22 reference + wasmtime adapter

## What ships today (24 workspace packages, 611 tests)

| Area | Packages |
|---|---|
| **Core** | `@tenet/core` · `@tenet/verifier` · `@tenet/policy` · `@tenet/telemetry` |
| **Pipeline** | `@tenet/rate-limit` · `@tenet/retrieval` · `@tenet/router` · `@tenet/memory` · `@tenet/guardrails` · `@tenet/memory-adapters` |
| **Surfaces** | `@tenet/surface-telegram` · `@tenet/surface-discord` · `@tenet/surface-slack` · `@tenet/surface-teams` · `@tenet/surface-web-widget` · `@tenet/surface-rest` · `@tenet/surface-grpc` |
| **Connectors** | `@tenet/connectors-ticketing` (Zendesk · Intercom · Freshdesk · ServiceNow) |
| **Models** | `@tenet/models-anthropic` · `@tenet/models-bedrock` |
| **Stores** | `@tenet/stores-vector-pgvector` · `@tenet/stores-vector-qdrant` · `@tenet/stores-state-redis` |
| **Tools** | `@tenet/tools-mcp` · `@tenet/tools-mcp-gateway` · `@tenet/tools-wasm-sandbox` · `@tenet/tools-wasm-sandbox-wasmtime` |
| **Eval** | `@tenet/eval-harness` · `@tenet/eval-metrics` · `@tenet/eval-measure` |
| **Judges** | `@tenet/judge-hhem` · `@tenet/judge-hhem-onnx` |
| **Apps** | `@tenet/app-community-bot` · `@tenet/app-enterprise-support` · `@tenet/app-measure-real` |
| **Infra** | `infra/helm/tenet` (on-prem Helm chart with security defaults) |

## Repo layout

```
packages/    core · verifier · policy · telemetry · rate-limit · retrieval · router · memory ·
             guardrails · memory-adapters · tools-mcp · tools-mcp-gateway · tools-wasm-sandbox ·
             tools-wasm-sandbox-wasmtime · judge-hhem · judge-hhem-onnx
surfaces/    telegram · discord · slack · teams · web-widget · rest · grpc
connectors/  ticketing (4 vendors)
models/      anthropic · bedrock
stores/      vector/{pgvector,qdrant} · state/redis
apps/        community-bot · enterprise-support · measure-real
eval/        harness · metrics · measure
infra/       helm/tenet
docs/        ARCHITECTURE · BENCHMARKS · ROADMAP · CHANGELOG · PENDING · RESEARCH-PICKS · RESEARCH-PASS-2
```

## Quick start

```bash
git clone https://github.com/zakky8/TENET.git
cd TENET
pnpm install
pnpm typecheck              # builds all packages in topological order
pnpm test                   # 611 tests across 53 suites
pnpm benchmarks             # hermetic BENCHMARKS gate (exits 1 on FAIL)
```

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Component map, security stance, RAG reference stack, MVP slice, risks |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) | Measured column per dimension + stub-vs-real target split + reproduce commands |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases 0..4 status, anti-goals |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Per-release notes |
| [`docs/PENDING.md`](docs/PENDING.md) | Open research questions + suggested execution order |
| [`docs/RESEARCH-PICKS.md`](docs/RESEARCH-PICKS.md) | Tier-1 defaults (eval layer, OTel version, judge model) |
| [`docs/RESEARCH-PASS-2.md`](docs/RESEARCH-PASS-2.md) | Closed-tool architecture, vector-store benchmark at 100M, MCP adoption, reranker head-to-head |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, branching, PR rules, project values |
| [`SECURITY.md`](SECURITY.md) | Threat model + hardened-by-construction guarantees + disclosure policy |

## Status

| Phase | Scope | Status |
|-------|-------|--------|
| 0 — Scaffold | Repo, CI, core types, verifier, policy, telemetry, docs | ✅ done |
| 1 — MVP | retrieval · rate-limit · guardrails · router · memory · telegram · bedrock · pgvector · redis · community-bot · eval-harness | ✅ done |
| 2 — Surfaces + adapters | Discord, Slack, web widget, Anthropic-direct, Qdrant, mem0/Letta/Zep, MCP-native | ✅ done |
| 3 — Enterprise | Teams, REST, gRPC, 4 ticketing connectors, enterprise-support, Helm, MCP gateway, WASM sandbox | ✅ done |
| 4 — Beat the benchmarks | eval-metrics scorers · eval-measure runner + CI gate · HHEM judge adapter + ONNX wrapper · wasmtime runtime adapter · real-model measure runner · BENCHMARKS measured column | ✅ done |

## What's still pending

Honest list. None of these block shipping; each is a real-model leverage rung.

1. **Real HHEM-2.1 model bytes** — `@tenet/judge-hhem-onnx` wraps any HF / ONNX pipeline; the operator brings the model weights (license / install choice is theirs).
2. **Real-fetch integration job in CI** — secret-gated workflow that runs `apps/measure-real/examples/anthropic-sonnet.ts` when `ANTHROPIC_API_KEY` is set. Never blocks PRs from forks.
3. **Self-distillation loop** — BENCHMARKS Dim 2 ("cost < $0.01") depends on weekly LoRA fine-tunes of a cheap-path model on verified flagship traces. Trace capture ships; the fine-tune pipeline does not.
4. **Auto-grown eval set** — Dim 7 (">1M assertions") needs the assertion-mining + dedup-via-embedding-clustering pipeline. Not shipped.
5. **PENDING.md Bucket A + D research refresh** — Anthropic SDK feature surface (D1), MCP spec changelog (D2), reranker head-to-head (D6), closed-tool architecture (A1), vector-store cost-perf at 1B (A2).

## Contributing

PRs welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). The project values (verification by default · source-grounded only · hardened by construction · measured not marketed) are non-negotiable — contributions that conflict get pushback even if the code is correct.

- **Bugs:** [open an issue](https://github.com/zakky8/TENET/issues/new?template=bug_report.yml)
- **Features:** [open a feature request](https://github.com/zakky8/TENET/issues/new?template=feature_request.yml)
- **Questions / discussion:** [GitHub Discussions](https://github.com/zakky8/TENET/discussions)
- **Security:** [private vulnerability report](https://github.com/zakky8/TENET/security/advisories/new) — never public issues

## License

[Apache-2.0](LICENSE). Use freely in commercial and non-commercial projects. The Apache patent grant matters for an agent framework that intersects multiple SaaS platform APIs.

## Acknowledgements

- **Anthropic** — Constitutional AI (Bai et al. 2022 → our `STANDARD_PRINCIPLES`), Citations API, Contextual Retrieval recipe, Claude Agent SDK.
- **DeepMind / OpenAI prompt-engineering research** — Chain-of-Verification (Dhuliawala et al. 2023), Reflexion (Shinn et al. 2023), Sycophancy (Sharma et al. 2024 → our P11).
- **Wang et al. 2024** — Speculative RAG (-51% latency / +13% accuracy → our `SpeculativeAgent`).
- **Cormack et al. 2009** — Reciprocal Rank Fusion → our `reciprocalRankFusion`.
- **The OpenTelemetry GenAI** semantic conventions working group.
- **The Model Context Protocol** spec maintainers + the 2026-07-28 RC iss-validation contributors.
- **Vectara (HHEM-2.1)** + **Patronus Lynx** — independent hallucination judges.
- **Bytecode Alliance (wasmtime)** — production WASM engine reference.
- **Mastra, Pydantic-AI, Letta, OpenAI Agents SDK** — OSS agent-framework ecosystem we compete with and learn from.

---

**Keywords for discovery:** open source AI agent framework · TypeScript agent SDK · LangChain alternative · hallucination-resistant LLM agent · RAG with citations · multi-channel chatbot framework · enterprise customer support agent · IT helpdesk AI · Telegram bot AI · Discord bot AI · Slack bot AI · Microsoft Teams AI · AWS Bedrock agent · Anthropic Claude agent · self-hosted agent · on-prem AI · OpenTelemetry GenAI · Model Context Protocol (MCP) · MCP OAuth gateway · WASM tool sandbox · capability tokens · Vectara HHEM-2.1 · source-grounded LLM · verification-first agent · adversarial-reviewed agent framework · BENCHMARKS-gated CI · OSS agent monorepo
