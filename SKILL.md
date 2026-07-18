---
name: verification-first-agent
description: "Use when building or hardening an AI agent that must not hallucinate — a grounded-or-abstain turn that answers only with a verified citation or hands off, and fails closed at every edge."
license: Apache-2.0
homepage: "https://github.com/zakky8/TENET"
user-invocable: true
---

# Build a verification-first, grounded-or-abstain agent

This skill distills how to build an AI support/answering agent whose **worst possible outcome is a human handoff, never an ungrounded fact**. It is framework-agnostic — the principles apply whether you use TENET, another library, or hand-rolled code — and it names the TENET packages that implement each idea as a reference.

## The one rule

> An agent turn either answers with a grounded, verified citation, or it abstains / hands off. It never states a fact it cannot ground in a source.

Everything below serves that rule. If a design choice would let the agent emit text it could not verify, it is wrong — even if it makes the agent more helpful, and even if the tests are green. Green tests over a fail-open path are a worse bug than a red test.

## The shape of a fail-closed turn

Drive the turn as an explicit graph whose terminals are **values, not exceptions**:

```
inbound guard → retrieve + knowledge-boundary → cache re-verify → reason → tools → verify → EMIT
      │               │                              │              │        │        │        │
   (block →         (thin →                      (candidate     (ambiguity (fail  (uncited   the ONE
    handoff)         abstain)                     only,          → abstain) →abstain) →abstain) place a
                                                  re-verified)                               fact ships
```

Carry the terminal decision in the state (`halt`), not by throwing. A short-circuit guard makes every downstream node a no-op once a terminal is set, and a finalizer converts the carried terminal into the reply — **defaulting to abstain if the graph somehow ends without one.** A top-level `try/catch` turns any thrown error (timeout, crash) into an abstain, so a real handoff (a value) is never mistaken for a failure.

*Reference: `@tenet/agent` (`runAgent` in `orchestrator.ts`), `@tenet/workflow` (the graph engine).*

## Techniques

1. **No default answer.** Make the model's decision a discriminated union — `answer | tool | handoff | abstain` — with **no privileged variant**. Any ambiguity (a parse failure, an unknown action, a missing field, a refusal, an abort, a truncation, an uncited draft) resolves to `abstain`, enforced in the parser, not left to the model. Make the illegal state unrepresentable in the type.

2. **Exactly one emit edge.** A fact-bearing draft becomes a member-facing reply at **one call site only**, reachable solely past the verifier. Everywhere else returns a fixed safe message. Enforce it structurally: the loop code should not even import the "emit" builder, so it *cannot* mint a resolved answer on its own. *Reference: `verifyAndEmit` in `@tenet/agent/emit.ts`.*

3. **Require a grounded citation to emit.** A verifier that passes a draft with zero citations must still not ship it — emit only when at least one approved citation has a non-blank source id AND quote. This closes the "vacuously verified" gap (a draft with no extractable claims is not the same as a grounded answer). *Reference: the grounded-citation guard in `emit.ts`.*

4. **Fail CLOSED on infra failure.** A verifier throw, a judge timeout, a retriever error, a truncated (`max_tokens`) model response, an over-cap claim extraction — all resolve to abstain, never ship. Truncation especially: a response cut off at the token limit may be incomplete, so treat `stopReason: max_tokens` as abstain. *Reference: `failClosed` mode in `@tenet/verifier`; the reasoner's stop-reason handling.*

5. **Verify against the sources, deterministically first.** Decompose the draft into atomic claims and check each. Settle what you can with cheap deterministic checks (does the quoted number appear verbatim in the sources? a currency/percent value absent from sources — whether in digits or spelled out, "five hundred dollars" — is fabrication evidence; a cited `http(s)://` URL, or a contact email, that is nowhere in the sources is a fabricated link/address) before spending an LLM judge — deterministic string comparison does not misread `$1.2M` vs `$1.5M`, or wave through an invented URL or email, the way a judge can. A number, URL, or email being *present* never passes a claim (it could be misattributed); only absence can *fail* it. *Reference: `@tenet/verifier` deterministic pre-checks + atomic-claim multi-judge.*

6. **Gate tools before they run.** Evaluate every tool call against policy (deny / allow / require-approval) BEFORE executing any of them; a single non-allow denies the whole batch with zero side effects. An autonomous turn cannot satisfy an approval, so treat `require_approval` as "cannot proceed" → hand off. Emit an audit event per decision. *Reference: `@tenet/governance` + `runTools` in `@tenet/agent`.*

7. **Retrieve, then gate on the knowledge boundary.** Score retrieved evidence by relevance (not by a correctness prior), and abstain BEFORE drafting if coverage is too thin. A cache hit is a *candidate* draft only — re-verify it through the same emit edge; never emit a cached answer directly. *Reference: the retrieve/cache nodes in `@tenet/agent`; `knowledgeBoundaryGate` in `@tenet/refine`.*

8. **Give the model a required `AbortSignal`.** A cancelled turn must release the in-flight model call and resolve to abstain — no zombie requests, no shipped partial answer.

## Anti-patterns (these are how agents hallucinate)

- **Fail-OPEN on a broken judge.** "The judge errored, so mark everything supported so we don't block shipping" ships fabrications on exactly the days your judge is down. Fail closed.
- **Multiple emit sites.** If a fact can leave the agent from more than one place (a cache path, a fast path, an error path), one of them will eventually skip verification.
- **Silent truncation / dropped claims.** Slicing a claim list to a cap, or ignoring `max_tokens`, means unverified content ships unnoticed. Surface it as unverifiable → abstain.
- **Trusting a clean stop reason.** A provider reporting an abnormal stop (truncation, content filter, context overflow) as a normal `end_turn` masks a failure. Preserve the real stop reason losslessly.
- **Absence as proof of a negative.** "The sources don't mention X, so 'we do not offer X' is supported" is a fabrication. A negative claim needs *positive* grounding.
- **Prompt-only guarantees.** "The system prompt says always cite sources" is not enforcement. Enforce in code: a schema, a parser, a gate.

## Build checklist

- [ ] The turn's result type has no default `answer`; every ambiguity maps to `abstain`.
- [ ] Exactly one call site emits a fact-bearing reply, and it is past the verifier + a grounded-citation guard + an outbound leak gate.
- [ ] Verifier/extractor/judge/retriever failures and `max_tokens` truncation all abstain.
- [ ] Tool calls are policy-gated before execution; `require_approval` hands off; every decision is audited.
- [ ] Thin retrieval abstains before drafting; cache hits are re-verified, never emitted directly.
- [ ] The model call takes a required `AbortSignal`; cancellation abstains.
- [ ] Each fail-closed edge has a test that goes RED if the edge starts failing open.

## Reference implementation

TENET (`github.com/zakky8/TENET`, Apache-2.0) implements this end to end: `@tenet/agent` (the driven turn), `@tenet/verifier` (fail-closed multi-judge), `@tenet/refine` (knowledge-boundary + repair), `@tenet/guardrails` (filters + leak gate), `@tenet/governance` (pre-tool-call policy + audit), and `@tenet/core` (the canonical `ChatModel` contract). See [docs/design/agent-turn.md](docs/design/agent-turn.md) for the per-edge fail-closed inventory.
