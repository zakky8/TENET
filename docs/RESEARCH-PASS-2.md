# Research Pass 2 — Open Questions Closed

**As of:** 2026-06-04. Closes the seven items left open after pass 1 (A1, A2, A3, D1, D2, D4, D6). Each finding is anchored to primary or near-primary sources; treat the conclusions as directional and re-verify before locking architectural decisions.

Companion to [PENDING.md](PENDING.md) and [RESEARCH-PICKS.md](RESEARCH-PICKS.md).

---

## A1 — Closed-tool architecture clues (Decagon / Sierra / Moveworks / Cresta / Aisera)

**Decagon** — Agent Operating Procedures (AOPs): structured procedures in plain English that compile to API calls + knowledge-base lookups + escalation criteria. A built-in **Routing** module decides AI-vs-human per inquiry. Compliance posture: SOC 2, ISO 27001, GDPR, HIPAA. **Watchtower** does real-time QA + guardrails. Strengths: knowledge-base-heavy SaaS support with an audit-trail-friendly behavior contract.

**Sierra** — Constellation architecture routes across **multiple LLM providers** with model-level guardrails to reduce hallucination. Voice-first deployment is the headline. **Ghostwriter** (Mar 2026) builds production agents from SOPs, call transcripts, whiteboard sketches, or plain-English descriptions.

**Sources:**
- [Decagon vs Sierra deep-dive — Notch (2026)](https://www.notch.cx/learn/deep-dive-comparison-for-enterprise-ai-customer-support)
- [Decagon AI Agent Engine](https://decagon.ai/resources/the-ai-agent-engine)
- [Sierra vs Decagon — eesel AI](https://www.eesel.ai/blog/decagon-vs-sierra)

**Decision implication for TENET:**
- Both lean on **multi-model routing under one orchestrator** + **structured procedure DSL**. TENET's `@tenet/router` (C3) confirms multi-model routing as table stakes. The procedure-DSL idea is interesting but not blocking — we get most of it from prompt-templated state-machine nodes plus the constitutional-principle registry.
- Audit-trail-friendly behavior is a **first-class need** — our OTel `agent.*` attributes already cover this.
- Routing-as-explicit-decision: our adaptive router (cheap-vs-flagship) is one form; an AI-vs-human escalation path is a separate concern we should make explicit in C10 (community-bot) HITL hooks.

---

## A2 — Vector-store cost-perf at 100M+ vectors

Synthesized from a 12-DB benchmark on 100M × 768-dim vectors (identical hardware):

| DB | 100M-vector cost / mo | Notable |
|---|---|---|
| **Turbopuffer** | **$800** | Object-storage-native; cold-query 300-800ms; lacks hybrid search |
| Qdrant Cloud | $5,000 | **Lowest latency** — p50 4ms, p99 25ms among purpose-built |
| Weaviate | $3,500 | Hybrid search built in |
| Pinecone | $7,000 | Mature; high cost at scale |
| **pgvector** | n/a | **Buckles above 50M** on a single node — index builds > 2 hours, p95 > 200ms without careful tuning |

**Sources:**
- [Vector Database Benchmark 2026 — Salt Techno](https://www.salttechno.ai/datasets/vector-database-performance-benchmark-2026/)
- [pgvector vs Qdrant vs Weaviate at 100M vectors — Elestio Blog](https://blog.elest.io/pgvector-vs-qdrant-vs-weaviate-which-vector-database-holds-up-at-100m-vectors/)
- [pgvector vs Pinecone vs Turbopuffer vs Qdrant 2026 — daily.dev summary](https://app.daily.dev/posts/pgvector-vs-pinecone-vs-turbopuffer-vs-qdrant-2026--m1dot7ras)

**Decision implication for TENET:**
- **pgvector remains the default for phase 1** (single-tenant, <50M vectors). It is **NOT** appropriate for enterprise multi-tenant > 50M.
- **Phase 2 default: Qdrant** (purpose-built, lowest latency, mature hybrid search).
- **Cost-sensitive multi-tenant deployments: Turbopuffer adapter** as a phase-3 option for archive-tier corpora where 300-800ms cold-query latency is acceptable.
- The `@tenet/retrieval` `VectorStore` interface is already designed to swap; we ship pgvector + Qdrant adapters and document the >50M cliff in the per-package READMEs.

---

## A3 — MCP enterprise adoption signal

**Production adoption is real and material:**
- **Anthropic (Mar 2026):** 10,000+ active public MCP servers; 97M monthly SDK downloads (Python + TypeScript).
- **Registry growth:** 7.8× year-over-year; 1,200 servers (Q1 2025) → 9,400+ (April 2026); month-over-month growth +18%.
- **Production deployments at named Fortune-500s:** EY, JPMorgan, Salesforce, Reddit, Amazon, Block, Bloomberg orchestrate MCP in production.
- **Workato Enterprise MCP:** "trusted by half of the Fortune 500."
- **Stacklok 2026 software report:** **41%** of surveyed software orgs in limited or broad production with MCP servers.

**Sources:**
- [2026 MCP Roadmap — Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [MCP Adoption Statistics 2026 — Digital Applied](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol)
- [Workato Production MCP Servers — Business Wire (Feb 2026)](https://www.businesswire.com/news/home/20260205680021/en/Workato-Accelerates-Enterprise-AI-Adoption-with-Launch-of-Production-Ready-Model-Context-Protocol-Servers)

**Decision implication for TENET:**
- "MCP-native" stays a **launch-grade differentiator**, not a phase-2 nice-to-have. The market is large enough that operators expect it.
- **Top enterprise blocker is security:** audit trails, SSO-integrated auth, gateway behavior, configuration portability. Our `@tenet/core` brand-typed `Secret<T>` + `PathHandle` + filter-key validation address two of those; we still owe an MCP gateway pattern (phase 3).
- Worth adding a `connectors/mcp/` package to the roadmap that wraps the MCP TypeScript SDK behind our `ToolUse` interface.

---

## D1 — Claude Agent SDK + Opus 4.8 + Haiku 4.5 current surface

**Opus 4.8 (released 2026-05-28)** — confirmed picks in BENCHMARKS.md remain accurate. Key SDK-relevant updates:

- **1M-token context** by default on Claude API, Bedrock, Vertex AI; 128k max output tokens.
- **Prompt cache minimum** lowered from previous tier to **1,024 tokens** — many prompts that couldn't cache on 4.7 now cache for free. **$0.50/M input tokens for cache reads** (90% discount).
- **Mid-conversation system messages** — system entries accepted inside the messages array; lets you update instructions mid-task without breaking the prompt cache or routing through a user turn.
- **Dynamic workflows** — Opus 4.8 plans a task and runs *hundreds of parallel subagents* in a single session. Anthropic positions this as the path to codebase-scale migrations.
- **Effort control** — defaults to `high`; same token spend as 4.7's default with better quality.
- **Adaptive thinking** — only reasons when needed; cuts wasted thinking tokens on bimodal workloads.

**Sources:**
- [Introducing Claude Opus 4.8 — Anthropic](https://www.anthropic.com/news/claude-opus-4-8)
- [What's new in Claude Opus 4.8 — Claude API Docs](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8)
- [Claude Opus 4.8 on Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-4-8.html)

**Decision implication for TENET:**
- **Lower cache threshold** changes our cost math — many prompts that were too short to cache now cache. Update BENCHMARKS.md cost-per-resolution model accordingly when we land the cost meter integration.
- **Mid-conversation system messages** + **adaptive thinking** suggest our `@tenet/policy` composer should emit a *delta system message* on intent change instead of rebuilding the whole prompt. Track as a phase-2 polish.
- **Dynamic workflows / 100s of subagents** map cleanly to our `@tenet/router` speculative-agent pattern (C3). We can lean into Anthropic's primitives for the speculative path.

---

## D2 — MCP spec changelog since 2026-06-03

**Release candidate (2026-06-04 status):** the **2026-07-28** spec release is the largest revision since launch. The RC is live now.

Key changes:

- **Stateless core** — scales on ordinary HTTP infrastructure (no special transport).
- **Streamable HTTP requires `Mcp-Method` + `Mcp-Name` headers** (SEP-2243) — load balancers / gateways / rate-limiters can now route on the operation without inspecting the body.
- **`ttlMs` + `cacheScope`** (SEP-2549) on `list` and `resource read` results — HTTP-Cache-Control-modeled freshness signals. Clients can share `tools/list` responses across users when safe.
- **OAuth alignment:** clients must validate the `iss` parameter on authorization responses (RFC 9207, SEP-2468) — mitigates mix-up attacks in MCP's many-server pattern.
- **OpenID Connect `application_type`** declared during Dynamic Client Registration (SEP-837) — fixes the desktop/CLI client → "web" defaulting bug.
- **Extensions:** server-rendered UIs (MCP Apps), long-running work (Tasks).

**Sources:**
- [2026-07-28 MCP Spec RC — MCP Blog](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP Release Notes — Speakeasy](https://www.speakeasy.com/mcp/release-notes)
- [MCP TypeScript SDK (current)](https://github.com/modelcontextprotocol/typescript-sdk)

**Decision implication for TENET:**
- Pin our MCP integration to a specific spec version (probably **2026-07-28** when it ships) and document it in CHANGELOG. Pre-July deployments should target the RC.
- Take a hard dependency on `Mcp-Method` + `Mcp-Name` header routing in our rate-limit scheduler — these turn MCP tool calls into platform-routable traffic at the `@tenet/rate-limit` layer.
- The `iss` validation and `application_type` rules apply to any MCP-OAuth flow we ship — bake them into the future `connectors/mcp` package.

---

## D4 — OSS framework refresh (Letta / Mastra / Pydantic-AI / Inkeep / OpenAI Agents SDK)

| Framework | 2026 positioning | Notable |
|---|---|---|
| **Mastra** | **De facto TypeScript choice** | 19k+ stars; 300k+ weekly downloads; workflows + HITL primitives + Next.js integration |
| **Pydantic AI** | Best Python-first for structured outputs / validation / DI | Clean app architecture |
| **OpenAI Agents SDK (TS)** | Next-best TS choice after Mastra | |
| **Letta** | Niche — persistent-memory assistants | |
| **Inkeep SDK** | TS extension to no-code platform; MCP + A2A protocols; deep customization | |
| **LangGraph** | Still strongest mindshare; complex flows | CVE history remains a concern (see SECURITY.md) |
| **CrewAI** | Multi-agent role-based; simpler than LangGraph | |
| **Google ADK** | Multi-language flagship (Python + TS + Java + Go) | |

**Sources:**
- [Best OSS AI Agent Frameworks 2026 — AI Haven](https://aihaven.com/guides/best-open-source-ai-agent-frameworks/)
- [Speakeasy: LangChain vs LangGraph vs CrewAI vs PydanticAI vs Mastra vs Vercel AI SDK](https://www.speakeasy.com/blog/ai-agent-framework-comparison)
- [AI Agent Framework Tier List 2026 — paperclipped](https://www.paperclipped.de/en/blog/ai-agent-frameworks-tier-list-2026/)

**Decision implication for TENET:**
- **Mastra is the direct competitor** for the TypeScript agent niche. Our differentiators (verification-by-default, source-grounded URL allow-list, hardened-by-construction security stance, all-surfaces-one-config, OTel GenAI native) remain meaningful — Mastra leans on workflow + HITL polish, not on hallucination defense.
- The **Inkeep precedent** (TS SDK + MCP + A2A) suggests we should hint at A2A protocol support in the roadmap if we want enterprise integration parity.
- We should **explicitly compete with Mastra in the README** (it's not in our current comparison table). Add it in a later commit.

---

## D6 — Reranker head-to-head (Cohere / Voyage / BGE / Jina)

Public leaderboard snapshot (ELO + nDCG@10):

| Reranker | Top metric | License |
|---|---|---|
| **Zerank 2** | **1638 ELO** (top) | hosted |
| **Cohere Rerank v4.0 Pro** | 1629 ELO | hosted |
| **Voyage Rerank 2.5** | Fastest (~595ms p50) + quality | hosted |
| **Cohere Rerank 3.5** | ~603ms p50; less favored by LLM judge | hosted |
| **Jina Reranker v3** | 61.94 nDCG@10 BEIR; 131k ctx; listwise (64 docs/pass) | Apache-2.0 |
| **BGE-Reranker-v2-M3** | Lightweight, multilingual, fast | Apache-2.0 |
| **Qwen3-Reranker-4B** | 69.76 MTEB-R / 75.94 CMTEB-R | Apache-2.0 |

**Sources:**
- [Ultimate Reranker Guide 2026 — ZeroEntropy](https://zeroentropy.dev/articles/ultimate-guide-to-choosing-the-best-reranking-model-in-2025/)
- [Reranker Leaderboard — Agentset](https://agentset.ai/rerankers)
- [Top 5 Reranking Models — MLM](https://machinelearningmastery.com/top-5-reranking-models-to-improve-rag-results/)

**Decision implication for TENET:**

Revised default ordering (replaces tentative pick in RESEARCH-PICKS.md):

1. **Voyage Rerank 2.5** — primary hosted: fastest + competitive quality.
2. **Cohere Rerank v4.0 Pro** — secondary hosted: 1629 ELO, broader provider footprint.
3. **Qwen3-Reranker-4B** — primary self-host: strongest open-weights as of 2026-06-04, Apache-2.0.
4. **Jina Reranker v3** — secondary self-host: listwise + huge context (specialty long-doc workloads).
5. **BGE-Reranker-v2-M3** — practical baseline: small, multilingual, easy ops.

Our `Reranker` interface in `@tenet/retrieval` is unchanged — each is a 4-line adapter. Update `RESEARCH-PICKS.md` reranker section when this ships.

---

## Net deltas vs prior research-picks

1. **Reranker primary changed:** Cohere 3.5 → **Voyage Rerank 2.5** (faster + better quality at MTEB).
2. **Self-host reranker primary changed:** BGE-Reranker-v2-M3 → **Qwen3-Reranker-4B** (stronger benchmarks, same Apache-2.0).
3. **Vector-store phase-2 default:** Qdrant confirmed (lowest latency at 100M).
4. **Vector-store budget-tier:** Turbopuffer added as a phase-3 archive-tier adapter target.
5. **MCP**: launch-grade differentiator confirmed, not deferred. Pin 2026-07-28 spec.
6. **Direct competitor**: Mastra. Worth explicit README mention.
7. **Opus 4.8 cache threshold**: 1024 tokens — update cost model.
