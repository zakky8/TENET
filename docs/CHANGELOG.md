# Changelog

All notable changes to TENET are recorded here. Format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 the API surface and behavior may change without major bumps. We will pin breaking changes by minor version (`0.X.Y`).

## [Unreleased]

### Added — coverage gate that protects the actual coverage level (6.2, 2026-07-18)
`pnpm test:coverage` is now a CI step, and the `jest.config.cjs` `coverageThreshold` was raised from the loose
60/70/70/70 floor to **75 branches / 90 functions / 90 lines / 88 statements** — just below the actual
90.3/78.5/94.4/93.0 (small margin). The old floor silently allowed coverage to regress to 60%; the new gate
fails CI on a real drop. Verified: coverage passes at the new thresholds (exit 0); mutation-probed that it
ENFORCES (setting branches to 90 > actual 78.46 failed with "threshold for branches (90%) not met").

### Changed — replace competitor ✓/✗ grids with TENET-only capability tables (7.2, 2026-07-18)
Both README comparison tables ("Where TENET focuses" and "Quick comparison") asserted specific, unverified
capabilities about ~7 named competitors — including "maintenance" (implying AutoGen is abandoned), dated
release claims ("✅ (2026-04)"), and per-vendor pricing ("$0.99 / resolution") that cannot be sourced from
this repo. For an anti-hallucination framework that is the exact unsourced-claim class it exists to prevent.
Replaced both with TENET-ONLY tables that assert only this repo's own capabilities, each backed by a named
package verified to exist in the tree (`@tenet/governance`, `@tenet/verifier`, `@tenet/refine`,
`@tenet/durable`, `@tenet/a2a`, `@tenet/ag-ui`, `@tenet/harness`, `@tenet/judge-hhem`, `@tenet/telemetry`,
`@tenet/tools-mcp-gateway`, `@tenet/tools-wasm-sandbox`, `infra/helm/tenet`, …), with a clear note on WHY.
Also fixed the stale "Multi-surface (10)" / "10 shipped" → 9 surface adapters. No per-competitor grid remains.

### Added — mermaid architecture diagram of the fail-closed turn (7.3, 2026-07-18)
A "How a turn works" section in the README with a mermaid flowchart of `runAgent`'s graph: injection gate →
retrieve + knowledge boundary → cache re-verify → reason → (tool via governance | answer) → verify + citation
guard + leak gate → the single `emit` edge, with every non-emit edge resolving to abstain or handoff. Traced
against the actual `orchestrator.ts` + `criticLoop`; mermaid syntax structurally validated (bracket balance,
edge count). Renders natively on GitHub.

### Fixed — accurate site SEO meta + robots.txt (7.3, 2026-07-18)
`docs/_config.yml`'s `description` (the Google snippet + `og:description` that `jekyll-seo-tag` emits) was
stale/inaccurate: "10 surfaces" but listed 8, and the bare "0 high-severity CVEs" boast. Corrected to the
real "9 surface adapters (Discord, Slack, Telegram, Teams, web widget, REST, gRPC, Matrix, voice)", led with
the grounded-or-abstain guarantee, and replaced the CVE boast with "hardened by construction" (consistent
with the earlier index.md fix; the MEASURED Dim-6 posture stays in BENCHMARKS where it states its method).
Added `docs/FAQ.md` to the site include list so the answer-shaped FAQ is crawlable, and added `docs/robots.txt`
(allow all + a Jekyll-rendered `Sitemap:` pointing at the `jekyll-sitemap` output). YAML validated.

### Added — `docs/FAQ.md` answer-shaped FAQ for AEO/SEO (7.3, 2026-07-18)
A structured FAQ with answer-shaped questions (how TENET prevents hallucination, what grounded-or-abstain
means, is-it-a-LangChain-alternative, supported models/surfaces, how the verifier works, is-it-production-ready,
licensing, getting started). Every answer is measured — capabilities named are code in the tree (6 model
adapters, 9 surface adapters, 4 ticketing connectors, `infra/helm/tenet`), no unsourced competitor claims,
and the production-readiness answer is honest (pre-1.0; adapters transport-injected; in-repo numbers are the
hermetic stub). Linked from `llms.txt`; sets up the JSON-LD `FAQPage` (remaining 7.3).

### Added — `skillToolPolicyRule`: `allowed-tools` is now ENFORCED, not decorative (8.2, 2026-07-18)
`@tenet/skills` gains `skillToolPolicyRule(frontmatter)` → a `@tenet/governance` `PolicyRule` that allows
ONLY the tools a skill declared. Dropped into a `PolicyEvaluator`, a skill physically cannot call a tool it
did not declare (the agent's `runTools` gates every call before execution). FAIL-CLOSED: a skill that
declares no `allowed-tools` may call none. This turns the header's long-standing "governance-aware" promise
(and the package description's "@tenet/governance allowed-tools enforcement") into a shipped, tested helper —
`@tenet/skills` now actually depends on `@tenet/governance`. Tests prove allow-declared / deny-undeclared
(with reason) / deny-all-on-empty. Suite 1195 → 1198.

### Added — flagship `SKILL.md`: build a verification-first, grounded-or-abstain agent (8.1, 2026-07-18)
A repo-root `SKILL.md` (parseable by `@tenet/skills`' own `SkillRegistry`, frontmatter
`name: verification-first-agent`) distilling how to build an agent whose worst outcome is a human
handoff, never an ungrounded fact: the one rule, the fail-closed turn shape, 8 techniques (no default
answer, one emit edge, grounded-citation guard, fail-closed on infra failure, verify-against-sources,
gate-tools-before-run, knowledge-boundary + cache re-verify, required AbortSignal), the anti-patterns that
cause hallucination, a build checklist, and TENET as the reference implementation. Generic and zero
cross-project content. A regression test in `@tenet/skills` reads the shipped `SKILL.md` and asserts it
parses + registers, so the flagship skill can never silently become malformed. Suite 1193 → 1195.

### Added — `llms.txt` AEO index for AI agents / crawlers (7.3, 2026-07-18)
A repo-root `llms.txt` (llmstxt.org format): one-line guarantee, an honest-read context paragraph,
and linked sections (Documentation, Core concepts, What ships today) so an LLM or agent can navigate
TENET without scraping. Every fact is measured — the test count is the live-suite number, and `llms.txt`
was added to `scripts/check-counts.mjs`'s source-of-truth list so its "N tests across M suites" claim is
now gated by `pnpm counts:check` too (proven: a wrong count fails CI). No cross-project content, no
unsourced claims. Remaining 7.3: `llms-full.txt`, JSON-LD (SoftwareSourceCode + FAQPage), `docs/FAQ.md`,
OG image + `og:image`, `robots.txt`, Pages deploy workflow.

### Fixed — reconcile the ROADMAP phase tables to the as-built monorepo (7.2, 2026-07-18)
The ROADMAP's Phase 2/3 tables still said "not started" for surfaces, connectors, stores, the MCP
gateway, WASM sandbox, enterprise-support app, and the Helm chart — all of which actually ship in the
tree (verified this change: 9 surface adapters, `connectors/ticketing` with zendesk/intercom/freshdesk/
servicenow modules, `stores/vector/qdrant`, `@tenet/memory-adapters` with mem0/Letta/Zep providers,
`@tenet/tools-mcp-gateway`, `@tenet/tools-wasm-sandbox(-wasmtime)`, `apps/enterprise-support`,
`infra/helm/tenet`). A "not started" claim for shipped code is a stale-status hallucination in the repo's
own voice. Flipped the stale cells to ✓ with an as-built note (surfaces take an injected transport; the
current-state banner is canonical); kept the genuinely-open items honest (eval-set 1k growth, SOC2 prep).

### Changed — remove unsourced competitor security claims (measured, not marketed; 7.2, 2026-07-18)
An anti-hallucination framework must not ship unsourced attacks on named competitors — that is the
exact self-contradiction it exists to prevent. Generalized every named-competitor CVE/vulnerability
claim to threat-model framing that attributes nothing to any project:
- ARCHITECTURE §1 no longer says named frameworks "shipped CVE-class mistakes"; it describes the
  ecosystem's CVE-CLASS mistake *categories* we design out.
- SECURITY.md "LangChain-class vulnerabilities" → "known agent-framework vulnerability classes";
  BENCHMARKS Dim 6 "the LangChain CVE categories" → "known agent-framework CVE-class categories";
  RESEARCH-PASS-2's LangGraph "CVE history remains a concern" cell → no advisory attributed.
- docs/index.md meta description dropped the bare "0 CVEs" boast (unearned for a new, unaudited
  project) → "hardened by construction". TENET's own MEASURED Dim-6 posture (Trivy / npm audit /
  GitHub Advisories in CI) stays — it states its method. Self-claims about TENET's own hardening
  (no pickle, PathHandle, parameterized queries) are unchanged; those describe this repo's code.

### Added — `counts:check`: the live suite is the single source of truth for doc counts (2026-07-18)
`scripts/check-counts.mjs` (`pnpm counts:check`, now a CI step) runs the suite, reads the real
`numTotalTests`/`numTotalTestSuites`, and fails if any tracked doc's count-claim disagrees — so a
hard-coded "N tests across M suites" in a README can never silently fall behind the suite again (a
stale number is a hallucination in the repo's own voice). Fixed the current drift in the same change:
the README badge/status and several docs still said **1174**; the live suite is **1193 / 92**.

### Fixed — Reasoner abstains on `max_tokens` (truncation → never ship, 2026-07-18)
The decides-and-drafts Reasoner (`packages/agent/src/reasoner.ts`) handled `refusal` and
`aborted` stop reasons but fell through to envelope-parsing on `max_tokens`, so a truncated
response with a parseable-looking answer envelope could ship a cut-off draft. It now abstains
on `max_tokens` alongside `refusal`/`aborted` — a truncated turn cannot be trusted. Regression
test asserts a VALID answer envelope with `stopReason:'max_tokens'` → abstain. Suite 1189 → 1190.

### Added — verifier `failClosed` mode: close the infra fail-open (Phase 3.1, 2026-07-18)
Branch `upgrade/top-1pct`. Test suite: 1181 → 1189 tests across 92 suites, all green.
`VerifierConfig.failClosed?: boolean` (default `false`, preserving existing callers).
Closes a real ship hole: a broken/down JUDGE marked all claims `supported:true` →
`verifyDraft` returned `pass:true` WITH citations → the orchestrator's grounded-citation
guard emitted an unverified answer.
- `claimExtractor.ts`: on extractor error/timeout, throws `ClaimExtractionError` (not `[]`)
  when `failClosed` — so `verifyDraft` returns `pass:false` instead of mistaking a failed
  extraction for zero claims.
- `judge.ts`: a judge error/timeout OR a total-garbage (no-parse) response marks claims
  `supported:false` when `failClosed` (was the fail-open "all supported"). The permissive
  re-judge runs the same broken model, so it stays unsupported → `pass:false`.
- `claimExtractor.ts` (3.3 maxClaims-drop, 2026-07-18): when `failClosed` and the model
  over-produces past `maxClaims`, the extractor throws instead of silently `.slice`-ing off
  the extras → `verifyDraft` → `pass:false`. Previously the dropped claims were never
  verified, so a fabrication past the cap could ship. Suite 1190 → 1193.
- DELIBERATE: a genuinely claim-free draft (greeting; extractor returns `NONE`) still
  passes — it is vacuously grounded; emit policy (require a citation) is the orchestrator's
  job. `failClosed` hardens infra failures, not legitimate empties.
- Default (no `failClosed`) is byte-for-byte the old fail-open behavior (116 prior verifier
  tests unchanged). The reference orchestrator sets `failClosed:true` behind its Verifier port.

### Added — `@tenet/agent` orchestrator SHIPPED: the driven, fail-closed turn (2026-07-18)
Branch `upgrade/top-1pct`. Test suite: 1117 → 1174 tests across 85 → 92 suites, all green.
62 workspace packages. This completes Phase 2's agent turn — `AgentState` was a state machine
nothing drove; it is now driven end-to-end.

- **`runAgent`** (`packages/agent/src/orchestrator.ts`) executes `OrchestratorState` as a
  `@tenet/workflow` graph: `sequential(halting(withTimeout(injectionGate)), halting(withTimeout(
  retrieveNode)), halting(withTimeout(cacheNode)), halting(criticLoop))`, then `finalize`.
- **Pre-reasoning nodes** (`agent/src/nodes.ts`): `injectionGate` (blocked/throwing filter →
  security handoff), `retrieveNode` (thin evidence / retriever error → abstain; boundary gate keys
  on retrieval relevance, not `Source.confidence`), `cacheNode` (hit is a candidate, re-verified).
- **`criticLoop`** (`agent/src/criticLoop.ts`): reason → abstain | handoff | tool | answer; tools
  run through governance (`runTools`, `agent/src/tools.ts` — gate all before executing any;
  deny/`require_approval` → ops handoff), results fold back into history.
- **`verifyAndEmit`** (`agent/src/emit.ts`) is the single emit edge: verify (fail-closed) → require
  ≥1 grounded citation (non-blank `sourceId` + `quote`) → outbound leak gate → emit.
- **Fail-closed backstops:** terminals CARRIED in `state.halt` (never thrown); `finalize` abstains
  on an unset terminal; a top-level catch turns any `WorkflowError`/throw into an abstain.
- **Answer repair-retry** (`criticLoop`): on a `repair` verdict the draft is rewritten via `deps.rewrite`
  (a `RewriteFn`) and re-verified through the SAME emit edge, up to `maxRepairRounds`, then abstains. The
  rewritten draft is never trusted — it re-enters `verifyAndEmit`, so a bad rewrite cannot ship.
- Deferred (does not weaken the guarantee): real-model prompt validation (no model access in this env).

### Added — canonical `ChatModel` contract + `@tenet/agent` Phase 2 start (2026-07-18)
Branch `upgrade/top-1pct`. Test suite: 1051 → 1117 tests across 83 → 85 suites,
all green. 62 workspace packages.

**One canonical `ChatModel` (Phase 1 complete).**
- `@tenet/core` now defines a single `ChatModel.chat(req): Promise<ChatResponse>`
  over a MESSAGES ARRAY (`ModelMessage[]`, `packages/core/src/model.ts:31`), tool
  round-trips via a discriminated `ContentBlock` (`text | tool_use | tool_result`,
  model.ts:14), and a lossless `StopReason` union (`end_turn | max_tokens |
  stop_sequence | tool_use | refusal | aborted`, model.ts:38). It REPLACES the four
  duplicated single-string `chat({system, user}): Promise<string>` interfaces.
- `signal: AbortSignal` is REQUIRED on `ChatRequest`, not optional
  (`packages/core/src/model.ts:57`) — resolves PENDING B3 (un-abortable `chat` →
  zombie HTTP).
- All 6 model adapters (`models/{anthropic,bedrock,google,mistral,ollama,openai}`)
  migrated to the canonical contract; C7 (`models/bedrock` "not yet implemented")
  is DONE — all six adapters exist.
- Three real provider bugs fixed — each an abnormal stop that was being reported as
  a clean completion:
  - Anthropic streaming hardcoded `end_turn`; the real `stop_reason` from
    `message_delta` is now mapped (`models/anthropic/src/index.ts:66,295`).
  - Mistral `model_length` (context-window overflow, a truncation) → `max_tokens`,
    not the default `end_turn` (`models/mistral/src/index.ts:60`).
  - Google content-block finish reasons (`SAFETY`, `RECITATION`,
    `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `IMAGE_SAFETY`) → `refusal`, not
    `end_turn` (`models/google/src/index.ts:71-76`).
- `@tenet/streaming` re-exports the canonical `StreamChunk` / `StreamingChatModel`
  from `@tenet/core` (its divergent local copy, which typed `stopReason` as a loose
  `string`, was removed — `packages/streaming/src/index.ts:24`); `@tenet/ag-ui`
  aligned its `StreamChunk` to the canonical one.
- `@tenet/verifier`, `apps/quickstart`, `apps/measure-real`, `apps/community-bot`,
  and `@tenet/router` all flipped onto the canonical contract.

### Fixed — canonical migration (2026-07-18)
- **`${role}: ${content}` turn-spoof killed.** community-bot history is now
  STRUCTURED `ModelMessage`s (`apps/community-bot/src/index.ts:114` builds each
  turn via `textMessage(role, content)`), so a member message containing
  `assistant:` can no longer forge a prior assistant turn — the forged text is
  preserved inside a user-role message, not promoted. Covered by a wire-level
  role-spoof regression test in the Anthropic adapter
  (`models/anthropic/src/index.test.ts:131`) and a community-bot test
  (`apps/community-bot/src/index.test.ts:187`).
- **Transitional migration bridges deleted.** `fromLegacyModel`, `asLegacyModel`,
  `LegacySingleStringModel`, and `LegacyChatArgs` are gone — every consumer speaks
  the canonical contract, no bridges remain (grep-clean across `packages/`,
  `models/`, `apps/`).
- The single-string `ChatModel` schism (the recon's "root of no conversation
  memory") is RESOLVED — one messages-array contract; role structure now reaches
  the model.
- PENDING B2 (`PathHandle` had no factory) RESOLVED — `openPath()` ships
  (`packages/core/src/path.ts:58`): allow-list root, with absolute-path and
  `..`-traversal rejection at construction time.

### Added — `@tenet/agent` (Phase 2, in progress, 2026-07-18)
- Orchestrator TYPE CONTRACT: `OrchestratorState extends AgentState`
  (`packages/agent/src/types.ts:45`) + a discriminated
  `ReasonerOutput = answer | tool | handoff | abstain` with NO default `answer`
  (types.ts:68).
- FAIL-CLOSED decides-and-drafts Reasoner (`modelReasoner` + `parseEnvelope`,
  `packages/agent/src/reasoner.ts`): grounded-or-abstain — an `answer` is discarded
  unless it carries at least one non-blank citation (reasoner.ts:99), and every
  ambiguity (envelope parse failure, unknown action, `tool_use` stop with no tool
  blocks, `refusal`, `aborted`, uncited answer) resolves to `abstain`. Proven by 33
  deterministic tests (`packages/agent/src/reasoner.test.ts`).

**Pending at the time of this entry (SINCE SHIPPED — see the top entry):**
- The `runAgent` workflow graph that DRIVES `AgentState` end-to-end. As of the entry
  above it is shipped (`packages/agent/src/orchestrator.ts`): nodes → Reasoner →
  governance-gated tools → verify → single emit edge, all fail-closed.
- The verifier's own fail-closed changes are a later phase (Phase 3). *(Since shipped as the
  `failClosed` mode — see the Phase 3.1 entry at the top.)*
- No real-model benchmark numbers exist yet (no model access in this environment);
  the hermetic stub remains the only measured plane.
- PENDING B1, B4, B5 remain OPEN — not touched by this upgrade.

### Added — Phase 16 (answer-quality engine, 2026-06-11)
Model-agnostic hallucination reduction + smarter/faster responses from
ANY ChatModel:
- **Deterministic pre-check tier in `@tenet/verifier`** — three-way
  `ClaimPreCheck` (pass/fail/judge) before the LLM judges:
  `numericFabricationCheck` fails claims with numbers absent from every
  source (the wrong-number hallucination LLM judges wave through —
  proven by the backwards-compat test), `quoteGroundingCheck` passes
  verbatim-quote claims without a judge call. Every settled claim saves
  1–2 judge calls. Opt-in via `claimPreChecks: defaultPreChecks()`.
- **`@tenet/refine`** — answer-quality orchestration:
  `knowledgeBoundaryGate` (abstain BEFORE drafting on weak retrieval
  coverage — cheapest point to stop wrong info), `repairDraft` (rewrite
  only the unsupported claims and re-verify, bounded rounds, full
  verifier still gates), `bestOfN` (parallel drafts ranked by
  supported-claim ratio — buys quality from small/local models),
  `selfConsistency` (claims that flip across samples = confabulation
  signal, SelfCheckGPT applied at claim level).

### Added — Phase 15 (top-0.01% market gaps, 2026-06-10)
A fresh A-to-Z repo audit (3 parallel reviewers) + live market research over the
June-2026 framework landscape (LangGraph 1.0, OpenAI Agents SDK 2026-04, Vercel
AI SDK 6 + WDK, Mastra 1.x, Pydantic-AI v1.107, MS Agent Framework 1.0, Google
ADK 2.x, A2A v1.0, AG-UI, MCP 2026-07-28 RC) identified the three TypeScript
open lanes. All three shipped, plus the audit's DX + truth findings:
- **`@tenet/durable`** — step-level durable execution: name-keyed journal
  memoization (Promise.all-safe), `interrupt()` human-in-the-loop that survives
  process restarts, durable `sleep()`, `NondeterminismError` replay-drift
  guard, `StateStoreJournal` over Redis/Postgres state stores. 16 tests.
- **`@tenet/a2a`** — Agent2Agent protocol v1 server (AgentCard, task
  lifecycle, tasks/cancel aborts in-flight handlers) + fetch-injected client
  (well-known card discovery, sendMessage/getTask/cancelTask). 15 tests.
- **`@tenet/ag-ui`** — AG-UI event protocol: typed event union,
  lifecycle-enforcing `AgUiRunEmitter`, `streamChunksToAgUi` bridge so all 6
  streaming model adapters drive AG-UI frontends, SSE encoder. 16 tests.
- **`@tenet/harness`** — long-horizon layer: token-budget `ContextCompactor`
  (pinned system prompts, verbatim recent window), `TodoLedger` with JSON
  round-trip, `spawnSubagents` bounded-concurrency fan-out with error
  isolation + `Handoff` descriptor. 15 tests.
- **`apps/quickstart`** — `pnpm quickstart`: full retrieve→draft→verify REPL
  with ZERO keys (deterministic stub routes on the verifier's own prompt
  contract) or `ANTHROPIC_API_KEY` for a real model. 4 tests.
- **`@tenet/stores-state-postgres`** — the dir existed empty; now a real
  package: single-table KV, lazy TTL, atomic one-round-trip `incr()` with
  Redis-compatible expiry semantics, table-name injection guard. 8 tests.
- **Bedrock streaming** — `chatStream()` via injected
  `InvokeModelWithResponseStream`; task #83 had claimed this shipped in P8 and
  it had not (caught by the audit, fixed under the truth-restoration rule).
  6 tests.

### Fixed — Phase 15
- Removed the empty `surfaces/webhook/` directory (ticketing connectors live
  in `connectors/ticketing`).
- README drift: "3 model adapters" → 6 (all streaming), the README's several
  inconsistent test counts reconciled to a single reported figure (the canonical
  total has since advanced to 1174 tests across 92 suites — see the 2026-07-18
  entry above), surface arithmetic corrected to
  9 surfaces + 4 ticketing connectors, stale competitor-table HITL marks
  updated against June-2026 reality (LangGraph interrupt(), Mastra
  suspend/resume, OpenAI harness approvals).

### Added — Phase 7 (competitor weakness exploit, 2026-06-04)
Web-verified competitor research (LangChain, LangGraph, AutoGen, CrewAI, LlamaIndex, Semantic Kernel, Mastra, Pydantic-AI, OpenAI Agents, mem0, Letta, Zep) surfaced specific weaknesses. We shipped fixes for the ones we can exploit.
- **`@tenet/governance`** — the unfilled OSS gap. 2026 research: *"None evaluates a tool call against a policy before it executes, none requires approval gates by default, none ships a structured audit trail without custom integration."* We ship all three: `PolicyEvaluator` with deny/allow/require_approval, `ApprovalGate` with idempotency cache, `AuditSink` with 6 typed event kinds, built-in rules (`allowListRule`, `tagRequiresApprovalRule`, `denyArgPatternRule`, `numericLimitRule`), stable approval keys (argument-order independent). 17 tests.
- **`@tenet/memory` consistency layer** — fixes the mem0 indexing-reliability + Zep post-ingestion-retrieval bug class. `mintToken` (deterministic idempotency), `WriteAck.readableAtMs`, `waitUntilReadable` with exponential backoff + abort, `resolveConflict` with explicit policies (last_write_wins / first_write_wins / merge). 13 tests.
- **`@tenet/models-anthropic.chatStream()`** — SSE-streamed Anthropic Messages API. Closes our last own gap. Honors `content_block_delta`, `message_delta` usage, `message_stop`. Emits `StreamChunk` shapes from `@tenet/streaming` so the verifier and `measureTtft` see one consistent shape across providers.

### Added — Phase 6 (close 3 OSS gaps, 2026-06-04)
- **`@tenet/streaming`** — non-breaking streaming ChatModel contract + SSE parser + incremental JSON parser (Pydantic-AI's structured-output pattern, generalised).
- **`@tenet/models-openai`** — direct OpenAI Chat Completions adapter, no SDK dep. Implements both `chat()` and `chatStream()`.
- **`@tenet/workflow`** — deterministic DAG primitives: sequential / parallel / branch / retry / withTimeout + per-step trace events.

### Added — Phase 5 (research-led residuals, 2026-06-04)
- `@tenet/distillation` — verified flagship trace capture + LoRA JSONL emitter.
- `@tenet/eval-mining` — assertion miner + cosine dedup + EvalCase emitter.
- `@tenet/rerank-cohere` — Cohere Rerank v2 API adapter, fetch-injected.
- `packages/judge-hhem-onnx/examples/transformers-pipeline.ts` — operator wiring for real HHEM-2.1.
- `.github/workflows/measure-real.yml` — secret-gated real-model harness on cron.
- `docs/RESEARCH-PASS-3.md` — operator-led research scaffold per source-hierarchy rules.

### Added — Phase 4 (BENCHMARKS gated in CI, 2026-06-04)
- `@tenet/eval-metrics` — Wilson-95 + quantile + per-dimension scorers.
- `@tenet/eval-measure` — hermetic measurement runner + CLI; 11/11 dimensions PASS on stub gate.
- `@tenet/judge-hhem` — Vectara HHEM-2.1 contract + reference token-overlap scorer.
- `@tenet/app-measure-real` — real-ChatModel runner + PUBLIC_SLICE (`tenet-public-slice-0.1.0`).
- `@tenet/tools-wasm-sandbox-wasmtime` — production wasmtime WasmRuntime adapter.
- `.github/workflows/ci.yml` benchmarks-gate job — fails any PR on FAIL/MISSING; uploads measured.json artifact.

### Added — Phase 1 MVP packages — all landed:
  - `@tenet/rate-limit` — `TokenBucket` + `CircuitBreaker` + `RateLimitScheduler` with 5 platform policies (Telegram, Discord, Slack, Teams, Zendesk).
  - `@tenet/guardrails` — `PiiRedactor` (7 kinds) + composable `Filter` chain (`lengthFilter`, `denylistFilter`, `runFilterChain`).
  - `@tenet/retrieval` — `Bm25Index` (Okapi BM25 with Lucene-style IDF smoothing) + `InMemoryVectorStore` + `reciprocalRankFusion` (Cormack 2009) + `HybridPipeline` with per-stage metrics.
  - `@tenet/router` — `AdaptiveRouter` (classifier-driven tier picking + flagship fallback) + `InMemorySemanticAnswerCache` (cosine LRU) + `SpeculativeAgent` (cheap + flagship in parallel, verifier-driven promotion).
  - `@tenet/memory` — `WorkingMemory` (ring buffer with token-budget cap) + `InMemoryEpisodicMemory` (per-conversation history) + `InMemorySemanticMemory` (cross-conversation facts with confidence-aware eviction).
  - `@tenet/models-bedrock` — `AnthropicOnBedrockChatModel`; no AWS SDK hard dep (injected invoker).
  - `@tenet/stores-vector-pgvector` — `PgVectorStore`; no pg SDK hard dep (injected query executor); all values parameter-bound; table name validated against `/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`.
  - `@tenet/stores-state-redis` — `StateStore` interface + `InMemoryStateStore` (TTL + LRU eviction) + `RedisStateStore` adapter.
  - `@tenet/surface-telegram` — `TelegramSurface` adapter with HTML escaping, citation rendering, optional rate-limit gate.
  - `@tenet/eval-harness` — `runEval` + 5 builtin assertions + `regressionGate` for eval-as-CI.
  - `@tenet/app-community-bot` — reference composition wiring all of the above.
- **Adversarial-review bug fixes (5):**
  - B1 — `SourcePicker` strategy replaces `buildCitations`' naive head-substring match.
  - B2 — `openPath()` factory shipped; `PathHandle` type is no longer vapor.
  - B3 — `ChatModel.chat` accepts `AbortSignal`; `withTimeoutAndSignal` aborts the controller on timer fire.
  - B4 — `OutcomeEmitter` re-entrancy guard (`MAX_EMIT_DEPTH=4`) + `SwallowedErrorReporter` callback.
  - B5 — `ClaimPreFilter` + `JudgePromptDecorator` interfaces; `urlAllowlistFilter` + `examplesDecorator` factories.
- Scaffolded the four MVP packages: `@tenet/core`, `@tenet/verifier`, `@tenet/policy`, `@tenet/telemetry`.
- `Secret<T>` opaque type that refuses `JSON.stringify`, blocking a secret-leak-via-serialization class of bug.
- `Filter<TKey>` + `validateFilterKey` that reject `--`, `..`, and any non-`[a-zA-Z0-9_.-]` characters in metadata filter keys — blocks a metadata-filter SQL-injection class of bug.
- `PathHandle` branded type for path-allowlisted file I/O (factory ships as `openPath()`, `packages/core/src/path.ts:58`).
- `TenetError` with stable error codes (`VERIFIER_FAILED`, `RETRIEVAL_FAILED`, `MODEL_FAILED`, `RATE_LIMITED`, `TIMEOUT`, `INVALID_INPUT`, `PERMISSION_DENIED`, `INTERNAL`).
- `OutcomeEvent` first-class telemetry primitive (`resolved` / `handed_off` / `disqualified` / `qualified` / `pending`).
- `OutcomeEmitter` with sink isolation — a broken sink can't kill the telemetry pipeline.
- `CostMeter` with per-model pricing; throws by default on unknown model to surface config typos.
- `PrincipleRegistry` for Constitutional-Principles composition + drift `fingerprint()`.
- Atomic-claim multi-judge verifier (strict pass + permissive re-judge of failures only).
- Index-based permissive merge that survives duplicate-claim strings (fix #10).
- 118 unit tests across 8 suites.
- ARCHITECTURE.md, BENCHMARKS.md, ROADMAP.md.
- CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, issue + PR templates.
- GitHub Actions CI: build / typecheck / lint / test / audit / Trivy / eval-regression.
- Apache-2.0 LICENSE, `.gitattributes`, `.editorconfig`, `.nvmrc`.

### Changed
- `isClaimAboutAllowedUrl` switched from case-insensitive substring match to URL-extraction + hostname normalization. Fixes the lookalike-domain bypass (`notexample.com` ⊁ `example.com`).
- `claimExtractor` list-marker strip narrowed from `/^[\s\-•*\d.)]+/` to recognised markers only (`1.`, `1)`, `(1)`, `-`, `*`, `•`). Bare leading digits in claims are preserved.
- `judge.ts` partial-parse fallback split: when SOME lines parsed, missing indices default to UNSUPPORTED (fail-closed). When ZERO lines parsed, missing default to supported (fail-open on judge total breakage). Stops silently shipping fabrications.
- `PrincipleRegistry.replace()` now runs the same `validate()` as `register()` — empty rules and version < 1 are rejected on replace.
- `CostMeter.record()` now throws on unknown model by default; opt-in `'skip'` policy preserves silent-skip for allowlist mode.
- Removed `composite: true` from base tsconfig + project references. Each package builds with plain `tsc` in pnpm-topological order.
- Removed `.github/dependabot.yml` to enforce a single-branch policy. Dep updates land as explicit commits on main.

### Security
- `SECURITY.md` routes vulnerability reports through GitHub Private Vulnerability Reporting; no mailbox.
- Trivy + pnpm audit run in CI (informational pre-1.0; gates tighten at v1.0).
