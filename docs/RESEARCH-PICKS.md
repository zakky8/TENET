# Research Picks — Tier-1 Defaults

**As of:** 2026-06-04. Lists the default choices TENET makes for swappable subsystems where research-pass-1 left open questions or where one option is clearly the lower-friction starting point. Each pick is a recommendation, not a lock-in — the framework's interface-driven design lets operators swap any of these.

Companion to [PENDING.md](PENDING.md) (where these were tracked as open) and [BENCHMARKS.md §3](BENCHMARKS.md) (where the per-role model table lives).

---

## Eval / observability layer — **Langfuse (default)**

| Candidate | License | Self-host | OTel GenAI ingest | Pricing 10M traces / mo |
|---|---|---|---|---|
| **Langfuse** | MIT (kernel) | yes (single Docker) | yes (native OTLP) | self-host free; cloud ~$199/mo at scale |
| Arize Phoenix | Apache-2.0 | yes (single Docker) | yes (native OTLP) | self-host free |
| Braintrust | proprietary | enterprise tier | partial | usage-based |
| LangSmith | proprietary | enterprise tier | LangChain-shaped | per-user |
| Helicone | proprietary | yes | proxy-based | per-request |

**Why Langfuse as default**: MIT-licensed kernel, single-Docker self-host, native OTel GenAI ingestion (matches our telemetry-by-construction stance), strongest community traction in OSS agent stacks as of 2026-06-04. Phoenix is the close runner-up — strictly Apache-2.0 and Arize-backed — and TENET ships an interface that lets operators pick either without code changes.

**Concrete wiring**: `@tenet/telemetry` emits OTLP gRPC by default. Langfuse / Phoenix / vendor-of-choice receive on standard ports. We do not bundle the SDK; the OTel exporter is enough.

**Lock-in surface area**: zero. Spans are vendor-neutral; the only Langfuse-specific touch would be a future "session view" deep-link helper, which is optional.

---

## OpenTelemetry GenAI semantic conventions — **pin to spec draft current-as-of-this-commit**

| Aspect | Pick |
|---|---|
| Conformance | Subset: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.{input,output}_tokens`, `gen_ai.response.finish_reasons` |
| Stability tier | Spec is currently labeled **Experimental** in the OTel registry |
| Our policy | Pin to the spec version we tested against; bump intentionally as part of a documented release |

**Why "pin, don't track"**: experimental specs change attribute names without notice. Tracking head means breaking dashboards on every minor spec drift. The right altitude: we conform to a specific snapshot, document which one in [CHANGELOG.md](CHANGELOG.md), and re-snapshot deliberately on each minor release. Operators always know what their spans look like.

**Where conformance is asserted**: [`packages/telemetry/src/index.ts ATTR` constants](../packages/telemetry/src/index.ts) — the key strings are the canonical source.

**Out-of-spec extension**: anything under `agent.*` is TENET-coined and not part of the GenAI spec (per OTel guidance on app-specific keys).

---

## Hallucination judge — **Vectara HHEM-2.1 (primary) + Patronus Lynx (secondary)**

| Candidate | License | Latency | Use it for |
|---|---|---|---|
| **Vectara HHEM-2.1** | Apache-2.0 weights | <50ms on CPU | CI-gate sample of every PR's eval set |
| **Patronus Lynx** | Apache-2.0 | LLM-class | High-stakes spot checks; second opinion |
| RAGAS | Apache-2.0 | LLM-class | Multi-metric framework — overkill for the headline rate metric |

**Why HHEM-2.1 as primary**: small open-weights model, runs on CPU at sub-50ms per inference, drop-in for hallucination-rate scoring. Verified current best-in-class as of 2026-06-04 — no newer HHEM version published. Patronus Lynx as a heavier second opinion for sampled production traffic ensures we don't self-judge with one model.

**Why never self-judge with the responder model**: the verifier's whole point is independence. Using e.g. Claude Opus to judge Claude Opus's output is structurally biased.

**CI wiring**: `eval/judges/hhem.ts` (when shipped — Phase 1) loads HHEM-2.1 weights once, scores every eval-set output, fails the PR if mean score drops below the configured threshold.

---

## Reranker (placeholder picks for Phase 2)

Locking the exact reranker is **D6** in [PENDING.md](PENDING.md) — flagged for a focused head-to-head before phase-2 retrieval lands. Tentative ordering as of 2026-06-04:

1. **Cohere Rerank 3.5** — hosted, strongest public benchmark, paid per query
2. **BGE-Reranker-v2-M3** — Apache-2.0 weights, self-hostable, near-Cohere quality
3. **jina-reranker-v2.5** — Apache-2.0, faster than BGE-v2-M3 on similar hardware
4. **Voyage Rerank** — hosted, competitive with Cohere

The `Reranker` interface in `@tenet/retrieval` accepts any of these as a 4-line adapter.

---

## Why pick now

Two reasons pinning these BEFORE phase 1 lands:

1. **Avoid drift.** If we wait until phase 1 ships and then pick, every implementation choice cascades from whatever defaults we hit at that moment. Picking deliberately + documenting why means the choice is reviewable.
2. **Anti-cheat baseline.** [BENCHMARKS.md §5](BENCHMARKS.md) commits us to measuring against third-party numbers. The judge / observability / eval-layer picks here ARE the third-party machinery. They have to exist before the targets become measurable.

## What's still open

- **D6 reranker head-to-head** — tentatively ordered above, formally to be benchmarked.
- **A2 vector-store cost-perf at 10M-1B** — defer until we have real corpus volume.
- **A1 closed-tool architecture** — defer; doesn't block phase 1.
- **D4 OSS framework refresh** — useful for the next architecture review, doesn't block code.
