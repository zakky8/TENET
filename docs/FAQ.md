---
layout: default
title: "TENET FAQ — verification-first AI agent framework"
description: "Answers to common questions about TENET: how it prevents hallucination, grounded-or-abstain, supported models and surfaces, how the verifier works, and whether it is production-ready."
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is TENET?",
      "acceptedAnswer": { "@type": "Answer", "text": "TENET is a verification-first, open-source TypeScript framework for building AI agents. Its guarantee is grounded-or-abstain: an agent turn either answers with a grounded, verified citation, or it abstains and hands off to a human — it never states a fact it cannot ground in a source. Anti-hallucination defense, source-grounding, capability-token tool sandboxing, and pre-tool-call governance are first-class layers, not bolt-ons. Apache-2.0, pre-1.0." }
    },
    {
      "@type": "Question",
      "name": "How does TENET prevent hallucination?",
      "acceptedAnswer": { "@type": "Answer", "text": "By making the safe outcome the default and enforcing it in code, not a prompt. The agent turn is a fail-closed graph: an inbound injection gate, a retrieval plus knowledge-boundary gate (thin evidence abstains), a cache re-verification step, a decides-and-drafts reasoner with no default answer (any ambiguity abstains), governance-gated tools, a fail-closed verifier, and a single emit edge. A fact-bearing reply can leave the agent at exactly one call site, reachable only past the verifier, a grounded-citation guard, and an outbound leak gate. The graph fails closed by default: a retriever error, a compaction error, or a truncated (max_tokens) response resolves to abstain, and the orchestrator's top-level catch turns any unexpected throw into one. The verifier's own infra failures (a judge timeout or an extractor error) are fail-open by default and resolve to not-supported only under the opt-in fail-closed mode." }
    },
    {
      "@type": "Question",
      "name": "What does grounded-or-abstain mean?",
      "acceptedAnswer": { "@type": "Answer", "text": "It is the one rule the whole framework serves: the worst acceptable outcome of a turn is a human handoff, never a wrong fact. If the agent cannot ground a claim in a retrieved source, it does not guess — it abstains and optionally routes to a person. This is enforced by the type system (the reasoner's result has no privileged answer variant) and by the verifier (a draft is not emitted unless a real, non-blank citation backs it)." }
    },
    {
      "@type": "Question",
      "name": "Is TENET a LangChain alternative?",
      "acceptedAnswer": { "@type": "Answer", "text": "Yes — TENET is an open-source agent framework you can use instead of, or alongside, other agent libraries. What it adds that most do not ship as a first-class layer: pre-tool-call governance (per-tool deny/allow/require-approval policy, an idempotent approval gate, and a structured audit trail), a fail-closed verifier with atomic-claim multi-judging plus deterministic pre-checks, and the grounded-or-abstain emit guarantee. TENET does not publish unsourced claims about other frameworks." }
    },
    {
      "@type": "Question",
      "name": "Does TENET run the model, or is it a model?",
      "acceptedAnswer": { "@type": "Answer", "text": "TENET is a framework, not a model. It does not train, fine-tune, or distill an LLM — it calls one, and makes whichever frontier model you call answer only with a source-grounded, verified citation or abstain. You bring the model and the API key." }
    },
    {
      "@type": "Question",
      "name": "What models does TENET support?",
      "acceptedAnswer": { "@type": "Answer", "text": "Six model adapters ship — Anthropic-direct, OpenAI, Google Gemini, Mistral, Ollama, and Amazon Bedrock — all streaming, all speaking one canonical ChatModel contract (a messages array, a required AbortSignal, tool round-trips, and a lossless StopReason union). Because the contract is uniform, swapping providers does not change your agent code." }
    },
    {
      "@type": "Question",
      "name": "How does the verifier work?",
      "acceptedAnswer": { "@type": "Answer", "text": "The verifier decomposes a draft into atomic claims and checks each. Cheap deterministic pre-checks run first: does a quoted number appear verbatim in the sources; a currency- or percent-marked value absent from the sources (in digits or spelled out) is fabrication evidence; a cited http(s) URL that appears nowhere in the sources is a fabricated link and fails, and a contact email absent from the sources is a fabricated address that fails the same way. Remaining claims go to a strict-then-permissive multi-judge. An opt-in fail-closed mode makes the verifier's own infrastructure failures resolve to not-supported instead of a spurious pass." }
    },
    {
      "@type": "Question",
      "name": "What is the single emit edge?",
      "acceptedAnswer": { "@type": "Answer", "text": "It is the one function in the whole turn that can turn a fact-bearing draft into a member-facing reply. It is reachable only after the verifier passes, at least one approved citation has a non-blank source id and quote, and an outbound leak filter clears the draft. Because emitting lives at one call site — and the loop code cannot construct a resolved reply itself — a fact cannot escape the agent through a cache path, a fast path, or an error path." }
    },
    {
      "@type": "Question",
      "name": "What channels and surfaces does TENET support?",
      "acceptedAnswer": { "@type": "Answer", "text": "Surface adapters ship for Discord, Slack, Telegram, Microsoft Teams, an embedded web widget, REST, gRPC, Matrix, and voice (Twilio), plus ticketing connectors for Zendesk, Intercom, Freshdesk, and ServiceNow. One configuration drives them; each adapter takes an injected transport (no hard SDK dependency), wired by the operator at composition." }
    },
    {
      "@type": "Question",
      "name": "Is TENET production-ready?",
      "acceptedAnswer": { "@type": "Answer", "text": "TENET is pre-1.0; APIs may change. The core is real and code-complete in the monorepo — the driven agent turn, the fail-closed verifier, governance, retrieval, and the surface/connector adapters all ship with a green test suite. Two honest caveats: surface adapters take an injected transport that you wire to a concrete client at composition, and the repository's benchmark numbers come from a hermetic CI stub — real-frontier-model numbers are produced locally with your own API key, not asserted in-repo." }
    },
    {
      "@type": "Question",
      "name": "How is TENET licensed?",
      "acceptedAnswer": { "@type": "Answer", "text": "Apache-2.0. It is free to use, self-host, and modify. There is an on-prem Helm chart (infra/helm/tenet) with security defaults for self-hosting." }
    },
    {
      "@type": "Question",
      "name": "How do I get started?",
      "acceptedAnswer": { "@type": "Answer", "text": "Install with pnpm, build, and run the tests and the hermetic benchmarks gate. See the README quickstart, the Architecture component map, and SKILL.md — a framework-agnostic guide to building a verification-first, grounded-or-abstain agent." }
    }
  ]
}
</script>

# Frequently asked questions

Answers are measured, not marketed: every capability named below is code in the monorepo, and the repo's own numbers are checked against the live test suite in CI.

## What is TENET?

TENET is a verification-first, open-source TypeScript framework for building AI agents. Its guarantee is **grounded-or-abstain**: an agent turn either answers with a grounded, verified citation, or it abstains / hands off to a human. It never states a fact it cannot ground in a source. Anti-hallucination defense, source-grounding, capability-token tool sandboxing, and pre-tool-call governance are first-class layers, not bolt-ons. Licensed Apache-2.0, pre-1.0.

## How does TENET prevent hallucination?

By making the safe outcome the *default* and enforcing it in code, not in a prompt. Concretely:

- The agent turn is a **fail-closed graph**: an inbound injection gate, a retrieval + knowledge-boundary gate (thin evidence → abstain), a cache re-verification step, a decides-and-drafts reasoner with **no default `answer`** (any ambiguity → abstain), governance-gated tools, a fail-closed verifier, and a **single emit edge**.
- A fact-bearing reply can leave the agent at **exactly one call site**, reachable only past the verifier, a grounded-citation guard, and an outbound leak gate. Every other outcome is a fixed safe message.
- The graph fails *closed* by default: a retriever error, a compaction error, or a truncated (`max_tokens`) response resolves to abstain, and the orchestrator's top-level catch turns any unexpected throw into one. The verifier's *own* infra failures — a judge timeout, an extractor error — are fail-*open* by default and resolve to *not-supported* only under the opt-in `failClosed` mode.

## What does "grounded-or-abstain" mean?

It is the one rule the whole framework serves: the worst acceptable outcome of a turn is a human handoff, never a wrong fact. If the agent cannot ground a claim in a retrieved source, it does not guess — it abstains and (optionally) routes to a person. This is enforced by the type system (the reasoner's result has no privileged "answer" variant) and by the verifier (a draft is not emitted unless a real, non-blank citation backs it).

## Is TENET a LangChain alternative?

Yes — TENET is an open-source agent framework you can use instead of, or alongside, other agent libraries. What it adds that most do not ship as a first-class layer: **pre-tool-call governance** (per-tool deny / allow / require-approval policy, an idempotent approval gate, and a structured audit trail), a **fail-closed verifier** with atomic-claim multi-judging plus deterministic pre-checks, and the **grounded-or-abstain** emit guarantee. TENET does not publish unsourced claims about other frameworks; treat any capability comparison you read as a starting point for your own verification.

## Does TENET run the model, or is it a model?

TENET is a framework, not a model. It does not train, fine-tune, or distill an LLM — it *calls* one, and makes whichever frontier model you call answer only with a source-grounded, verified citation or abstain. You bring the model and the API key.

## What models does TENET support?

Six model adapters ship — Anthropic-direct, OpenAI, Google Gemini, Mistral, Ollama, and Amazon Bedrock — all streaming, all speaking one canonical `ChatModel` contract (a messages array, a required `AbortSignal`, tool round-trips, and a lossless `StopReason` union). Because the contract is uniform, swapping providers does not change your agent code.

## How does the verifier work?

The verifier decomposes a draft into atomic claims and checks each. Cheap **deterministic pre-checks** run first (does a quoted number appear verbatim in the sources? a currency- or percent-marked value absent from the sources — in digits or spelled out, so "five hundred dollars" cannot dodge the check for "$500" — is fabrication evidence; a cited `http(s)://` URL that appears nowhere in the sources is a fabricated link and fails, and a contact email absent from the sources is a fabricated address that fails the same way) — deterministic comparison does not misread `$1.2M` versus `$1.5M`, or wave through an invented URL or email, the way an LLM judge can. Remaining claims go to a strict-then-permissive multi-judge. An opt-in **fail-closed mode** makes the verifier's own infrastructure failures (extractor error, judge error or garbage, an over-cap claim extraction) resolve to *not-supported* instead of a spurious pass.

## What is the "single emit edge"?

It is the one function in the whole turn that can turn a fact-bearing draft into a member-facing reply. It is reachable only after the verifier passes, at least one approved citation has a non-blank source id and quote, and an outbound leak filter clears the draft. Because emitting lives at one call site — and the loop code cannot even construct a "resolved" reply itself — a fact cannot escape the agent through a cache path, a fast path, or an error path.

## What channels and surfaces does TENET support?

Surface adapters ship for Discord, Slack, Telegram, Microsoft Teams, an embedded web widget, REST, gRPC, Matrix, and voice (Twilio), plus ticketing connectors for Zendesk, Intercom, Freshdesk, and ServiceNow. One configuration drives them; each adapter takes an injected transport (no hard SDK dependency), which the operator wires at composition.

## Is TENET production-ready?

TENET is pre-1.0; APIs may change. The core is real and code-complete in the monorepo — the driven agent turn, the fail-closed verifier, governance, retrieval, and the surface/connector adapters all ship with a green test suite. Two honest caveats: surface adapters take an injected transport that you wire to a concrete client at composition, and the repository's benchmark numbers come from a hermetic CI stub — real-frontier-model numbers are produced locally with your own API key, not asserted in-repo.

## How is TENET licensed?

Apache-2.0. It is free to use, self-host, and modify. There is an on-prem Helm chart (`infra/helm/tenet`) with security defaults for self-hosting.

## How do I get started?

Install with pnpm, build, and run the tests and the hermetic benchmarks gate. See the [README](../README.md) quickstart, the [Architecture](ARCHITECTURE.md) component map, and [SKILL.md](../SKILL.md) — a framework-agnostic guide to building a verification-first, grounded-or-abstain agent.
