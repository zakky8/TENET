---
layout: default
title: "TENET — Verification-first TypeScript AI agent framework"
description: "An agent turn answers with a grounded, verified citation or it abstains — grounded-or-abstain. Fail-closed multi-judge verifier with deterministic pre-checks, pre-tool-call governance + approval + audit, WASM tool sandbox, MCP OAuth gateway, 9 surface adapters, 6 model adapters. Apache-2.0, pre-1.0."
image: /TENET/assets/og-image.svg
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  "name": "TENET",
  "description": "Verification-first, open-source TypeScript AI agent framework. An agent turn answers with a grounded, verified citation or it abstains (grounded-or-abstain). Fail-closed multi-judge verifier with deterministic pre-checks, pre-tool-call governance, WASM tool sandbox, MCP OAuth gateway.",
  "codeRepository": "https://github.com/zakky8/TENET",
  "programmingLanguage": "TypeScript",
  "license": "https://www.apache.org/licenses/LICENSE-2.0",
  "runtimePlatform": "Node.js",
  "keywords": ["AI agent framework", "hallucination", "grounded-or-abstain", "verifier", "LLM", "RAG", "governance", "MCP", "TypeScript"],
  "author": { "@type": "Organization", "name": "TENET contributors" }
}
</script>

# TENET

**Verification-first AI agent framework — open-source TypeScript.**

> An agent turn either answers with a **grounded, verified citation**, or it **abstains / hands off to a human**. It never states a fact it cannot ground in a source. That guarantee — *grounded-or-abstain* — is enforced in code, not in a prompt.

TENET is a framework, not a model: it *calls* whichever frontier model you bring and makes that turn provably harder to hallucinate through. Anti-hallucination, source-grounding, capability-token tool sandboxing, and pre-tool-call governance are first-class layers, not bolt-ons.

[Architecture](ARCHITECTURE.html) · [FAQ](FAQ.html) · [BENCHMARKS](BENCHMARKS.html) · [Roadmap](ROADMAP.html) · [GitHub →](https://github.com/zakky8/TENET)

## What ships today

Every row is a package in the monorepo — no capability claimed here that isn't in the code, and the repo's own numbers (**1275 tests across 96 suites**) are checked against the live suite in CI (`pnpm counts:check`).

| Capability | Package | What it does |
|---|---|---|
| **Fail-closed agent turn** | `@tenet/agent` | `runAgent` drives the turn as a graph to a **single emit edge**; abstain/handoff are carried as values (never thrown); a top-level catch fails closed to abstain. |
| **Deterministic verifier pre-checks** | `@tenet/verifier` | Before any LLM judge: quote-grounding, and fabrication checks for numbers (incl. spelled-out) and `http(s)://` URLs absent from the sources. |
| **Multi-judge verifier + fail-closed mode** | `@tenet/verifier` | Atomic-claim strict-then-permissive judging; an opt-in `failClosed` mode resolves extractor/judge infra failures to *not-supported*, never a spurious pass. |
| **HHEM judge adapter** | `@tenet/judge-hhem`, `@tenet/judge-hhem-onnx` | An adapter surface for a Vectara-HHEM-style hallucination judge — you bring the model weights; a deterministic token-overlap scorer ships as the reference. |
| **Pre-tool-call governance** | `@tenet/governance` | Per-tool deny / allow / require-approval policy, an idempotent approval gate, and a structured audit trail — the tool executor only sees policy-allowed calls. |
| **WASM tool sandbox** | `@tenet/tools-wasm-sandbox`, `…-wasmtime` | Capability-token-gated tool execution in a WASM sandbox (wasmtime adapter). |
| **MCP client + OAuth gateway** | `@tenet/tools-mcp`, `@tenet/tools-mcp-gateway` | Model Context Protocol tools with an OAuth gateway. |
| **Answer-quality orchestration** | `@tenet/refine` | Knowledge-boundary gate (abstain before drafting on thin retrieval), claim-repair loop, best-of-N, and a `groundedOrAbstain` reference orchestrator. |
| **Resilience** | `@tenet/rate-limit` | Retryable-vs-fatal error taxonomy, jittered-backoff retry that **fails closed** (never retries an AbortError / 4xx), and a circuit breaker. |
| **One canonical `ChatModel`** | `@tenet/core` + `models/*` | A messages array, a required `AbortSignal`, tool round-trips, and a lossless `StopReason` union — **6 model adapters** (Anthropic, OpenAI, Gemini, Mistral, Ollama, Bedrock) speak it. |
| **Surfaces & connectors** | `surfaces/*`, `connectors/*` | **9 surface adapters** (Discord, Slack, Telegram, Teams, web widget, REST, gRPC, Matrix, voice/Twilio) + ticketing connectors (Zendesk, Intercom, Freshdesk, ServiceNow), each transport-injected. |

## How a turn stays honest

```
inbound guard → retrieve + knowledge-boundary → cache re-verify → reason → tools → verify → EMIT
   (block →      (thin →                        (candidate       (ambiguity (fail  (uncited   the ONE
    handoff)      abstain)                       re-verified)     → abstain) →abstain)→abstain) place a
                                                                                             fact ships
```

A fact-bearing reply leaves the agent at **exactly one call site**, reachable only past the verifier, a grounded-citation guard, and an outbound leak gate. Every infrastructure failure — a verifier throw, a judge timeout, a truncated (`max_tokens`) response — resolves to **abstain**, never a shipped, unverified answer.

## The honest read

Measured, not marketed:

- **Pre-1.0.** APIs may change. The core is real and code-complete in the monorepo, with a green test suite gated in CI.
- **Benchmark numbers come from a hermetic CI stub SUT** — they measure the framework's *contracts*, not a frontier model's behavior. Real-model numbers are produced locally with your own API key (`apps/measure-real`), never asserted in-repo.
- **Surface adapters take an injected transport** you wire to a concrete client at composition.
- **The HHEM judge is an adapter**, not the model — you supply the weights.

## Get started

- **[README](https://github.com/zakky8/TENET#readme)** — quickstart and the capability map.
- **[SKILL.md](https://github.com/zakky8/TENET/blob/main/SKILL.md)** — a framework-agnostic guide to building a verification-first, grounded-or-abstain agent.
- **[FAQ](FAQ.html)** — how it prevents hallucination, what grounded-or-abstain means, supported models and surfaces, and whether it's production-ready.
- **[llms.txt](https://github.com/zakky8/TENET/blob/main/llms.txt)** — an LLM-readable index of the whole project.

Apache-2.0. Free to use, self-host, and modify.
