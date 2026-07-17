<!--
Provenance: synthesized 2026-07-17 by a two-Opus architecture discussion (propose -> adversarial critique ->
synthesis), workflow wf_6eec60c6-b26. TENET upgrade increment 0.2 — the design gate for Phases 1-3.

Verified against LIVE CODE before commit (per the trust-code-not-claims rule):
  [ok] packages/core/package.json has NO "dependencies" — the contract can live in @tenet/core, no cycle.
  [ok] packages/core/src/types.ts:51  Role = 'user'|'assistant'|'system'|'tool'  (used by ConversationMessage).
  [ok] packages/harness/src/index.ts:10-11  "nothing here calls a model directly" — justifies the @tenet/agent split.
  [ok] four separate model interfaces exist: verifier/types.ts:90, router/types.ts:17, streaming/index.ts:29, community-bot/index.ts:29.
  [ok] packages/verifier/src/verifier.ts  zero-claims -> { pass: true } — the fail-OPEN this design closes in section 6.
  [ok] apps/community-bot/src/index.ts:115  `${m.role}: ${m.content}` flatten — the real 'assistant:' turn-spoof vector.
  [FIXED] adapters live at  models/<provider>  (repo root), NOT packages/models/ (6 refs corrected).
  [FIXED] community-bot lives at  apps/community-bot , NOT packages/community-bot (1 refs corrected).

Implementers: re-verify each cited line before editing — this doc does not re-fetch.
-->

# TENET Design Gate: Canonical `ChatModel` + Verification-First Orchestrator

> **CORRECTION (2026-07-17, after increment 1.1 was executed):** the canonical **wire** message is named
> **`ModelMessage`**, NOT `ConversationMessage`. Executing `tsc` at 1.1 surfaced a `TS2308` collision the
> design missed: `packages/core/src/types.ts:53` ALREADY defines `ConversationMessage { content: string }` —
> the distinct **stored/history** message used by `AgentState.history` (`types.ts:164`) and `@tenet/memory`,
> which is left untouched. **Wherever this document writes `ConversationMessage` for the array-of-`ContentBlock`
> wire message (§2, §2.1, §3, §5.2, and the community-bot migration instruction in §5), read `ModelMessage`.**
> Where it writes `ConversationMessage` for `AgentState.history` / the stored `content: string` type (e.g. the
> reasoner map `history.map((m) => textMessage(m.role, m.content))`), it is correct as written. The shipped
> `packages/core/src/model.ts` JSDoc is the source of truth for this distinction.

**Status:** APPROVED FOR IMPLEMENTATION — this document is the design gate. Fable agents implement against it without re-deciding. Every blocking finding from adversarial review is resolved below; where a decision was made, the rationale is stated so it is not re-litigated in the implementation phase.

**Grounding note:** All line/file references are to the current TENET source as cited in the proposal and critique. This doc does not re-fetch; implementers MUST verify each cited line before editing, per the source-hierarchy rule.

---

## 1. Decision: new `@tenet/agent`, NOT extend `@tenet/harness`

**Decision: create a new package `packages/agent`. The orchestrator does not live in `@tenet/harness`.**

Rationale (all three points survived adversarial review as "the strongest section"):

1. **Harness's own invariant forbids it.** `harness/src/index.ts:11-12,32` advertises *"nothing here calls a model directly."* The orchestrator's entire job is to drive the Reasoner model. Placing it in harness violates the one sentence harness makes about itself.
2. **Dependency direction.** A composition root must be the *most-dependent* package. The orchestrator composes `@tenet/verifier`, `@tenet/refine`, `@tenet/workflow`, `@tenet/guardrails`, `@tenet/governance`, `@tenet/router`, `@tenet/core`, and `@tenet/harness`. `harness/package.json` has zero dependencies today; making it depend on verifier/refine/workflow inverts the layering (harness is a low-level primitive lib: `TodoLedger`, `spawnSubagents`, `ContextCompactor`, `Handoff`). Inversion is not allowed.
3. **`@tenet/agent` consumes harness as a primitive** — `Handoff`/`isHandoff` (`harness:264-276`), `ContextCompactor` for the retrieve→reason context budget, `TodoLedger` for multi-step tool work, `spawnSubagents` for fan-out. That is the intended direction.

```
packages/agent/                (NEW)
  package.json   deps: @tenet/core, @tenet/workflow, @tenet/harness, @tenet/verifier,
                       @tenet/refine, @tenet/guardrails, @tenet/governance, @tenet/router, @tenet/policy
  src/
    index.ts
    types.ts        OrchestratorState, ReasonerOutput, Reasoner, AgentDeps, Result
    reasoner.ts     modelReasoner(model, tools)  ← the ONLY model-driver in the package
    nodes.ts        injectionGate, retrieveNode, cacheNode, criticLoop, outboundGate, terminal builders
    orchestrator.ts runAgent()
```

---

## 2. The canonical contract — `packages/core/src/model.ts`

**Placement decision:** the contract lives in `@tenet/core`. `core/package.json` has no `dependencies` (verified) — it is a true leaf, so every consumer imports *down* the graph. No cycle. `StreamChunk` moves here from `streaming/src/index.ts` so streaming and non-streaming share one block vocabulary.

**Naming decision:** the canonical per-turn message type is named **`ConversationMessage`**. It supersedes the local `ConversationMessage` in `community-bot` and the four duplicated single-string contracts. (`ChatMessage` is exported as a deprecated type alias for one release to ease the community-bot migration, then deleted.)

### 2.1 Full source of `model.ts`

```ts
// packages/core/src/model.ts
import type { Role, Citation } from './types.js';   // Role = 'user'|'assistant'|'system'|'tool' (existing)

/** A tool the model may call. Provider-agnostic; JSON-Schema described. */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema (draft 2020-12) for the arguments object. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** One content block of a turn. Discriminated on `type`. Single vocabulary
 *  shared by non-streaming content and (via StreamChunk) the streaming path. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string;
      readonly input: Readonly<Record<string, unknown>> }
  | { readonly type: 'tool_result'; readonly toolUseId: string;
      readonly content: string; readonly isError?: boolean };

/** THE canonical message. An ARRAY of blocks — this kills the `${role}: ${content}`
 *  flattening in community-bot:113-118 (the `assistant:` turn-spoof) AND the
 *  array/string schism vs harness HarnessMessage. Turn boundaries are structural. */
export interface ConversationMessage {
  readonly role: Role;
  readonly content: ReadonlyArray<ContentBlock>;
}

/** @deprecated transitional alias; remove after community-bot migrates. */
export type ChatMessage = ConversationMessage;

/** Lossless with every adapter's provider stop reasons. `end_turn` and
 *  `stop_sequence` are DISTINCT (Anthropic emits both) — no collapse to 'stop'. */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'refusal'
  | 'aborted';

export interface ChatRequest {
  /** System prompt is a first-class field (matches all 4 legacy `system` fields),
   *  never smuggled into messages. */
  readonly system: string;
  readonly messages: ReadonlyArray<ConversationMessage>;
  readonly maxTokens: number;
  /** Tools offered THIS turn. Omit or [] disables tool use. */
  readonly tools?: ReadonlyArray<ToolDef>;
  /** REQUIRED. The zombie-HTTP kill switch is enforced by the type system,
   *  not JSDoc (supersedes verifier/types.ts:96-99). */
  readonly signal: AbortSignal;
  readonly temperature?: number;
}

export interface ChatResponse {
  /** text + any tool_use requests, together — answers "no contract returns
   *  {action,draft} together". */
  readonly content: ReadonlyArray<ContentBlock>;
  readonly stopReason: StopReason;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

/** THE contract. Every package imports this one. */
export interface ChatModel {
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/** StreamChunk moved here from streaming/index.ts so streaming and
 *  non-streaming share the block vocabulary. */
export type StreamChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use_start'; id: string; name: string }
  | { kind: 'tool_use_delta'; id: string; partial: string }
  | { kind: 'tool_use_end'; id: string }
  | { kind: 'message_stop'; stopReason: StopReason }
  | { kind: 'usage'; inputTokens: number; outputTokens: number };

/** Streaming is an OPTIONAL capability over the SAME request shape. */
export interface StreamingChatModel extends ChatModel {
  chatStream(req: ChatRequest): AsyncIterable<StreamChunk>;
}

// ── Helpers ──────────────────────────────────────────────────────────────
export function textMessage(role: Role, text: string): ConversationMessage {
  return { role, content: [{ type: 'text', text }] };
}

export function responseText(res: ChatResponse): string {
  return res.content.reduce((s, b) => (b.type === 'text' ? s + b.text : s), '');
}

export function toolUses(
  res: ChatResponse,
): ReadonlyArray<Extract<ContentBlock, { type: 'tool_use' }>> {
  return res.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );
}

// ── Migration bridges (DELETED once every adapter is canonical) ────────────
export interface LegacyChatArgs { system: string; user: string; maxTokens: number; signal?: AbortSignal; }
export interface LegacySingleStringModel { chat(args: LegacyChatArgs): Promise<string>; }

/** Adapt a legacy string model to canonical. Tools unsupported → single text
 *  block, stopReason 'end_turn'. */
export function fromLegacyModel(legacy: LegacySingleStringModel): ChatModel {
  return {
    async chat(req) {
      const user = req.messages
        .flatMap((m) => m.content)
        .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : ''))
        .join('\n'); // boundary flatten ONCE; internal code never flattens again
      const text = await legacy.chat({
        system: req.system, user, maxTokens: req.maxTokens, signal: req.signal,
      });
      return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
    },
  };
}

/** Adapt canonical → legacy so un-migrated call sites keep compiling. */
export function asLegacyModel(model: ChatModel): LegacySingleStringModel {
  return {
    async chat(args) {
      const res = await model.chat({
        system: args.system,
        messages: [textMessage('user', args.user)],
        maxTokens: args.maxTokens,
        signal: args.signal ?? new AbortController().signal,
      });
      return responseText(res);
    },
  };
}
```

### 2.2 Corrected claims (adversarial review §11)

- **Required `signal` removes the spread dance only for `signal`.** Under `exactOptionalPropertyTypes`, `tools?`, `temperature?`, and `usage?` still require `...(cond ? {x} : {})`. Required `signal` deletes the signal-spread at the two *model-call* sites `adaptiveRouter.ts:75,:96` **only**. `adaptiveRouter.ts:58` is a `RouteClassifier.classify` call whose `signal` stays optional — it does **not** delete. Do not claim otherwise.
- **StopReason is lossless**, not narrowed. Every adapter maps provider reasons per §5.4; `stop_sequence` is preserved distinct from `end_turn`.

---

## 3. Reasoner discriminated result type — `packages/agent/src/types.ts`

```ts
// packages/agent/src/types.ts
import type { AgentState, Citation, NormalizedReply, Outcome, Source, ChatResponse } from '@tenet/core';
import type { Handoff } from '@tenet/harness';

/** ONE model turn returns exactly one of these. Discriminated on `kind`.
 *  There is NO default `answer`: any ambiguity resolves to `abstain`. */
export type ReasonerOutput =
  | { readonly kind: 'answer';  readonly draft: string; readonly citations: ReadonlyArray<Citation> }
  | { readonly kind: 'tool';    readonly calls: ReadonlyArray<ToolCall> }
  | { readonly kind: 'handoff'; readonly handoff: Handoff }
  | { readonly kind: 'abstain'; readonly reason: string };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface Reasoner {
  /** signal REQUIRED — inherited from the canonical contract. */
  reason(state: OrchestratorState, signal: AbortSignal): Promise<ReasonerOutput>;
}

/** A retrieved chunk carries retrieval RELEVANCE, distinct from Source.confidence
 *  (which is a correctness prior, core/types.ts:80). Resolves review §8. */
export interface RetrievedChunk {
  readonly source: Source;
  /** Retrieval relevance (cosine / BM25 / rerank), normalized 0..1. */
  readonly relevance: number;
}

/** OrchestratorState is the ONLY state type (no core→agent cycle; review §12).
 *  It IS an AgentState, extended with transient orchestration carriers plus an
 *  explicit terminal channel (resolves the Terminate collapse, review §6). */
export interface OrchestratorState extends AgentState {
  readonly chunks?: ReadonlyArray<RetrievedChunk>;
  readonly cachedDraft?: string;
  readonly toolResults?: ReadonlyArray<{ toolUseId: string; content: string; isError: boolean }>;
  /** When set, the graph is short-circuiting. Nodes downstream pass through
   *  untouched; the finalizer converts it to the returned Result. */
  readonly halt?: Result;
}

export type Result = { readonly reply: NormalizedReply; readonly outcome: Outcome };
```

`modelReasoner` maps a canonical `ChatResponse` → `ReasonerOutput`, **fail-closed on every ambiguity**:

```ts
// packages/agent/src/reasoner.ts
import { type ChatModel, type ToolDef, textMessage, responseText, toolUses } from '@tenet/core';

export function modelReasoner(model: ChatModel, tools: ReadonlyArray<ToolDef>): Reasoner {
  return {
    async reason(state, signal) {
      const res = await model.chat({
        system: buildSystem(state),                          // principles + KNOWLEDGE block from state.chunks
        messages: state.history.map((m) => textMessage(m.role, m.content)), // structured, no flatten
        maxTokens: 1024,
        ...(tools.length > 0 ? { tools } : {}),
        signal,
      });

      if (res.stopReason === 'tool_use') {
        const calls = toolUses(res).map((t) => ({ id: t.id, name: t.name, input: t.input }));
        return calls.length > 0
          ? { kind: 'tool', calls }
          : { kind: 'abstain', reason: 'tool_use stop with no tool blocks' }; // FAIL CLOSED
      }
      if (res.stopReason === 'refusal' || res.stopReason === 'aborted')
        return { kind: 'abstain', reason: `model ${res.stopReason}` };        // FAIL CLOSED

      // Text path: strict JSON envelope. Any parse failure / unknown action /
      // missing field → abstain. NEVER default to `answer`.
      return parseEnvelope(responseText(res));
    },
  };
}
```

`parseEnvelope` returns `{kind:'abstain'}` on any `JSON.parse` failure, unknown `action`, or missing field.

**Tool-branch liveness (resolves review §2):** the `tool` branch is *not* dead code. In this PR the **native `models/anthropic` adapter emits real `tool_use` / `stopReason` = `'tool_use'`** (§5.3). When a tool-capable model is wired into `modelReasoner`, the branch, the governance gate, `TodoLedger`, and `spawnSubagents` are all reachable. The five other adapters remain text-only (they never emit `tool_use`) until natively upgraded in a follow-up — the branch is simply inert for those models, not dead in the build.

---

## 4. The orchestrator as a labeled state graph

Nodes are `Step<OrchestratorState, OrchestratorState>`. Terminals are carried in `state.halt`, **not** thrown (this is the resolution of review §6 — no `Terminate` sentinel, no handoff→abstain collapse). Every node begins with a pass-through guard so a set `halt` skips the rest of the graph deterministically. The finalizer converts `halt` (or a genuine crash) into the returned `Result`.

### 4.1 Graph topology

```
runAgent(state0, deps)
  │
  ├─(A) injectionGate ───────────── inbound runFilterChain (guardrails/filters.ts:64)
  │
  ├─(B) retrieveNode ────────────── retriever.query → knowledgeBoundaryGate (refine:83)
  │
  ├─(C) cacheNode ───────────────── SemanticAnswerCache.lookup  (sets cachedDraft; NEVER emits)
  │
  ├─(D) criticLoop ──────────────── reason ⇄ (tool | verify → repair)   [bounded by maxAttempts]
  │        │
  │        └─(D.emit) outboundGate ─ systemPromptLeakFilter on final draft (guardrails/promptInjection.ts:50)
  │
  └─(F) finalize ────────────────── halt → Result;  else abstain default
```

### 4.2 Node source

```ts
// packages/agent/src/orchestrator.ts
import { sequential, runWorkflow, type Step } from '@tenet/workflow';

/** Guard: once halt is set, every downstream node is a no-op. */
function halting(step: Step<OrchestratorState, OrchestratorState>): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => (s.halt ? s : step(s, ctx));
}

export async function runAgent(state0: OrchestratorState, deps: AgentDeps): Promise<Result> {
  const graph = sequential<OrchestratorState, OrchestratorState>(
    halting(withTimeout(injectionGate(deps), deps.timeouts.gate)),
    halting(withTimeout(retrieveNode(deps),  deps.timeouts.retrieve)),
    halting(withTimeout(cacheNode(deps),     deps.timeouts.cache)),
    halting(criticLoop(deps)),               // sets state.halt to its terminal Result
  );
  try {
    const end = await runWorkflow(graph, state0, {
      runId: state0.event.conversationId,
      signal: deps.signal,
    });
    return end.halt ?? abstainResult('graph ended without terminal'); // FAIL CLOSED default
  } catch (err) {
    // Any WorkflowError (timeout/aborted/retry_exhausted) or thrown node → abstain.
    // Terminals are carried in state.halt, never thrown, so no handoff is lost here.
    return abstainResult(`orchestrator error: ${(err as Error).message}`);
  }
}
```

```ts
// packages/agent/src/nodes.ts
function injectionGate(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s) => {
    const chain = runFilterChain(s.event.text, deps.inboundFilters);        // guardrails/filters.ts:64
    return chain.verdict.kind === 'block'
      ? { ...s, halt: handoffResult('security', `blocked: ${chain.filterId}`) } // FAIL CLOSED → handoff
      : s;
  };
}

function retrieveNode(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s) => {
    const chunks = await deps.retriever.query({ text: s.event.text, tenantId: s.event.tenantId });
    // Feed RETRIEVAL RELEVANCE, not Source.confidence (review §8). Floors are non-zero.
    const gate = knowledgeBoundaryGate(chunks.map((c) => ({ score: c.relevance })), deps.boundary);
    if (!gate.proceed) return { ...s, halt: abstainResult(gate.reason) };   // FAIL CLOSED → abstain
    return { ...s, chunks };
  };
}

function cacheNode(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s) => {
    const hit = await deps.cache.lookup(s.event.text).catch(() => null);    // throw → no hit, continue
    // A cache hit is a CANDIDATE draft only. It is NOT emitted here; it re-enters
    // verification in criticLoop. Resolves the similarity-hit fail-open (review §3).
    return hit ? { ...s, cachedDraft: hit.answer } : s;
  };
}
```

### 4.3 `criticLoop` — the single emit edge, with cache re-verification, repair, and outbound gate

```ts
function criticLoop(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => {
    let state = s;

    // Cache hits flow through verification, never around it.
    if (state.cachedDraft !== undefined) {
      const emitted = await verifyAndEmit(state.cachedDraft, [], state, deps, ctx);
      if (emitted) return { ...state, halt: emitted };   // verified cache hit → resolved
      // cache miss on verification: fall through to normal reasoning
    }

    for (let turn = 0; turn <= deps.maxAttempts; turn++) {
      if (ctx.signal.aborted) return { ...state, halt: abstainResult('aborted') };   // FAIL CLOSED

      let decision: ReasonerOutput;
      try { decision = await deps.reasoner.reason(state, ctx.signal); }
      catch (e) { return { ...state, halt: abstainResult(`reasoner error: ${msg(e)}`) }; } // FAIL CLOSED

      switch (decision.kind) {
        case 'abstain': return { ...state, halt: abstainResult(decision.reason) };
        case 'handoff': return { ...state, halt: handoffResult(decision.handoff.target, decision.handoff.reason) };

        case 'tool': {
          // Governance gate BEFORE execution (governance PolicyEvaluator.evaluate).
          const r = await runTools(decision.calls, deps.policy, deps.tools, ctx.signal);
          if (r.denied) return { ...state, halt: handoffResult('ops', `tool denied: ${r.reason}`) }; // FAIL CLOSED
          state = { ...state,
            toolResults: [...(state.toolResults ?? []), ...r.blocks],
            history: appendToolResults(state.history, r.blocks) };
          continue; // loop back to reason, capped by maxAttempts
        }

        case 'answer': {
          const emitted = await verifyAndEmit(decision.draft, decision.citations, state, deps, ctx);
          if (emitted) return { ...state, halt: emitted };                  // ONLY emit edge
          if (turn < deps.maxAttempts) {
            // Repair ONLY unsupported claims via refine.repairDraft, then re-verify.
            const repaired = await repairDraft(decision.draft, state.critique, deps.repair) // refine:139
              .catch(() => null);
            if (repaired === null) return { ...state, halt: abstainResult('repair failed') }; // FAIL CLOSED
            state = { ...state, draft: repaired, attempts: turn + 1 };
            continue;
          }
          return { ...state, halt: abstainResult(`unverified after ${deps.maxAttempts} attempts`) }; // FAIL CLOSED
        }
      }
    }
    return { ...state, halt: abstainResult('attempts exhausted') };         // FAIL CLOSED default
  };
}

/** Verify (fail-CLOSED verifier config) then run the OUTBOUND leak gate.
 *  Returns a `resolved` Result only if BOTH pass. */
async function verifyAndEmit(
  draft: string, citations: ReadonlyArray<Citation>,
  state: OrchestratorState, deps: AgentDeps, ctx: WorkflowCtx,
): Promise<Result | null> {
  let verify: VerifyResult;
  try {
    verify = await verifyDraft(deps.model, {
      sources: knowledgeBlock(state.chunks),
      sourceRecords: (state.chunks ?? []).map((c) => c.source),
      draft,
    }, {
      claimPreChecks: defaultPreChecks(),   // deterministic numeric/quote tier
      failClosed: true,                     // §6 — extractor+judge+zero-claim all fail CLOSED
    });
  } catch { return null; }                  // verifier THROW → treat as fail (FAIL CLOSED)

  if (!verify.pass) { /* caller records critique for repair */ (state as any).critique = verify.critique; return null; }

  // OUTBOUND system-prompt / constitution leak gate (review §5).
  const out = runFilterChain(draft, deps.outboundFilters);  // includes systemPromptLeakFilter()
  if (out.verdict.kind === 'block') return null;            // FAIL CLOSED: leaked draft never emits

  // Write-through: only VERIFIED answers enter the cache, so future hits are safe.
  await deps.cache.store(state.event.text, draft).catch(() => {});
  return emitResult(draft, verify.approvedCitations);
}
```

### 4.4 Fail-CLOSED inventory — every edge

| # | Edge | Failure condition | Outcome | Grounding |
|---|------|-------------------|---------|-----------|
| A | injection gate | inbound `runFilterChain` → `block` | `handed_off` (security), via `state.halt` | guardrails/filters.ts:64 |
| B | retrieve | `knowledgeBoundaryGate.proceed=false` **or** query throws (timeout) | `disqualified` (abstain) | refine/index.ts:77-82 |
| C | cache | lookup throws | continue (no hit); **hits never emit here** | router SemanticAnswerCache |
| C→D | cache hit | candidate draft fails verify **or** outbound gate | fall through to reasoning (no emit) | §4.3 |
| D | reasoner | throw / parse-fail / `tool_use`-with-no-tools / refusal / aborted | `disqualified` (abstain) | §3 |
| D | tool | `PolicyEvaluator` deny / approval unmet | `handed_off` (ops) | governance evaluate |
| D | verify | `verifyDraft` **throws** | `disqualified` (abstain) — orchestrator never trusts internal fail-open | verifier.ts:30 |
| D | verify | `failClosed` verifier returns `pass=false` (incl. zero-claim, judge/extractor throw) | repair→re-verify; abstain after `maxAttempts` | §6 |
| D.emit | outbound leak | `systemPromptLeakFilter` → `block` | `disqualified` (abstain) — leaked draft never emits | promptInjection.ts:50-67 |
| F | top-level | any `WorkflowError` (timeout/aborted/retry_exhausted) or crash | `disqualified` (abstain) | orchestrator catch |
| **emit** | reached **only** when verify `pass===true` **and** outbound gate passes | — | `resolved` | single emit edge |

**Invariant (now true against the code):** `NormalizedReply.text` carrying a fact is produced at exactly one call site — `emitResult` inside `verifyAndEmit`, reachable only past a fail-closed verifier and an outbound leak gate. Cache hits, tool paths, reasoner ambiguity, and crashes cannot reach it.

---

## 5. Migration plan (concrete files)

The two bridges (`fromLegacyModel` / `asLegacyModel`) let each package flip independently; the tree never has a broken intermediate state. Rollout order: **(1)** land `core/model.ts` + bridges → **(2)** migrate the six `models/*` adapters (they are the only producers of `stopReason`/`tool_use`) → **(3)** flip verifier + quickstart together (coupled via `verifyDraft`) → **(4)** flip router (+ `speculative.ts`), streaming, community-bot, measure-real, ag-ui in any order → **(5)** delete the two bridges.

### 5.1 New files
- `packages/core/src/model.ts` — the contract (§2.1).
- `packages/agent/package.json`, `packages/agent/src/{index,types,reasoner,nodes,orchestrator}.ts` (§1, §3, §4).

### 5.2 The 4 duplicated ChatModel interfaces

| File | Change |
|---|---|
| `packages/core/src/index.ts` | add `export * from './model.js';` |
| `packages/verifier/src/types.ts:89-106` | **delete** local `ChatModel`; `export type { ChatModel } from '@tenet/core';`. Add `VerifierConfig.failClosed?: boolean` (§6). |
| `packages/router/src/types.ts:16-24` | **delete** `RouterChatModel`; `export type { ChatModel as RouterChatModel } from '@tenet/core';` (keeps external name). |
| `packages/streaming/src/index.ts:21-36` | **delete** local `StreamChunk` + `ChatModelStreaming`; `export type { StreamChunk, StreamingChatModel } from '@tenet/core';`. Keep `parseSseStream`, `jsonStreamParser`, `streamToString`, `measureTtft` operating on core `StreamChunk`; `chatStream` args become `ChatRequest`. |
| `apps/community-bot/src/index.ts:29-36,101-175` | **delete** `BotChatModel` **and** the local `ConversationMessage`; use canonical `ChatModel` + `ConversationMessage`. **Remove** the `${role}: ${content}` flatten at `:113-118` — map stored history via `textMessage(m.role, m.content)`; turn boundaries become structural (the `assistant:` spoof is gone). |

### 5.3 The six model adapters (were entirely absent from the original plan — review §1, blocking)

| File | Change |
|---|---|
| `models/anthropic/src/index.ts:30-38` | delete local `ChatModel`; `implements ChatModel` from core. **Native `tool_use` + `stopReason`** mapping (this adapter makes the tool branch live). Build the request body from `req.messages` blocks; emit `ContentBlock[]` incl. `tool_use`. |
| `models/bedrock/src/index.ts` | canonical; map provider stop reasons per §5.4; text-only (no native `tool_use` this PR). |
| `models/google/src/index.ts` | same as bedrock. |
| `models/mistral/src/index.ts` | same. |
| `models/ollama/src/index.ts` | same. |
| `models/openai/src/index.ts` | same. |

### 5.4 StopReason mapping per adapter (lossless — review §10)

| Provider raw | Canonical `StopReason` |
|---|---|
| Anthropic `end_turn` | `end_turn` |
| Anthropic `max_tokens` | `max_tokens` |
| Anthropic `stop_sequence` | `stop_sequence` (NOT collapsed) |
| Anthropic `tool_use` | `tool_use` |
| Anthropic `refusal` | `refusal` |
| OpenAI `stop` / `length` / `tool_calls` | `end_turn` / `max_tokens` / `tool_use` |
| Google `STOP` / `MAX_TOKENS` / `SAFETY` | `end_turn` / `max_tokens` / `refusal` |
| any client `AbortError` | `aborted` |

Each adapter unit test asserts the mapping table above.

### 5.5 Router internals + the silent breaker

| File | Change |
|---|---|
| `packages/router/src/adaptiveRouter.ts:47-99` | canonical; build `messages:[textMessage('user', args.user)]`; pass required `req.signal`; **delete** signal-spreads at `:75,:96` (leave `:58` classifier spread — its `signal` stays optional). Read via `responseText`. |
| `packages/router/src/speculative.ts:50` | `Parameters<RouterChatModel['chat']>[0]` literal `{system,user,maxTokens}` now fails (it is `ChatRequest`). Rewrite to `{ system, messages:[textMessage('user',user)], maxTokens, signal }`. (review §9 — was unlisted.) |

### 5.6 The 2 apps + ag-ui

| File | Change |
|---|---|
| `apps/quickstart/src/index.ts:66-80,126-141` | `StubChatModel implements ChatModel`; `chat(req: ChatRequest): Promise<ChatResponse>`. Route on `req.system`, read `req.messages`, return `{content:[{type:'text',text}], stopReason:'end_turn'}`. `verifyDraft` call unchanged. |
| `apps/measure-real/src/runner.ts:90` + `apps/measure-real/examples/anthropic-sonnet.ts` | build `ChatRequest` (messages+signal), read `responseText`. (review §1 — was unlisted.) |
| `packages/ag-ui` | update the StreamChunk bridge to the core `StreamChunk` union (new `end_turn`/`stop_sequence` members). (review §1 — was unlisted.) |

### 5.7 Verifier / refine / retriever changes (see §6)
- `packages/verifier/src/{verifier.ts:38-40, judge.ts:113-116, claimExtractor.ts:38}` — honor `failClosed`.
- `packages/refine/src/index.ts:139` (`repairDraft`) — first real consumer, called in `criticLoop`.
- `packages/refine/src/index.ts:77-82` (`knowledgeBoundaryGate`) — fed `RetrievedChunk.relevance`, non-zero floors.
- Community-bot retriever / `BotRetriever.query` + `Source` — return `RetrievedChunk[]` carrying `relevance` (see §7 open question 2 for the score source).

---

## 6. Verifier fail-CLOSED changes (blocking — review §3, §4)

The proposal's original invariant ("nothing else can produce a fact") was false because two fail-**open** paths bypass the verifier without throwing. This PR closes them; this is *in scope*, not follow-up.

Add `VerifierConfig.failClosed?: boolean` (default `false` to preserve existing callers; the orchestrator sets `true`). When `failClosed === true`:

1. **`claimExtractor.ts:38`** — on throw, do **not** return `[]`. Propagate a typed `ExtractorError` (verifier converts to `pass:false`). A slow/broken extractor can no longer yield zero claims → auto-pass.
2. **`verifier.ts:38-40`** — zero extracted claims returns `pass:false` (was `pass:true`). No claims ⇒ nothing verified ⇒ cannot emit.
3. **`judge.ts:113-116`** — on judge throw, return `supported:false` for the affected claims (was all-supported).

The orchestrator additionally wraps `verifyDraft` in `try/catch` → abstain (§4.3), so a *thrown* verifier and a *fail-closed* verifier both resolve to non-emit.

**Consequence, stated plainly:** because no real judge/extractor model ships today, `failClosed:true` means the default runtime state abstains on any non-deterministic claim, emitting only what the deterministic tier (quote-grounding / numeric) can support. This is the intended north-star behavior: the system stays silent rather than fabricating.

---

## 7. Open questions for the owner

1. **Native tool_use rollout.** This PR lands native `tool_use` for `models/anthropic` only; the other five adapters stay text-only until a follow-up. Confirm that is acceptable, or name which additional providers must be tool-capable at first ship.
2. **Retrieval relevance source (blocks §5.7).** `knowledgeBoundaryGate` now requires a real relevance score. Does the community-bot retriever backend already expose a cosine/BM25/rerank score we can surface into `RetrievedChunk.relevance`, or must we add a reranking step? The gate is decorative without a true relevance signal — we need the owner to point at the score or approve adding a reranker. **Proposed default floors pending an answer:** `minTopScore=0.5, minTotalScore=1.0, minHits=1` (fail-closed until calibrated).
3. **Cache hit policy.** The design re-verifies every cache hit against current sources before emit (safe, but adds one verify round-trip per hit). Acceptable, or should we instead store a source-snapshot fingerprint and serve a hit only when the fingerprint matches current retrieval (cheaper, but colder cache)?
4. **Outbound leak block → abstain vs. handoff.** A blocked outbound draft currently resolves to `disqualified` (abstain). Confirm abstain, or should suspected system-prompt leakage escalate to a security handoff for audit?
5. **Numeric knobs.** `maxAttempts`, per-node timeouts (`gate`/`retrieve`/`cache`), and `maxTokens` are left as `AgentDeps` config with no baked defaults. Owner to set the initial values (proposed starting point: `maxAttempts=2`, gate `1s`, retrieve `5s`, cache `500ms`).
6. **`stop_sequence` semantics.** We preserve `stop_sequence` distinct from `end_turn`. If no downstream logic actually branches on stop-sequence-driven control, confirm we may treat them identically in the orchestrator (the type stays lossless regardless).