# Research Pass 3 — open questions, structured for operator fetch

**Status:** scaffolded 2026-06-04. Every row below is `UNVERIFIED — pending operator-led fetch` per the source-hierarchy rule in `CLAUDE.md`. Numbers without an `accessed_at_utc` + archive URL are not shipped here. This document is the **list of questions** + **methodology** + **verification template** for the next research pass. A second-pass author fills in the answers with citations; we never paraphrase a search-result snippet as proof.

Companion docs:
- [`docs/RESEARCH-PICKS.md`](RESEARCH-PICKS.md) — pass 1 verified picks (eval layer, OTel version, judge model)
- [`docs/RESEARCH-PASS-2.md`](RESEARCH-PASS-2.md) — closed-tool architecture, reranker head-to-head, vector-store @ 100M

---

## Source hierarchy refresher (binding)

1. **Primary** — vendor's own site / official docs / changelog / GitHub repo / official X / YouTube of named executive
2. **Regulator / Registry** — Companies House, registry filings (rarely relevant here)
3. **Independent journalism** — FinanceMagnates / Reuters / Bloomberg / FT only
4. **Aggregators** — npmjs trends, GitHub stars, JS Rising Stars
5. **Community** — Reddit, X threads, Discord pinned

Tier-4/5-only claims ship with the `UNVERIFIED` tag. Two independent Tier-1/2/3 sources required for any new claim.

---

## D1 — Anthropic Claude Agent SDK + Opus 4.8 / Haiku 4.5 — current SDK surface

**Why it matters:** `models/anthropic` and `router` pin choices based on the SDK's feature set. Drift breaks the contract silently.

**Specific questions:**
1. What model IDs are currently published? (`claude-opus-4-8-*`, `claude-sonnet-4-5-*`, `claude-haiku-4-5-*` — confirm exact strings and deprecation dates)
2. Prompt caching: which tiers, what TTL, what minimum-size threshold for cache hit?
3. Batch API: pricing discount, per-request latency, error handling for partial batch failures?
4. Structured outputs: is the `tool_use` + JSON-schema path the current recommendation or has a `response_format` shape shipped?
5. MCP integration: are MCP tools first-class on the SDK or still wrapped through `tool_use`?
6. Streaming: TTFT measurement endpoints / events — what does the SDK expose for `gen_ai.response.time_to_first_token`?

**Sources to check (Tier 1 only):**
- https://docs.anthropic.com/en/docs (changelog page + deprecations page)
- https://docs.anthropic.com/en/api/models-list
- https://github.com/anthropics/anthropic-sdk-typescript (releases, CHANGELOG.md)
- Anthropic Engineering blog

**Verification rules:**
- Every model ID quoted needs `accessed_at_utc`
- Pricing claims need a screenshot of the pricing page archived to web.archive.org
- Feature claims need either docs link + commit-pinned line OR official YouTube/X video URL with timestamp

**Status:** `UNVERIFIED` — pending operator fetch.

---

## D2 — Model Context Protocol spec changelog since 2026-06-03

**Why it matters:** `@tenet/tools-mcp` + `@tenet/tools-mcp-gateway` ship against the 2026-07-28 RC. Spec drift since pass 2 affects iss validation, transport choice (stdio vs SSE vs Streamable HTTP), and OAuth ratification status.

**Specific questions:**
1. What is the **latest ratified spec version** (vs RC)? Confirm version string + ratification date.
2. **Transport stability:** which of stdio / SSE / Streamable HTTP are now SHOULD vs MUST for spec compliance?
3. **OAuth flow ratification:** is RFC 9207 `iss` validation now MUST? Any new claims like `aud`, `azp` mandated?
4. **Server registry consolidation:** has an official registry replaced ad-hoc lists? What governance model?
5. **Capability tokens / fine-grained scopes:** has the spec added scopes beyond the current `tools/list` / `tools/call`?
6. **Breaking changes** between the 2026-07-28 RC and the ratified version, if any.

**Sources to check (Tier 1 only):**
- https://modelcontextprotocol.io/specification (version selector)
- https://github.com/modelcontextprotocol/specification (commit log, releases, RFC PRs)
- Linked draft PRs from spec maintainers (Anthropic, GitHub MCP team)

**Status:** `UNVERIFIED` — pending operator fetch.

---

## D4 — OSS agent-framework landscape refresh

**Why it matters:** Competitive positioning. Pass 2 covered Mastra / Pydantic-AI / Letta / OpenAI Agents SDK; that's six months old.

**Specific questions:**
1. **Mastra** — TS-first claim still holds? Verifier story? Latest stable version + monthly download trend.
2. **Pydantic-AI v1** — has v1 shipped? Native MCP? Native OTel?
3. **Letta** — long-term-memory differentiator still differentiated, or has mem0 / Zep matched?
4. **OpenAI Agents SDK** — has the Python-vs-TS-equality claim materialised?
5. **Smolagents (HF)** — agentic loop differentiator? Verifier story?
6. **Inkeep** — closed-tool or now OSS-core?
7. **New entrants:** Daytona-agent, Devin-OSS, Aider-agent — any TS-first verification-first frameworks?

**Sources to check:**
- Each project's GitHub repo: latest release tag + CHANGELOG.md + open issue count + monthly star growth (use star-history.com sparingly; cross-check on GitHub itself)
- npmjs.com trends for npm packages
- JS Rising Stars 2025 (December retrospective)

**Status:** `UNVERIFIED` — pending operator fetch.

---

## D6 — Reranker head-to-head update

**Why it matters:** Pass 2 picked Voyage Rerank 2.5 (primary hosted) + Qwen3-Reranker-4B (self-host primary) + Cohere Rerank v4.0 Pro (alt) + BGE-Reranker-v2-M3 (baseline). The `@tenet/rerank-cohere` adapter shipped this turn against Cohere v2 API; confirm the current preferred model id (likely `rerank-v3.5` or newer).

**Specific questions:**
1. **Cohere Rerank v4.0 Pro** vs **v3.5** — current public benchmark numbers (BEIR / MS-MARCO / mixed-domain)?
2. **Voyage Rerank 2.5** vs Voyage 3 — current MTEB reranking subset scores?
3. **Qwen3-Reranker-4B** vs **Qwen3-Reranker-8B** — quality vs cost-of-self-host curve?
4. **BGE-Reranker-v2-M3** vs **BGE-Reranker-v3** if shipped?
5. **jina-reranker-v3** vs v2.5 — has v3 shipped?
6. **mxbai-rerank-v2** — published since pass 2?

**Sources to check (Tier 1 only):**
- Each vendor's docs page + pricing page
- MTEB leaderboard (https://huggingface.co/spaces/mteb/leaderboard) for self-host
- Vendor blog announcement posts (count as Tier-1 for "we shipped X" claims, Tier-3 for "X beats Y" claims — never accept vendor's head-to-head as proof of head-to-head)

**Status:** `UNVERIFIED` — pending operator fetch.

---

## A1 — Closed-tool architecture clues — refresh

**Why it matters:** Decagon / Sierra / Cresta / Aisera / Moveworks influence enterprise-side framework expectations. Pass 2 dug deep; six months on the job-posts list shifts.

**Specific questions:**
1. Has any of the five posted an engineering job-listing in the last 90 days mentioning a verifier / hallucination-judge stack we don't know about?
2. Has any been the subject of a deep-dive in The Pragmatic Engineer / Stratechery / a16z newsletter?
3. Conference talks at QCon / Strange Loop / NeurIPS Industry Track 2025 mentioning their architecture by name?

**Status:** `UNVERIFIED` — pending operator fetch.

---

## A2 — Vector-store cost-perf at 10M–1B vectors — refresh

**Why it matters:** Pass 2 selected pgvector (default ≤50M) + Qdrant (default 100M+). At 1B vectors the picture is different and the field moves fast (Turbopuffer, Vespa, LanceDB v2).

**Specific questions:**
1. Has Turbopuffer published reproducible 1B-vector latency + cost-per-month numbers since pass 2?
2. LanceDB v2 — has it shipped? Storage-disaggregated architecture claim verified?
3. Qdrant Cloud pricing changes? Multi-tenant per-collection sharding GA?
4. Vespa — any new managed offering?
5. Pinecone serverless cost-per-month at 1B vectors with their current pricing?

**Status:** `UNVERIFIED` — pending operator fetch.

---

## Methodology — how a pass-3 author fills this in

1. For each row, open the listed Tier-1 sources in order. Stop when you have 2 independent Tier-1/2/3 sources.
2. Quote verbatim. Paraphrase goes in `notes`.
3. Stamp every claim with `accessed_at_utc` + archive.org URL.
4. Where two sources disagree, log both. Never pick a winner silently.
5. Any number not produced by automated CI in this repo is reported with the methodology.
6. Replace the `UNVERIFIED — pending operator-led fetch` line with the actual finding and the citation block.
7. PR the diff; CI re-runs the BENCHMARKS gate to make sure the doc edit didn't shift any gated number.

---

## What we will NOT do here

- Fabricate dates / version strings / benchmark numbers
- Use training-data memory of model IDs (must re-fetch)
- Paraphrase an LLM's recollection as a finding
- Quote a vendor's head-to-head against a competitor as proof of head-to-head
- Run a fresh deep-research workflow without explicit ask — these are operator-time tasks

If a single number from a single Tier-4 aggregator is all that's available for a row, log it as `UNVERIFIED` and move on. The framework's credibility on the BENCHMARKS rows depends on never confusing "we saw this on a leaderboard" with "we verified this against the primary source."
