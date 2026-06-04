# Roadmap

**Status**: pre-MVP, v0.0.0. The doc tracks what's done, what's next, and what's deferred. Dates are targets, not promises.

Source of detail for each row: [ARCHITECTURE.md](ARCHITECTURE.md) (component map) and [BENCHMARKS.md](BENCHMARKS.md) (measurable targets).

---

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

## Phase 1 — MVP (in progress)

The smallest end-to-end vertical that proves the spine. From [ARCHITECTURE.md §12](ARCHITECTURE.md).

| | Status |
|---|---|
| `@tenet/retrieval` — hybrid (BM25 + dense) + contextual chunk prepending + rerank | not started |
| `@tenet/rate-limit` — token-bucket scheduler per platform | not started |
| `@tenet/guardrails` — PII redactor, input filter | not started |
| `@tenet/router` — adaptive cost-aware router + speculative agent | not started |
| `@tenet/memory` — episodic + semantic + working | not started |
| `surfaces/telegram` — grammY adapter | not started |
| `models/bedrock` — AWS Bedrock adapter | not started |
| `stores/vector/pgvector` — default vector store | not started |
| `stores/state/redis` — conversation state | not started |
| `apps/community-bot` — first reference deployment | not started |
| `eval/harness` — eval-as-CI runner with LLM-as-judge | not started |
| Golden eval dataset (~100 cases) committed | not started |

**MVP success criteria** (from ARCHITECTURE.md §12):
1. Conversations replay through the new runtime end-to-end.
2. CoVe + Reflexion + citation enforcement run on every output (not opt-in).
3. Telegram rate-limit policy enforced — simulate flood, observe queueing.
4. OTel spans visible in a local Jaeger.
5. CI runs eval suite as a gate.

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

## Phase 4 — Beat the benchmarks

Drive each row in [BENCHMARKS.md](BENCHMARKS.md) from "target" to "measured in CI":

- Hallucination rate < 0.1% (Vectara HHEM-2.1 in CI)
- Cost per resolution < $0.01 (adaptive routing + cache + self-distillation)
- TTFT p95 < 200ms (speculative streaming + warm cache)
- Time-to-integrate < 10 min (one config, one-line surface add)
- Eval set > 1M assertions (auto-grown from production)

---

## Deferred from adversarial review (carried as known work)

Surfaced by the 2026-06-04 review pass. Severity-ranked, ready to land when the affected layer reaches phase 1:

- **buildCitations** — naive 30-char head-substring match; replace with a `pickBackingSource(claim, sources)` strategy in `@tenet/core`.
- **PathHandle factory** — type promises protection but the `openPath()` factory doesn't exist. Either ship the factory (per-process allow-list root, abs-path rejection) or remove the type until the fs package lands.
- **ChatModel.chat AbortSignal** — Promise.race timeout in withTimeout rejects, but the underlying HTTP request keeps running. Add `signal: AbortSignal` to ChatModel.chat and propagate.
- **OutcomeEmitter** — sink-isolation try/catch swallows all errors including infinite recursion and programmer mistakes. Add a re-entrancy guard + log swallowed errors at warn level (without recursing back through emit).
- **VerifierConfig altitude** — `allowedUrlPatterns` and `adversarialExamples` are app-specific concepts in framework code. Replace with pluggable `ClaimPreFilter` and `JudgePromptDecorator` interfaces.

---

## Anti-goals (will NOT do)

- Multi-language framework runtime (Java/Go/Rust). gRPC clients in those languages are fine; the runtime stays TS.
- Hosting the user's LLM. We wrap providers.
- Operating a low-code UI. SDK + YAML config; UIs come after the core is stable.
- Specific-app coupling in the `packages/` tree. App-specific code lives under `apps/`.
