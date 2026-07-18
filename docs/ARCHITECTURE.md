# TENET — Architecture Proposal

> The existing TENET community bot (github.com/zakky8/bot, telegram-bot/ + shared/ + discord-bot/) becomes the first reference deployment under `apps/community-bot` after the platform's MVP lands. This doc describes the platform that subsumes it.

**Status:** Draft v0.1 (proposal) — implementation status note added 2026-07-18
**Date:** 2026-06-03
**Owner:** TBD
**Based on:** Research Pass 1 (108 agents, 23 verified claims, 26 sources — full report in `research-2026-06-03.json`)
**Companion:** [BENCHMARKS.md](BENCHMARKS.md) — measurable 100× targets + method-of-attack per dimension

---

## 0. Implementation status (honest read, as of 2026-07-18)

This document is still the forward-looking proposal. The section below records what
is actually in the tree on branch `upgrade/top-1pct`, so the proposal is not read as
a description of shipped code. Numbers are measured, not aspirational.

- **Repo:** 63 workspace packages (every `package.json` under the `pnpm-workspace.yaml`
  globs). Test suite: **98 suites / 1325 tests, all green** (was 83 / 1051 at the start
  of this upgrade). All figures are from the **hermetic stub plane** — no real-model
  access exists in this environment, so no real-model benchmark numbers are claimed here.
- **Phase 1 — canonical model contract (complete):** one `ChatModel` in `@tenet/core`
  (`packages/core/src/model.ts`) replaced four duplicated single-string
  `chat({system, user}): Promise<string>` interfaces. The contract is a **messages array**
  (`ModelMessage[]` of typed `ContentBlock`s), a **required** `AbortSignal`, tool
  round-trips (`text | tool_use | tool_result`), and a lossless `StopReason` union. All
  six model adapters (`models/{anthropic,bedrock,google,mistral,ollama,openai}`) speak it;
  `@tenet/streaming` and `@tenet/ag-ui` re-align to the canonical `StreamChunk`; the
  transitional legacy bridges were deleted. See §17.
- **Phase 2 — agent turn (shipped):** the `@tenet/agent` package ships the full driven
  turn. `runAgent` (`packages/agent/src/orchestrator.ts`) executes `OrchestratorState` as
  a `@tenet/workflow` graph — injection gate → retrieve + knowledge-boundary → cache
  re-verify → fail-closed decides-and-drafts Reasoner → governance-gated tools →
  fail-closed verify → **single emit edge** — with terminals CARRIED in `state.halt` (not
  thrown), a `finalize` fail-closed default, and a top-level catch that turns any error
  into an abstain. A failed draft is rewritten (`deps.rewrite`) and re-verified through the
  same emit edge up to `maxRepairRounds`, then abstains. Only real-model prompt validation
  remains a follow-up. See §17.
- **Phase 3 — verifier hardening (effectively complete):** the opt-in `failClosed` mode
  (3.1) plus, verified in the tree: the Reasoner abstains on a `max_tokens` (TRUNCATED) /
  refusal / aborted stop (`packages/agent/src/reasoner.ts` — a cut-off draft never ships);
  an over-cap claim extraction throws `ClaimExtractionError` under `failClosed` instead of
  silently dropping the unverified overflow (`packages/verifier/src/claimExtractor.ts`);
  and the deterministic pre-check tier fails a fabricated number, spelled-out amount,
  `http(s)://` URL, or contact email that is absent from the sources BEFORE any judge runs
  (`packages/verifier/src/deterministic.ts`: `numericFabricationCheck` incl.
  `parseSpelledNumbers`, `urlFabricationCheck`, `emailFabricationCheck`, `quoteGroundingCheck`,
  composed in `defaultPreChecks`). A `groundedOrAbstain` reference orchestrator (3.4) chains the
  knowledge-boundary gate → draft → verify + bounded repair → answer/abstain in
  `@tenet/refine`. Only 3.2's named-entity + negation-scope guards remain — deferred until
  a real judge model ships (defense-in-depth for the judge, not a current end-to-end hole).
- **Still pending:** real-model validation of the turn prompt and real-model benchmarks —
  no live-model access exists in this environment, so the hermetic stub plane is the only
  measured plane. Phases 4–5 (hero apps + honest measurement; surfaces + resilience) are
  in progress on `upgrade/top-1pct`.

---

## 1. Problem statement

The 2025/2026 agent landscape is split:

- **Closed enterprise leaders** (Intercom Fin, Decagon, Sierra, Ada, Glean, Moveworks) lock you in to outcome-pricing ($0.99/resolution at Fin) and a proprietary helpdesk runtime. Customers pay six- to seven-figure annual contracts.
- **OSS frameworks** have mindshare but rarely make hallucination defense a first-class layer. Separately, the broader agent-framework ecosystem has a well-known set of CVE-CLASS mistake *categories* — unsafe deserialization, template injection, path traversal, SQL injection — that we design out by construction (§7). This doc names **no specific project or advisory** and attributes no vulnerability to any named competitor: an unsourced CVE attribution is exactly the kind of unverified factual claim this framework exists to prevent. Where a specific, sourced advisory matters, it belongs in a citation-backed security appendix, not in prose here.
- **Hallucination defenses** are still bolt-ons in most frameworks. Source-grounding, citation enforcement, Chain-of-Verification, and Reflexion exist as papers and one-off implementations, not as a first-class layer.
- **Multi-surface** (Telegram + Discord + Slack + Teams + web widget + REST + ticketing) is duplicated across teams. Nobody ships one framework that does all surfaces with one config.

We build a clean-slate, hardened-by-construction, verification-by-default agent framework with all surfaces in one platform, plus two reference deployments: a community-grade agent (TENET successor) and an enterprise technical-support agent.

## 2. Non-goals

- Not a model provider — we wrap providers, we don't host weights.
- Not a vector store — we wrap stores (pgvector default, Qdrant/LanceDB/Pinecone optional).
- Not a helpdesk — we integrate with Zendesk/Intercom/Freshdesk/ServiceNow as the helpdesk-of-record (Fin-on-Zendesk pattern).
- Not a low-code builder — we ship a TypeScript SDK + YAML config. UIs come later, after the core is stable.
- Not multi-language at launch — TS primary, Python escape hatch for eval/research only. Go/Rust/JVM deferred until a real customer demands it.

## 3. Differentiators ("100x angle")

What concretely we ship that the field doesn't, on day 1:

| # | Differentiator | Concrete mechanism |
|---|---|---|
| 1 | **Verification by default** | CoVe + Reflexion + 13 Constitutional Principles run on every output, not opt-in. Failures route to verifier-fallback or HITL escalation, never silently emitted. |
| 2 | **Source-grounded only** | URLs in output are constrained to a compiled allow-list extracted from indexed sources. No model-recall URLs. Citations are enforced by output schema, not by prompt. |
| 3 | **CVE-class mistakes designed out by construction** (enforcement partly shipped, partly planned — see §7) | No pickle/free-form deserialization anywhere. No Jinja2 default. Parameterized queries enforced via typed checkpoint stores. Path allow-list + abs-path rejection on every file I/O. Secret scanning (gitleaks) + workflow supply-chain audit (actionlint, zizmor) pre-commit; Trivy + `pnpm audit` report-only in CI. |
| 4 | **All surfaces, one config** | Telegram + Discord + Slack + Teams + web widget + REST/gRPC + ticketing webhooks all run from one `agent.config.ts`. Per-surface policies (rate-limit, formatting) declared, not hand-coded. |
| 5 | **Rate-limit as scheduling primitive** | Per-platform token-bucket queues built into the runtime. Circuit-breakers on 401/403 streaks (Discord IP-ban risk). Telegram/Discord/Slack/Teams/Zendesk limits encoded as policy, refreshable without redeploy. |
| 6 | **Outcome as first-class telemetry** | Every conversation emits `resolved` / `handed-off` / `disqualified` / `qualified` events. Operators wire their own outcome-pricing or SLA reports. We bring Intercom's model to OSS. |
| 7 | **Hybrid contextual retrieval out of the box** | BM25 + dense + contextual chunk prepending + cross-encoder rerank. Each stage emits its own recall metric. Anthropic's 35/49/67% benchmark is the reference, not the ceiling. |
| 8 | **MCP-native tool use** | Tools are MCP servers from day 1. No proprietary tool schema. We register OAuth/secret-handling at the gateway, not per-tool. |
| 9 | **Eval-as-CI** | Golden dataset + LLM-as-judge runs on every PR. Cost/latency/recall regression flagged. PR cannot merge if eval suite regresses past a configured threshold. |
| 10 | **Multi-tenancy and on-prem from day 1** | Per-tenant indexes, per-tenant secret stores, single-binary self-host. SOC2/HIPAA-friendly: no telemetry to vendor by default, OTel GenAI semconv export to customer's own collector. |

## 4. Component map

```
┌────────────────────────────────────────────────────────────────────────┐
│                          Surfaces (thin adapters)                       │
│  Telegram | Discord | Slack | Teams | Web Widget | REST | gRPC | TKT    │
└────────────────────────────────────────────────────────────────────────┘
              │ normalized Conversation events
              ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          Rate-limit scheduler                           │
│  per-(platform,tenant,channel,user) token bucket + circuit breaker      │
└────────────────────────────────────────────────────────────────────────┘
              ▼
┌────────────────────────────────────────────────────────────────────────┐
│                            Core Runtime                                 │
│  State machine | Intent classify | Policy gate | Tool-use (MCP)         │
│  Streaming + interrupts + HITL escalation                               │
└────────────────────────────────────────────────────────────────────────┘
       │           │            │             │             │
       ▼           ▼            ▼             ▼             ▼
   Retrieval   Memory        Router       Verifier    Guardrails
   (hybrid     (ep + sem)    (model       (CoVe +     (PII redact,
   + ctx +                   routing,     Reflexion + input/output
   rerank)                   fallback)    Constit. +  filters)
                                          source-
                                          grounding +
                                          citation
                                          enforcement)
       │           │            │             │             │
       ▼           ▼            ▼             ▼             ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Telemetry (OTel GenAI semconv)                      │
│  outcome events | token cost | latency | recall per stage | prompt ver  │
└────────────────────────────────────────────────────────────────────────┘
              ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       Connectors / Stores                               │
│  Vector: pgvector default, Qdrant/LanceDB/Pinecone optional             │
│  State:  Postgres + Redis                                               │
│  Models: Bedrock, Anthropic, OpenAI, Google, Mistral, Ollama            │
│  Ticketing: Zendesk, Intercom, Freshdesk, ServiceNow, Salesforce SC     │
└────────────────────────────────────────────────────────────────────────┘
```

## 5. Repo layout (pnpm workspaces)

```
/
├── packages/                # (63 workspace packages total; abbreviated list)
│   ├── core/                # canonical ChatModel contract (model.ts), AgentState, openPath, conversation events
│   ├── agent/               # the driven turn: runAgent graph (nodes → Reasoner → tools → verify → emit), all fail-closed
│   ├── verifier/            # CoVe, Reflexion, constitutional, citation enforcement
│   ├── retrieval/           # hybrid BM25+dense, contextual chunker, rerank
│   ├── memory/              # episodic + semantic + working
│   ├── rate-limit/          # token-bucket scheduler, circuit breakers, retry taxonomy
│   ├── telemetry/           # OTel GenAI semconv, outcome events
│   ├── router/              # cost-aware model router + fallback chain
│   ├── guardrails/          # input/output filters, PII redaction
│   └── policy/              # Constitutional principles, intent classifier
├── surfaces/
│   ├── telegram/            # grammY adapter
│   ├── discord/             # discord.js adapter
│   ├── slack/               # Bolt adapter (Marketplace + internal modes)
│   ├── teams/               # Bot Framework + Adaptive Cards
│   ├── web-widget/          # SSE server + JWT session + embeddable widget
│   ├── rest/                # OpenAPI 3.1 + Web API
│   ├── grpc/                # protobuf service
│   └── webhook/             # ticketing webhook receiver
├── connectors/
│   ├── zendesk/
│   ├── intercom/
│   ├── freshdesk/
│   ├── servicenow/
│   └── salesforce-service-cloud/
├── models/                  # all 6 adapters exist and speak the canonical ChatModel contract
│   ├── bedrock/
│   ├── anthropic/
│   ├── openai/
│   ├── google/
│   ├── mistral/
│   └── ollama/
├── stores/
│   ├── vector/
│   │   ├── pgvector/
│   │   ├── qdrant/
│   │   ├── lancedb/
│   │   └── pinecone/
│   └── state/
│       ├── postgres/
│       └── redis/
├── apps/
│   ├── community-bot/       # TENET successor (Telegram + Discord)
│   └── enterprise-support/  # full multi-surface stack
├── eval/
│   ├── harness/             # runner + LLM-as-judge templates
│   ├── datasets/            # golden + adversarial sets
│   └── judges/              # judge prompts + scoring
├── infra/
│   ├── docker/
│   ├── k8s/                 # Helm charts (single-binary + sidecar layouts)
│   └── terraform/           # AWS + Hetzner reference
├── docs/
└── scripts/
```

## 6. Language stack

| Layer | Language | Rationale |
|---|---|---|
| Core runtime + surfaces + connectors + stores | **TypeScript (Node 22 LTS)** | Native SDKs for every chat/ticketing platform. Type safety. Single-binary deploy via `pkg`/`bun`. |
| Eval harness + research scripts | **Python 3.12** | Notebooks, contextual chunk prepending demo (Anthropic), eval datasets. Optional, not in core. |
| Hot-path components (later) | **Rust** (deferred) | Reserved for vector router, OTel collector if perf-bound. Don't introduce until benchmarked need. |

We do **not** ship Java or Go runtimes at launch. Only Google ADK currently does (verified 2026-06-03). If an enterprise customer requires JVM/Go, we add a gRPC SDK client in that language — not a port of the runtime.

## 7. Security stance (CVE-class mistakes prevented by construction)

Each row names a mistake *class* we design out by construction. CVE identifiers and severities are intentionally omitted: we do not ship unsourced CVE attributions (see §1). Specific advisories, if cited, belong in a sourced security appendix. The **Enforcement** column marks what is shipped vs planned.

| Mistake category | Our policy | Enforcement |
|---|---|---|
| Unsafe deserialization | No pickle, no free-form dict rehydration. Secret fields are an explicit `Secret<T>` opaque type that throws on serialization, never persisted. | Shipped: `Secret<T>` in `packages/core/src/types.ts` (its `toJSON`/serialize path throws). Planned: schema-validated persistence layer + a CI lint rejecting unschema'd `JSON.parse` (persistence module not yet in `packages/core/src`). |
| Template injection | No Jinja2. Prompt templates use tagged-template literals with explicit interpolation slots. No string concatenation of user input into prompts. | Planned: `eslint-plugin-prompt-safety` (small custom rule; not yet written). |
| Path traversal | All file I/O takes a `PathHandle` produced by `openPath(relative)`, opened against a configured allow-list root. Absolute paths, empty paths, and `..` segments are rejected at construction; resolved paths that escape the root are rejected. | Shipped: `packages/core/src/path.ts` `openPath()` (allow-list root via `configurePathRoot`, abs-path + `..` + root-escape rejection); the `PathHandle` constructor is module-private. Planned: CI lint banning `fs.readFile(string)` outside this module. |
| SQL injection | All checkpoint and retrieval stores use parameterized queries. Filter keys validated against `/^[a-zA-Z0-9_.-]+$/`. | Shipped: type-level `Filter<T>` (not `string`) and `validateFilterKey` in `packages/core/src/types.ts` (also rejects `--` and `..`). Runtime regex validation on key insertion. |
| Supply chain | No production dependencies — apps inject their own SDKs, so there is no prod-dep surface. A Trivy `fs` scan + `pnpm audit --prod` run in CI (report-only pre-1.0; to be tightened to a hard gate at 1.0). gitleaks + `detect-private-key` block secrets, actionlint + zizmor audit the workflows — pre-commit. | GitHub Actions (`trivy fs`, `pnpm audit`) + `.pre-commit-config.yaml` (gitleaks, actionlint, zizmor). |
| Disclosure | `SECURITY.md` published day 1 with PGP key, security@ inbox, 90-day disclosure window. | File exists at repo root before public push. |

## 8. RAG reference stack

Anchored to Anthropic's Contextual Retrieval benchmark (35/49/67% failure reduction).

```
Ingestion pipeline:
  ┌─ document
  ├─ chunker (semantic, 200-400 tokens per chunk)
  ├─ contextualizer (LLM prepends 50-100 token chunk-context string)
  ├─ embedder (default: AWS Bedrock Titan or Voyage AI)
  └─ index → (BM25 lexical) + (HNSW dense)

Query pipeline:
  ┌─ query
  ├─ rewrite (optional, intent-aware)
  ├─ parallel:
  │    ├─ BM25 top-K (K=50)
  │    └─ dense   top-K (K=50)
  ├─ fuse (RRF — Reciprocal Rank Fusion)
  ├─ rerank (cross-encoder: Cohere Rerank or BGE)
  └─ top-N (N=5-10) → context window
```

Per-stage metrics emitted to telemetry: `recall@K_bm25`, `recall@K_dense`, `recall@K_fused`, `recall@K_reranked`, `rerank_latency_ms`. Each stage swappable. Default vector store: **pgvector** (self-host friendly, no extra ops).

## 9. Multi-surface adapter pattern

Every surface is a thin adapter implementing:

```ts
interface Surface {
  name: string;
  rateLimit: RateLimitPolicy;       // platform-encoded, see §10
  inbound(): AsyncIterable<NormalizedEvent>;
  outbound(reply: NormalizedReply): Promise<void>;
  format(reply: NormalizedReply): PlatformMessage;
  // Optional, surface-specific:
  attachments?, blocks?, components?, interactions?
}
```

The runtime never knows about Telegram or Slack. Surfaces translate platform events into a `NormalizedEvent` (text, user, channel, thread, metadata) and translate `NormalizedReply` (text, citations, actions, attachments) back to platform-native format.

Per-surface formatter handles platform idiosyncrasies (Slack Block Kit, Discord embeds, Teams Adaptive Cards, Telegram MarkdownV2 escaping). This is where TENET's link-pipeline lives — but now once, not duplicated per surface.

## 10. Rate-limit scheduling (verified from research)

| Platform | Hard limits (verified 2026-06-03) | Our policy |
|---|---|---|
| Telegram | 1 msg/s/chat; 20 msg/min/group; ~30 msg/s broadcast (paid 1000/s) | Per-chat + per-group + global token buckets; broadcast queue separate |
| Discord | **10k invalid (401/403/429) / 10 min → ~24h Cloudflare IP ban** | Circuit breaker after 100 consecutive 401/403; auth-fail abort path; never blind-retry |
| Slack | 4 method tiers; chat.postMessage 1/s/channel; **post-2025-05-29 non-Marketplace conversations.history = 15 msg/req, 1 req/min** | Per-method tier scheduler; Marketplace vs non-Marketplace mode flag; backfill mode = drip-feed |
| MS Teams | 50 RPS/app/tenant; 1800 ops/hour/thread | Per-tenant budget; per-thread sub-budget |
| Zendesk | 200/400/400/700/2500 rpm by plan + Update Ticket 30/10min/ticket + 100/300 rpm/account | Plan-aware scheduler; endpoint sub-cap (esp. ticket-update batcher) |
| Intercom | TBD (research pass 2 gap) | Default conservative; refresh at deploy |
| Freshdesk | TBD | Default conservative |
| ServiceNow | TBD | Default conservative |

Limits live in `packages/rate-limit/policies/*.ts` as code constants with `verified_at_utc` comments. Operators can override per-deployment.

## 11. Telemetry — OTel GenAI semconv native

Spans emitted using [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Specific span attributes:

- `gen_ai.system` (e.g. `bedrock`, `anthropic`)
- `gen_ai.request.model`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `gen_ai.response.finish_reasons`

Plus our own attributes (under `agent.*` namespace):

- `agent.outcome` ∈ {`resolved`, `handed_off`, `disqualified`, `qualified`, `pending`}
- `agent.verifier.passed` (bool), `agent.verifier.failures[]`
- `agent.retrieval.recall_at_k.bm25`, `.dense`, `.fused`, `.reranked`
- `agent.surface`, `agent.tenant_id`, `agent.intent`
- `agent.cost_usd` (running sum per turn)

Default exporter: OTLP gRPC. Compatible with LangSmith, Braintrust, Phoenix, Langfuse, Helicone, or a customer's own Tempo/Jaeger. **No vendor lock-in at the telemetry layer.**

## 12. MVP slice — week 1 deliverable

The smallest end-to-end vertical that proves the spine works:

- `packages/core` + `packages/verifier` + `packages/retrieval` (pgvector only) + `packages/telemetry`
- `surfaces/telegram` only
- `models/bedrock` only (gpt-oss-120b, matching TENET's current setup)
- `stores/vector/pgvector` + `stores/state/redis`
- `apps/community-bot` — port TENET's current behavior to the new framework
- `eval/harness` running TENET's existing golden conversations against the new runtime (the repo-wide unit/suite figure — 98 suites / 1325 tests green as of 2026-07-18 — is the hermetic stub plane, not a real-model eval)

Success criteria for MVP:
1. TENET's golden conversations replay through the new runtime with **same or better** accuracy
2. CoVe + Reflexion + citation enforcement run on every output (not opt-in)
3. Telegram rate-limit policy enforced (verifiable: simulate flood, observe queueing)
4. OTel spans visible in a local Jaeger
5. CI runs eval suite as a gate

## 13. Phase 2 (week 2-4)

- Discord surface (community-bot deploys to both)
- Slack surface (Marketplace + internal app modes)
- Anthropic model adapter (Bedrock backup) — **delivered ahead of plan**: all 6 adapters (anthropic, bedrock, google, mistral, ollama, openai) now implement the canonical `ChatModel` contract
- Qdrant vector store (for multi-tenant deployments where pgvector is a bottleneck)
- mem0 / Letta memory adapter (long-term episodic)
- Web widget (SSE + JWT)
- `eval/datasets` — adversarial set covering each Constitutional Principle

## 14. Phase 3 (month 2-3)

- Enterprise surfaces: Teams, REST/gRPC
- Connectors: Zendesk, Intercom, Freshdesk, ServiceNow webhooks
- Multi-tenant `apps/enterprise-support` reference deployment
- On-prem Helm chart
- SOC2 audit prep
- MCP tool gateway with OAuth

## 15. Open questions (defer or research-pass-2)

Carried forward from research pass 1 — not blocking architecture but blocking some implementation details:

1. **Closed-tool architecture (Decagon/Sierra/Cresta/Aisera/Moveworks):** are they single-model, multi-model, fine-tuned? Decides whether we ship a fine-tune-aware router by phase 2.
2. **Vector store cost-perf at 10M-1B vectors:** pgvector good enough for enterprise, or do we need Qdrant/Turbopuffer as default? Decides phase 2 default.
3. **MCP enterprise adoption:** is it real or hype? Decides whether MCP-native is a launch story or a phase-2 story.
4. **Eval layer head-to-head (LangSmith/Braintrust/Phoenix/Langfuse/Helicone):** which to recommend as default sink. OTel GenAI semconv export covers all of them, but the docs need to recommend one.

## 16. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| LangChain ecosystem moves faster than ours, captures community | High | Don't compete on integration breadth. Compete on verification + security stance. Ship `langchain-import` codemod for migration. |
| Verifier overhead makes responses too slow | Medium | Verifier runs in parallel with output where possible; streaming masks latency. Eval suite gates on p95 latency. |
| Multi-surface == multi-debt: every surface API changes quarterly | High | Pin SDK versions; CI runs against each platform's official test environment weekly; surface deprecation policy. |
| Enterprise buyers want vendor support, not OSS | High (for enterprise app) | Commercial entity offers SLA + on-prem deploy for enterprise tier. OSS core remains free. |
| OTel GenAI semconv is still alpha and changes | Medium | Pin to a specific spec version; adapter layer in `packages/telemetry`. Re-pin on stable. |

## 17. Model + agent turn contract (shipped)

The runtime spine described abstractly in §4 now has a concrete, single-source-of-truth
contract in code. This section documents what exists on `upgrade/top-1pct`; it supersedes
any earlier text that implied a single-string model or an undriven `AgentState`.

### 17.1 Canonical `ChatModel` (Phase 1 — `packages/core/src/model.ts`)

One interface replaced four duplicated `chat({system, user}): Promise<string>` copies:

```ts
interface ChatModel { chat(req: ChatRequest): Promise<ChatResponse>; }
```

- **Messages array, not a flattened string.** `ChatRequest.messages: ModelMessage[]`, where
  each `ModelMessage` is `{ role, content: ContentBlock[] }`. Turn boundaries are structural,
  so a user message whose text contains `"assistant:"` can no longer forge a prior assistant
  turn (the `${role}: ${content}` spoof is gone — see §17.3).
- **Tool round-trips are first-class.** `ContentBlock = text | tool_use | tool_result`, so a
  turn can carry text and tool calls together, and tool results feed back as content.
- **`signal: AbortSignal` is required** (non-optional, `model.ts:57`). A cancelled turn
  releases the in-flight HTTP call — this closes the earlier "no `AbortSignal` → zombie HTTP"
  gap (former PENDING B3).
- **Lossless `StopReason` union:** `end_turn | max_tokens | stop_sequence | tool_use | refusal
  | aborted` — `end_turn` and `stop_sequence` stay distinct; no collapse to a generic `stop`.

All six adapters migrated to this contract, and three provider "abnormal stop" bugs were
fixed — each had been reported as a clean completion:

- **Anthropic** streaming hardcoded `end_turn` over real truncation → now maps to `max_tokens`.
- **Mistral** `model_length` (context overflow) masked as `end_turn` → `max_tokens`
  (`models/mistral/src/index.ts:60`).
- **Google** content-block reasons (`PROHIBITED_CONTENT` / `SPII` / `BLOCKLIST` /
  `IMAGE_SAFETY`, plus `SAFETY` / `RECITATION`) masked as `end_turn` → `refusal`
  (`models/google/src/index.ts:71-76`).

`@tenet/streaming` and `@tenet/ag-ui` re-export/align to the canonical `StreamChunk` (a
divergent local copy with a loose `stopReason: string` was removed). The transitional
bridges (`fromLegacyModel`, `asLegacyModel`, `LegacySingleStringModel`, `LegacyChatArgs`)
were deleted — every consumer speaks the canonical contract, no bridges remain.

### 17.2 Agent turn (Phase 2 — `packages/agent/`, shipped)

`AgentState` (`packages/core/src/types.ts:161`) is now a real type contract — `event`,
`history`, `intent`, `sources`, `draft`/`draftCitations`, `critique`, `attempts`,
`outcome`. `@tenet/agent` drives it:

- `OrchestratorState extends AgentState` (`agent/src/types.ts:45`) adds transient carriers
  (`chunks`, `cachedDraft`, `toolResults`) and an explicit terminal `halt` channel.
- One model turn returns a **discriminated `ReasonerOutput`** — `answer | tool | handoff |
  abstain` (`agent/src/types.ts:68`). There is **no privileged/default `answer`**.
- The **fail-closed Reasoner** (`modelReasoner` + `parseEnvelope`, `agent/src/reasoner.ts`)
  is grounded-or-abstain: an `answer` is discarded unless it carries at least one citation
  with a non-blank `sourceId` and verbatim `quote`; every ambiguity — envelope parse
  failure, unknown action, missing field, `tool_use` stop with no tool blocks, `refusal`,
  `aborted`, uncited answer — resolves to `abstain`. Enforcement never trusts the model.
  Proven by 33 deterministic tests (`agent/src/reasoner.test.ts`).

**Shipped — `runAgent` (`agent/src/orchestrator.ts`)** wires these into the end-to-end loop:
`sequential(halting(withTimeout(injectionGate)), halting(withTimeout(retrieveNode)),
halting(withTimeout(cacheNode)), halting(withTimeout(compactNode)), halting(criticLoop))` run via
`runWorkflow`.

- **Pre-reasoning nodes** (`agent/src/nodes.ts`): `injectionGate` (a blocked/throwing inbound
  filter → security handoff), `retrieveNode` (thin evidence / retriever error → abstain; feeds
  retrieval *relevance*, not `Source.confidence`, to the knowledge-boundary gate), `cacheNode`
  (a hit is a CANDIDATE only — re-verified, never emitted here; miss/error → continue), and
  `compactNode` (OPT-IN long-history compaction via the injected `HistoryCompactor` port — a
  history that overflows the window is summarized to fit BEFORE the reasoner reads it; a
  compaction error → abstain, so a silently truncated prompt is never sent; no compactor
  configured → pass through untouched).
- **`criticLoop`** (`agent/src/criticLoop.ts`): reason → `abstain | handoff | tool | answer` (an
  exhaustiveness `default` makes any unmappable decision abstain immediately — compile-enforced, so a
  new variant can't be silently forgotten); a tool runs through governance (`runTools`,
  `agent/src/tools.ts` — gate-all-before-executing-any, deny/`require_approval` → ops handoff) and its
  results fold back into history; an answer goes through the single emit edge.
- **`verifyAndEmit`** (`agent/src/emit.ts`) is the ONLY emit edge: verify (fail-closed) → require
  ≥1 grounded citation → outbound leak gate → emit. A verify failure, uncited pass, or leak → abstain.
- **Two fail-closed backstops:** `finalize` abstains if the graph ever returns without a carried
  terminal; the top-level catch turns any `WorkflowError` (timeout/abort) or uncaught throw into an
  abstain. Terminals are CARRIED in `state.halt`, never thrown, so a handoff is never mistaken for a crash.

The answer repair-retry (`deps.rewrite` + re-verify, ≤ `maxRepairRounds`) is shipped. Follow-up (does
not weaken the guarantee): real-model validation of the decides-and-drafts prompt (deferred until a
key exists). The verifier's own fail-closed MODE ships (3.1 — `failClosed` flag); the rest of Phase 3
(non-numeric claim tier, truncation/maxClaims hardening) remains.

### 17.3 Turn-spoof kill (`apps/community-bot`)

History is now assembled as structured `ModelMessage`s rather than a concatenated
`${role}: ${content}` string, so a user message containing `"assistant:"` cannot forge a
prior assistant turn. Covered by a bot-level role-safety test
(`apps/community-bot/src/index.test.ts:166`) and a wire-level role-spoof regression test in
the Anthropic adapter (`models/anthropic/src/index.test.ts:131`).

---

## What this doc commits us to (so we don't drift)

- TypeScript primary. Python only for eval/research.
- Hardened-by-construction security (no pickle, no Jinja2, parameterized queries, path allow-list).
- Verification by default (CoVe + Reflexion + Constitutional + citation enforcement).
- All surfaces from one config.
- Outcome events as first-class telemetry primitive.
- pnpm workspaces monorepo, repo layout per §5.
- MVP slice = community-bot on Telegram with full verification + telemetry, ported from TENET.

What's deferred until research pass 2 or real demand:
- Java/Go runtimes (gRPC client only)
- Vector store default beyond pgvector
- MCP-as-launch-story (vs phase-2)
- Eval-layer recommendation
