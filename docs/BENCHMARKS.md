# TENET — 100× Targets

**Status:** Draft v0.2 — measured column live
**Date:** 2026-06-04
**Measurement plane:** `@tenet/eval-measure` against bundled hermetic fixtures + a deterministic stub SUT.

This is not a marketing doc. Every row below is a measurable target with a citation for the current market number, a concrete technique to reach our target, and the phase we ship it in. We will be evaluated against these numbers, not the prose around them.

"100×" is interpreted dimension-by-dimension — sometimes it means a 100× reduction (cost, hallucination), sometimes a 100× multiplier (eval-set size, integration speed), sometimes "as close to zero as physics allows" (CVE count). When 100× is genuinely unphysical, we say so and aim for the floor instead.

---

## 0. What is measured today (v0.0.0 framework gate)

The numbers in §1 below are produced by `pnpm tenet measure` against the bundled hermetic fixtures + a **deterministic stub SUT**. They measure the framework's measurement plane — the verifier contract, the guardrail patterns, the retriever scoring, the gate logic — **not** a frontier model's behavior. Replacing the stub with a real `ChatModel` produces frontier-model numbers; the operator runs that locally with their own keys.

This distinction is enforced by the source-hierarchy rule: framework-measured numbers are Tier-1 evidence about the framework. A claim like "TENET + Claude Sonnet gets X% hallucination rate" requires running the same harness with the Anthropic adapter on a published dataset, and is reported separately.

**Measurement methodology:**
- Hermetic fixtures: 80 cases (20 QA + 20 injection + 12 tool-call + 10 retrieval + 10 router + 8 privacy) bundled in `eval/measure/src/fixtures.ts`. These model TruthfulQA / JailbreakBench / BeIR shapes but are NOT those datasets (license + hermeticity).
- Deterministic stub SUT (`eval/measure/src/stubSut.ts`): zero entropy, zero network, byte-reproducible.
- Scorers in `@tenet/eval-metrics`: Wilson-95 CI on rates, linear-interpolation p95 on latency.
- Gate in `@tenet/eval-metrics`: per-dimension target check + optional regression-vs-baseline delta.

**Reproduce:**
```bash
pnpm install
pnpm --filter @tenet/eval-metrics build
pnpm --filter @tenet/eval-measure build
node eval/measure/dist/cli.js
# exits non-zero on any failing gate verdict
```

---

## 1. The targets — with measured column

Measured against stub SUT + bundled fixtures on 2026-06-04, scorer `@tenet/eval-metrics@0.1.0`. `n` = sample size for that scorer.

> **Dim 1 / 1b are measured, not an identity pass.** Each QA fixture carries a distractor-bearing corpus, and the stub *selects* its citation by term-overlap retrieval over it — a distractor out-overlapping the relevant chunk would cite an ungrounded id and push these off 0.00000 / 1.00000. The tests include a distractor-dominant case that makes verification fail, proving the metric has teeth.

| # | Dimension | Target | Measured (v0.0.0 stub) | n | Verdict | Phase |
|---|-----------|--------|------------------------|---|---------|-------|
| 1 | **Hallucination rate** (1 - groundedness on cited-claim contract) | < 0.001 | **0.00000** | 20 | PASS | MVP gate |
| 1b | **Groundedness rate** (atomic-claim verifier contract) | > 0.99 | **1.00000** | 20 | PASS | MVP gate |
| 2 | **Cost per resolved conversation** (USD) | < 0.01 | **0.008** | 20 | PASS | Phase 2 |
| 3 | **First-token latency p95** (ms) | real-SUT < 200 / **stub < 250** | **206.350** | 20 | PASS (stub band; see split below) | Phase 2 |
| 4 | **End-to-end resolution latency p95** (ms) | < 1500 | **641.000** | 20 | PASS | Phase 2 |
| 7 | **Tool-call success rate** | > 0.99 | **1.00000** | 12 | PASS | Phase 2 |
| 8 | **Retrieval recall @ K=10** | > 0.995 | **1.00000** | 10 | PASS | Phase 2 |
| 10a | **Prompt-injection block rate** | > 0.99 | **1.00000** | 20 | PASS | Phase 3 |
| 10b | **Privacy leak block rate** (PII redactor agrees w/ ground truth) | > 0.99 | **1.00000** | 8 | PASS | Phase 2 |
| — | **Cost-aware router decision accuracy** | > 0.95 | **1.00000** | 10 | PASS | Phase 2 |
| — | **Determinism rate** (byte-stable verifier under temp=0) | = 1.0 | **1.00000** | 10 | PASS | MVP gate |

**Stub vs real-SUT target split (Dim 3):** The stub SUT's synthetic TTFT band is 80–219 ms (`stubTtftMs(i) = 80 + (i*7) % 140`), producing p95 = 206.35 ms over 20 cases. The real-SUT target stays < 200 ms. The hermetic CI gate uses the stub band (< 250 ms with a 5 ms regression-vs-baseline tolerance against 206.35) so the gate catches stub drift without paraphrasing the stub as proof of the real-model target. Operators ship real-model numbers via a separate harness with `REAL_TARGETS` (exported from `@tenet/eval-measure`).

**Note on rows not measured here:**
- **Dim 5 (time-to-integrate < 10 min):** measured by stopwatch on a clean machine, not in CI. Reported per release.
- **Dim 6 (zero CVEs):** measured by Trivy / npm audit / GitHub Advisories in CI; not a numeric scorer row.
- **Dim 7 (eval-set size > 1M):** auto-grown from production; v0.0.0 bundled set is 80 cases (framework gate), not the production-growth corpus.
- **Dim 9 (8+ surfaces):** structural count — currently shipped: Discord, Slack, Telegram, Teams, web widget, REST, gRPC, 4 ticketing connectors. Count = **11** distinct surfaces (PASS by structural count).
- **Dim 10 escape rate:** measured by red-team test suite, not a scorer. The WASM sandbox's `WasmPolicyError` codes are the contract.

**Original market-vs-target framing (preserved for context):**

| # | Dimension | Market today | TENET target | Multiplier |
|---|-----------|--------------|--------------|-----------|
| 1 | **Hallucination rate** | 5-10% production ([Vectara HHEM-2.1 leaderboard](https://huggingface.co/spaces/vectara/leaderboard)) | < 0.1% | ~100× |
| 2 | **Cost / resolution** | $0.99 (Intercom Fin, accessed 2026-06-03) | < $0.01 | ~100× |
| 3 | **TTFT p95** | 2-4s typical hosted enterprise agents | < 200ms | ~10-20× |
| 4 | **E2E p95** | 8-15s typical | < 1.5s | ~5-10× |
| 5 | **Time-to-integrate** | Days-weeks closed; months DIY | < 10 min | ~1000× |
| 6 | **High-sev CVEs / 6mo** | the deserialization / template-injection RCE class recurs across the ecosystem (attributed to no named project) | 0 | floor |
| 7 | **Eval-set size** | ~100-500 manual | 1,000,000+ auto-grown | ~1000-10000× |
| 8 | **Retrieval failure @ K=10** | 1.9% @ K=20 (Anthropic Contextual Retrieval) | < 0.5% @ K=10 | ~4× |
| 9 | **Surfaces / config** | 1-3 closed / 1 DIY | 8+ | new category |
| 10 | **Tool-execution escapes** | Untracked in most frameworks (template-injection / unsafe-deserialization RCE class) | 0 (WASM isolated) | floor |

---

## 2. Method-of-attack per dimension

### Dim 1 — Hallucination < 0.1%

We don't trust the model. Every output passes a parallel verifier stack before emission. Hallucination cannot be reduced 100× by prompting alone; it requires layered constraints.

**Stack (all run on every output, not opt-in):**

1. **Source-grounded constraint** — output may only reference URLs/facts present in retrieved chunks. URL allow-list compiled from indexed sources at index time, enforced at decode time via constrained generation where the model supports it (Anthropic structured outputs, OpenAI structured outputs, Bedrock structured outputs), otherwise post-decode regex check.
2. **Chain-of-Verification (CoVe)** — model generates verification questions for its own claims, answers them against retrieved context, and reconciles. Failed claims are dropped or trigger HITL.
3. **Reflexion checklist** — N-item self-critique against Constitutional Principles. Lifted from TENET (~25 KG temporal guards + 13 Principles).
4. **Multi-judge consensus** — 3 independent verifier passes with different lenses (correctness / source-grounding / sycophancy). Need 2/3 to pass. Mirrors adversarial-verify pattern from research-pass-1.
5. **Citation enforcement** — output schema requires `{claim, source_chunk_id}` pairs. Claims without citations are stripped before emission.
6. **HHEM-2.1 judge adapter (optional, operator-run)** — an HHEM-style third-party hallucination detector, wired by the operator against their own runtime, scores a sample of outputs. It runs on the operator's real-model plane, NOT the hermetic CI stub plane (which has no real-model access).

**Measured how:** an HHEM-2.1 adapter, wired by the operator against their own runtime (not the hermetic CI plane), scores sampled outputs. Target = mean score > 0.999 on hallucination-detection.

**Honest caveat:** "< 0.1%" assumes retrieved sources are themselves correct. Garbage-in still produces garbage-out — we add a `source.confidence` score per chunk so the verifier can flag low-confidence retrieval as "I'm not sure".

---

### Dim 2 — Cost per resolution < $0.01

Today's $0.99 is set by routing every turn through a flagship model. Cost collapses when 95% of turns can be served by a small model and only 5% escalate.

**Stack:**

1. **Adaptive routing** — classifier (small distilled model, <100M params) decides per-turn: cheap path (e.g. Haiku 4.5 / Llama 3.3 8B distilled) or escalation (Opus 4.8 / Sonnet 4.6). Easy intents (FAQ lookup, link return) hit cheap path; only ambiguous/novel queries escalate.
2. **Semantic answer cache** — Redis-backed embedding cache. Queries within ε of a prior verified answer return cached. Hit rate target > 40% in mature deployments. Each hit costs ~$0 (one embedding call).
3. **Speculative streaming** — start streaming cheap-model answer immediately; flagship runs in parallel; if verifier disagrees with cheap stream, revoke (rare, < 5% of cheap-path turns).
4. **Self-distillation** — every verified flagship answer is logged as a (query, answer, citations) tuple. Weekly fine-tune of the cheap-path model on this corpus (LoRA / QLoRA). Cheap path's quality climbs without flagship cost.
5. **Bedrock provisioned throughput** for high-volume tenants — flat rate dominates pay-per-token at >10M tokens/day.

**Measured how:** OTel span `agent.cost_usd` summed per `agent.outcome=resolved` conversation. Reported per-tenant in dashboard.

**Honest caveat:** $0.01 is reachable only at scale where caching pays off and distillation is fresh. Low-volume tenants will see closer to $0.05-0.10 — still a 10× win on Fin.

---

### Dim 3 — First-token latency p95 < 200ms

**Stack:**

1. **Streaming from token 0** — no pre-emit verifier blocking; verifier runs in parallel, revokes on disagreement.
2. **Semantic answer cache** (see #2) — cache hits emit pre-formed first tokens in < 10ms.
3. **Speculative agent** — run cheap-model + flagship-model in parallel. Whichever streams first wins; flagship verifies in parallel.
4. **Embedding cache** — query embedding cached; identical queries skip embed call.
5. **Edge-deployable retrieval** — hybrid retrieval engine runs in-process (pgvector + tantivy/BM25), no network hop for retrieval.
6. **Cold-path retrieval prefetch** — when classifier predicts retrieval-needed, kick off retrieval in parallel with model thinking.

**Measured how:** OTel span `gen_ai.response.time_to_first_token`. CI fails on p95 regression > 10%.

**Honest caveat:** p95 < 200ms across all surfaces is optimistic for cold cache; warm-cache hit rate is what makes the headline true. Cold path may sit at 500-800ms.

---

### Dim 4 — End-to-end resolution latency p95 < 1.5s

Same stack as Dim 3 plus:

1. **Parallel tool execution** — tool calls within a turn run concurrently when independent. MCP supports this.
2. **Speculative tool prefetch** — when classifier is confident a specific tool will be needed, fetch in parallel with model decision.
3. **Streaming verification** — verifier checks chunks as they stream, not after completion. Failure revokes mid-stream.

**Measured how:** OTel span `agent.turn.duration_ms` from inbound event to outbound complete.

---

### Dim 5 — Time-to-integrate < 10 minutes

**Stack:**

1. **One config, all surfaces** — `tenet.config.ts` declares surfaces. Adding Slack = add three lines + paste bot token.
2. **Auto-KB ingest** — `pnpm tenet ingest <url>` crawls + chunks + contextualizes + indexes. No manual chunking. Targets: GitBook, Notion, Confluence, Zendesk Help Center, sitemap.xml, GitHub repo, raw URLs.
3. **Surface auth wizard** — `pnpm tenet surface add telegram` prompts for token, registers webhook, deploys.
4. **Default verification + telemetry** — turned on, no opt-in. The first message you receive is already verified.

**Measured how:** Stopwatch on a clean machine: from `git clone` to first verified reply in Telegram. Internal benchmark; reported in release notes.

---

### Dim 6 — Zero high-severity CVEs

This is non-negotiable and continuous. See [SECURITY.md](../SECURITY.md). The mechanisms in §7 of [ARCHITECTURE.md](ARCHITECTURE.md) map 1:1 to the known agent-framework CVE-class categories (unsafe deserialization, template injection, path traversal, SQL injection) — the mistake *classes*, attributed to no named project.

**Additional layer specific to 100× ambition:**

1. **WASM-sandboxed tool execution** — every MCP tool runs in a wasmtime sandbox with declared capabilities (network/filesystem/env-var allow-lists). Tool RCE cannot escape into host process.
2. **Capability tokens** — tools receive narrow `Secret<T>` tokens, not env access. Token leaks revoke individually.
3. **Minimal supply-chain surface** — no production dependencies (apps inject their own SDKs); secrets blocked pre-commit (gitleaks + `detect-private-key`), workflows audited (actionlint, zizmor).

**Measured how:** a Trivy filesystem scan + `pnpm audit --prod` run in CI (report-only pre-1.0; Trivy SARIF is uploaded to the GitHub Security tab). No production dependencies to audit beyond dev-only transitives. Disclosure inbox per `SECURITY.md`.

---

### Dim 7 — Eval-set size > 1M assertions

**Stack:**

1. **Auto-grow from production** — every conversation that produces an outcome (`resolved` / `handed_off` / `disqualified`) becomes a candidate eval case. Sampling rate configurable (default: 1% of conversations + 100% of HITL-escalated ones).
2. **Assertion mining** — for each conversation, an LLM-as-judge extracts assertions ("when user asks X, agent should cite Y"). These become regression tests.
3. **Deduplication via embedding clustering** — near-duplicates collapsed. Diverse coverage prioritized.
4. **Adversarial generation** — for each verified case, a generator model produces N adversarial paraphrases. Catches surface-form brittleness.
5. **Continuous CI gate** — every PR runs against the eval suite. Regression > configured threshold fails the build.

**Measured how:** `eval/dataset_size` metric in repo CI badge. We publish the dataset (anonymized) for community benchmarking.

---

### Dim 8 — Retrieval failure < 0.5% @ K=10

Anthropic Contextual Retrieval gets to 1.9% @ K=20. We need 4× better at K=10. Stack:

1. **Hybrid (BM25 + dense)** — same as Anthropic.
2. **Contextual chunk prepending** — same as Anthropic.
3. **Cross-encoder rerank** — Cohere Rerank 3.5 or BGE-Reranker-v2-M3 (currently leading public reranking benchmarks).
4. **Multi-vector embeddings (ColBERT-style)** — for ambiguous queries, late-interaction beats single-vector by 5-15% (per Stanford ColBERT v2 paper).
5. **Query rewriting** — small model expands abbreviations, resolves coreferences, generates 2-3 paraphrases. Each retrieves; results fused via RRF.
6. **HyDE (Hypothetical Document Embeddings)** — for under-specified queries, model drafts a hypothetical answer, embeds it, retrieves on that embedding.
7. **Per-chunk metadata filtering** — recency, source authority tier, language. Reduces noise.

**Measured how:** Recall@K metric in CI on a held-out golden set (BeIR-style, plus our own domain set).

**Honest caveat:** ColBERT v2 + HyDE add latency. They're optional, behind a `retrieval.mode = 'precise' | 'fast'` switch.

---

### Dim 9 — 8+ surfaces, one config

Pure engineering. Each surface is an adapter (see ARCHITECTURE.md §9). Phase 3 ships all 8.

---

### Dim 10 — Zero tool-execution escapes

See Dim 6. WASM sandbox + capability tokens. Measured by: red-team test suite + zero CVEs.

---

## 3. Model + technique selection (SOTA as of 2026-06-03)

These are starting picks. The framework's router lets operators swap without code changes.

| Role | Primary | Secondary / fallback | Why |
|------|---------|---------------------|-----|
| Reasoning / flagship | Claude Opus 4.8 (`claude-opus-4-8`) | GPT-5.1 Pro, Gemini 2.5 Ultra | Strongest reasoning + tool-use + verification compliance in public benchmarks |
| Fast / cheap-path | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | GPT-4o-mini, Gemini 2.5 Flash | Latency leader with acceptable quality after distillation |
| Embedding | Voyage 3 Large | OpenAI text-embedding-3-large, BGE-large-en-v1.5 | Voyage 3 leads MTEB English at the time of writing |
| Rerank | Cohere Rerank 3.5 | BGE-Reranker-v2-M3, jina-reranker-v2 | Cohere has the strongest hosted reranker; BGE-v2-M3 is the best self-host |
| Long-context | Gemini 2.5 Pro (2M ctx) | Claude Opus 4.8 (1M ctx) | When entire knowledge base fits in context, this beats RAG on hard cases |
| Self-host flagship | Llama 3.3 70B Instruct | Qwen 2.5 72B, Mistral Large 2 | Best open weights available 2026-06-03 |
| Self-host fast | Llama 3.3 8B | Qwen 2.5 7B, Gemma 2 9B | For air-gapped enterprise / HIPAA |
| Hallucination judge | HHEM-2.1 / Lynx-style adapter (bring the model) | Self-trained judge on distilled data | An independent third-party detector reduces self-judging bias |

**Distillation pipeline (the "best training" mechanism):**

```
Every verified flagship answer → (query, answer, citations, verifier_pass) tuple
   → batched weekly into a fine-tune dataset
   → LoRA fine-tune of Llama 3.3 8B (or Haiku-equivalent customer model)
   → A/B test: distilled vs base on golden eval
   → if distilled wins on (cost × latency × quality), promote to cheap-path
   → continuous loop
```

This is how cheap-path quality climbs without operator effort. Three months in, your "free" model is doing what flagship did at launch.

**Verifier training:** the verifier itself uses a small specialized model fine-tuned on (claim, source, valid?) tuples extracted from production. Independent from the responder model — never self-judges.

---

## 4. What's deferred (honest about uncertainty)

These are 100× claims we have a path to but no proof on yet:

- **Multi-vector ColBERT-style retrieval** — published benchmarks favorable but operational complexity is high. Phase 3 evaluation.
- **WASM tool sandbox** — wasmtime + WASI-preview-2 capability model works for stateless tools; stateful tools (DB clients) need richer host capability bindings. Will document supported tool shapes.
- **1M+ eval set quality** — easy to grow size, hard to maintain diversity. Will publish growth-rate vs coverage metrics monthly.
- **Cost < $0.01** — depends on cache hit rate which depends on traffic shape. Low-volume tenants won't hit this. We'll publish a calibrated cost-vs-volume curve.

We will not market a number we cannot reproduce on a CI run. Every claim above ties to a metric the operator can read out of OTel.

---

## 5. How we'll know we hit it

Each target gets a CI gate. PRs that regress past threshold fail. Weekly published dashboard shows current vs target per dimension. Public benchmark reports per quarter.

**Anti-cheat rules** (we hold ourselves to the same skepticism we apply to vendor benchmarks):

1. Numbers come from automated CI, never hand-curated demos.
2. Eval datasets are public after one quarter (or anonymized if private-tenant data).
3. Where vendor benchmarks differ from third-party measurements, we report the lower number.
4. Methodology + commit SHA + accessed_at on every reported number.
5. Negative results published with the same prominence as positive results.

---

## 6. Open questions

- Which third-party hallucination benchmark do we standardize on for headline reporting — Vectara HHEM-2.1, Patronus Lynx, or RAGAS? Need to pick before Phase 2 gate.
- Cache hit rate vs query diversity in real tenants — needs production telemetry to calibrate the cost-curve claim.
- Whether to ship a TENET-trained verifier model under Apache-2.0 or keep it proprietary as the upsell hook. (Lean OSS for community trust; will decide before Phase 3.)
