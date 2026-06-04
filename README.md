# TENET — Verification-First AI Agent Framework

**Open-source TypeScript agent framework where hallucination defense, source-grounding, and platform rate-limit scheduling are first-class layers — not bolt-ons. One config powers Telegram, Discord, Slack, MS Teams, embedded web widget, REST/gRPC, and ticketing webhooks (Zendesk · Intercom · Freshdesk · ServiceNow).**

[![CI](https://github.com/zakky8/TENET/actions/workflows/ci.yml/badge.svg)](https://github.com/zakky8/TENET/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22+-43853d.svg)](.nvmrc)
[![TypeScript Strict](https://img.shields.io/badge/typescript-strict-3178c6.svg)](tsconfig.base.json)
[![Tests](https://img.shields.io/badge/tests-118%20passing-success)](packages)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-purple.svg)](CODE_OF_CONDUCT.md)

> **Status:** pre-MVP, v0.0.0. Architecture and benchmarks are public. APIs may change before v1.0.

---

## Why TENET

Existing options force a trade-off:

- **Closed enterprise agents** (Intercom Fin at $0.99 per resolution, Decagon, Sierra, Ada, Glean, Moveworks, Zendesk AI) lock you into proprietary helpdesk runtimes with outcome-based billing you can't audit.
- **OSS frameworks** (LangChain, LangGraph, CrewAI, AutoGen) ship CVE-class mistakes in production — three high-severity CVEs in six months including a 9.3 CVSS RCE with env-secret leak. Hallucination defenses remain opt-in bolt-ons.
- **Multi-surface coverage** (Telegram + Discord + Slack + Teams + web widget + ticketing) gets reinvented in every project, each with its own rate-limit, format, and webhook handling.

TENET answers each with a deliberate design choice. It's a clean-slate, verification-by-default, hardened-by-construction framework with every surface in one config.

## What you can build

- **Community moderation + Q&A bots** for Telegram / Discord servers — verified answers with citations, no hallucinated URLs.
- **Customer-support agents** that integrate with Zendesk / Intercom / Freshdesk / ServiceNow, emit outcome events for SLA reporting, and respect platform rate limits as a first-class scheduling primitive.
- **Internal IT helpdesk agents** for Slack / Teams with episodic memory and HITL escalation.
- **Developer/API support agents** with code-aware RAG and MCP-native tool use.
- **Web chat widgets** (SSE + JWT session) served from a single REST/gRPC backend.
- **Hybrid deployments** — same agent reachable on TG, Slack, web, and a ticketing webhook from one `tenet.config.ts`.

## Quick comparison

| | TENET | LangChain / LangGraph | CrewAI | Intercom Fin | Decagon / Sierra |
|---|---|---|---|---|---|
| License | Apache-2.0 | MIT | MIT | proprietary | proprietary |
| Verification by default | ✅ CoVe + Reflexion + 3-judge | opt-in | opt-in | opaque | opaque |
| Source-grounded URL allow-list | ✅ enforced at decode | manual | manual | yes | yes |
| Multi-surface, one config | ✅ 8+ | DIY | DIY | their UI only | their UI only |
| OpenTelemetry GenAI semconv | ✅ native | partial | partial | no | no |
| Outcome events (resolved / handed-off / disqualified / qualified) | ✅ first-class | DIY | DIY | yes (you can't read) | yes (you can't read) |
| WASM-sandboxed tool execution | ✅ planned | no | no | n/a | n/a |
| 2025-2026 high-severity CVEs | **0** | 3 | tbd | n/a | n/a |
| Self-host / on-prem | ✅ | ✅ | ✅ | no | enterprise add-on |
| TypeScript-native | ✅ | partial | python-first | n/a | n/a |
| Pricing | free (Apache-2.0) | free | free | $0.99 / resolution | enterprise quote |

Full per-dimension targets with citations: [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

## 100× targets (measured in CI, not in marketing)

| Dimension | Market today | TENET target | Multiplier |
|-----------|--------------|--------------|-----------|
| Hallucination rate | 5-10% | **< 0.1%** | ~100× |
| Cost per resolution | $0.99 (Intercom Fin) | **< $0.01** | ~100× |
| First-token latency p95 | 2-4s | **< 200ms** | ~10-20× |
| Time-to-integrate | days/weeks | **< 10 minutes** | ~1000× |
| High-severity CVEs / 6mo | 3 (LangChain) | **0** | floor |
| Eval-set size | ~100-500 cases | **1M+** auto-grown | ~1000× |
| Surfaces per config | 1-3 | **8+** | new category |

Method-of-attack per dimension + honest caveats: [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

## Differentiators

1. **Verification by default.** CoVe + Reflexion + 3-judge consensus + Constitutional Principles run on every output. Not opt-in.
2. **Source-grounded only.** URLs are constrained to a compiled allow-list at decode time. No model-recall URLs.
3. **CVE-class mistakes prevented by construction.** No `pickle`-style deserialization. No Jinja2 default. Parameterized queries with regex-validated filter keys. Path-allowlist on every file I/O. `Secret<T>` opaque type refuses `JSON.stringify`. SBOM + Trivy + audit in CI.
4. **All surfaces, one config.** Telegram + Discord + Slack + Teams + web widget + REST/gRPC + ticketing webhooks from a single `tenet.config.ts`. Each surface is a thin adapter.
5. **Rate-limit as scheduling primitive.** Per-platform token buckets and circuit breakers (Telegram 1/s/chat, Discord 10k-invalid IP-ban floor, Slack 4-tier, Teams 50 RPS/tenant, Zendesk 200-2500 rpm + endpoint sub-caps).
6. **Outcome events as first-class telemetry.** `resolved` / `handed_off` / `disqualified` / `qualified` emitted per conversation; operators wire their own SLA reporting or outcome billing.
7. **Hybrid contextual retrieval out of the box.** BM25 + dense + Anthropic contextual chunk prepending + cross-encoder rerank, with ColBERT/HyDE behind a `precise` mode switch.
8. **MCP-native tool use.** Tools are MCP servers from day 1. Sandboxed in WASM (planned), capability tokens.
9. **Eval-as-CI.** Golden dataset + LLM-as-judge runs on every PR. PR can't merge if eval regresses.
10. **Multi-tenancy + on-prem from day 1.** Per-tenant indexes, per-tenant secret stores, OTel export to customer-controlled collector.
11. **Self-distillation pipeline.** Verified flagship answers become weekly fine-tune data for the cheap-path model.
12. **Adaptive routing.** Classifier picks cheap-vs-flagship per turn; semantic answer cache; speculative streaming.

## Tech stack

- **TypeScript** strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- **Node 22+ LTS**, **pnpm workspaces** monorepo
- **OpenTelemetry GenAI semantic conventions** native
- **Anthropic** Claude Opus / Haiku · **AWS Bedrock** · **OpenAI** · **Google Gemini** · **Ollama** (self-host) — wrapper, never lock-in
- **Vector stores**: pgvector default · Qdrant · LanceDB · Pinecone optional
- **Embeddings**: Voyage 3 · OpenAI 3-large · BGE-large-en-v1.5
- **Rerankers**: Cohere Rerank 3.5 · BGE-Reranker-v2-M3 · jina-reranker-v2
- **Hallucination judge**: Vectara HHEM-2.1 + Patronus Lynx (independent, never self-judges)

## Repo layout

```
packages/    @tenet/core, verifier, retrieval, memory, rate-limit, telemetry, router, guardrails, policy
surfaces/    telegram, discord, slack, teams, web-widget, rest, grpc, webhook
connectors/  zendesk, intercom, freshdesk, servicenow
models/      bedrock, anthropic, openai, google, ollama
stores/      vector (pgvector, qdrant, lancedb) + state (postgres, redis)
apps/        community-bot, enterprise-support
eval/        harness, datasets, judges
infra/       docker, k8s, terraform
docs/        ARCHITECTURE.md, BENCHMARKS.md, ROADMAP.md, CHANGELOG.md
```

## Quick start

```bash
git clone https://github.com/zakky8/TENET.git
cd TENET
pnpm install
pnpm typecheck    # builds all packages in topological order
pnpm test         # 118 tests across 8 suites
```

End-to-end MVP (Telegram + AWS Bedrock + pgvector) coming in Phase 1 — track [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Component map, security stance, RAG reference stack, MVP slice, risks |
| [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) | 100× targets per dimension with method-of-attack + honest caveats |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases 0..4, deferred review items, anti-goals |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | Per-release notes |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, branching, PR rules, project values |
| [`SECURITY.md`](SECURITY.md) | Hardened-by-construction guarantees, disclosure policy |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Contributor Covenant 2.1 |

## Status

| Phase | Scope | Status |
|-------|-------|--------|
| 0 — Scaffold | repo layout, 4 MVP packages, types, verifier, policy, telemetry, CI, docs, 118 tests | ✓ done |
| 1 — MVP | core + verifier + retrieval (pgvector) + telemetry + Telegram + Bedrock + community-bot | in progress |
| 2 — Surfaces | Discord, Slack, Anthropic adapter, Qdrant, web widget | not started |
| 3 — Enterprise | Teams, REST/gRPC, ticketing connectors, enterprise-support app, on-prem Helm, MCP tool gateway, WASM sandbox | not started |
| 4 — Beat the benchmarks | drive every BENCHMARKS.md row from target to measured-in-CI | not started |

## Contributing

PRs welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). The project values (verification by default · source-grounded only · hardened by construction · measured not marketed) are non-negotiable — contributions that conflict get pushback even if the code is correct.

- **Bugs:** [open an issue](https://github.com/zakky8/TENET/issues/new?template=bug_report.yml)
- **Features:** [open a feature request](https://github.com/zakky8/TENET/issues/new?template=feature_request.yml)
- **Questions / discussion:** [GitHub Discussions](https://github.com/zakky8/TENET/discussions)
- **Security:** [private vulnerability report](https://github.com/zakky8/TENET/security/advisories/new) — never public issues

## License

[Apache-2.0](LICENSE). Use freely in commercial and non-commercial projects. The Apache patent grant matters for an agent framework that intersects multiple SaaS platform APIs — pick a license that gives you that grant.

## Acknowledgements

TENET stands on the shoulders of: Anthropic (Constitutional AI, Citations API, Contextual Retrieval, Claude Agent SDK), the OpenTelemetry GenAI semconv working group, the Model Context Protocol spec, Vectara (HHEM-2.1), Patronus Lynx, and the broader open-source RAG + agent community.

---

**Keywords for discovery:** open source AI agent framework · TypeScript agent SDK · LangChain alternative · hallucination-resistant LLM agent · RAG with citations · multi-channel chatbot framework · enterprise customer support agent · IT helpdesk AI · Telegram bot AI · Discord bot AI · Slack bot AI · Microsoft Teams AI · AWS Bedrock agent · Anthropic Claude agent · OpenAI GPT agent · Google Gemini agent · self-hosted agent · on-prem AI · OpenTelemetry GenAI · Model Context Protocol (MCP) · source-grounded LLM · verification-first agent · adversarial-reviewed agent framework · OSS agent monorepo
