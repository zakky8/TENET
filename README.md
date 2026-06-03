# TENET

> Verification-first, multi-surface AI agent platform. Community-grade to enterprise technical support.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22+-green.svg)](.nvmrc)

## What is this

TENET is an open-source agent framework that ships with verification, source-grounding, and platform rate-limit scheduling as first-class layers — not bolt-ons. One config powers Telegram, Discord, Slack, MS Teams, embedded web widget, REST/gRPC, and ticketing webhooks (Zendesk / Intercom / Freshdesk / ServiceNow).

**Status: pre-MVP, v0.0.0.** Architecture is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Why another agent framework

We surveyed the 2025/2026 landscape ([research report cached on contributor machines]):

- **Closed enterprise leaders** (Intercom Fin at $0.99/resolution, Decagon, Sierra, Ada, Glean, Moveworks) lock customers into proprietary helpdesk runtimes.
- **OSS frameworks** (LangChain, LangGraph, CrewAI, AutoGen) shipped three high-severity CVEs in six months including a 9.3 CVSS RCE/secret-leak.
- **Hallucination defenses** are still opt-in bolt-ons in nearly every framework.
- **Multi-surface** is duplicated across teams; nobody ships one config for all chat + ticketing surfaces.

TENET answers each with a deliberate design choice. See [docs/ARCHITECTURE.md §3](docs/ARCHITECTURE.md).

## Differentiators

| # | What |
|---|------|
| 1 | Verification by default (CoVe + Reflexion + Constitutional Principles, not opt-in) |
| 2 | Source-grounded only (URLs in output constrained to a compiled allow-list) |
| 3 | CVE-class mistakes prevented by construction (no `pickle`, no Jinja2 default, parameterized queries, path allow-list) |
| 4 | All surfaces, one config |
| 5 | Rate-limit as scheduling primitive (per-platform token buckets, circuit breakers) |
| 6 | Outcome as first-class telemetry primitive (`resolved` / `handed_off` / `disqualified` / `qualified`) |
| 7 | Hybrid contextual retrieval out of the box (BM25 + dense + contextual chunk prepending + rerank) |
| 8 | MCP-native tool use |
| 9 | Eval-as-CI |
| 10 | Multi-tenancy + on-prem from day 1 |

## Repo layout

```
packages/    runtime, verifier, retrieval, memory, rate-limit, telemetry, router, guardrails, policy
surfaces/    telegram, discord, slack, teams, web-widget, rest, grpc, webhook
connectors/  zendesk, intercom, freshdesk, servicenow
models/      bedrock, anthropic, openai, google, ollama
stores/      vector (pgvector, qdrant, lancedb) + state (postgres, redis)
apps/        community-bot, enterprise-support
eval/        harness, datasets, judges
infra/       docker, k8s, terraform
docs/
```

## Quick start (TBD — MVP not landed)

```bash
pnpm install
pnpm build
pnpm test
```

## Status

| Phase | Scope | Status |
|-------|-------|--------|
| MVP | core + verifier + retrieval (pgvector) + telemetry + Telegram + Bedrock + community-bot | in progress |
| Phase 2 | Discord, Slack, Anthropic adapter, Qdrant, web widget | not started |
| Phase 3 | Teams, REST/gRPC, ticketing connectors, enterprise-support app, on-prem Helm | not started |

## Contributing

Architecture, security policy, and code-of-conduct land first. PRs welcome once MVP is green.

## License

Apache-2.0 — see [LICENSE](LICENSE).

## Security

See [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities.
