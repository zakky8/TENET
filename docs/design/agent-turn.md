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

> **MIGRATION COMPLETE (2026-07-18, increment 1.5):** the canonical-contract rollout in §5 has fully landed
> (1.1 contract + bridges → 1.2 six adapters → 1.3 verifier+quickstart → 1.4 router/streaming/community-bot/
> measure-real/ag-ui → 1.5). §5 step (5) is done: the transitional `fromLegacyModel`/`asLegacyModel` bridges,
> the `LegacySingleStringModel`/`LegacyChatArgs` types, the `ChatMessage` alias, and the anthropic
> `LegacyChatModel` re-export were all **deleted**. Any bridge/`ChatMessage`/`ConversationMessage` name below is
> historical plan-of-record, not a live symbol — `packages/core/src/model.ts` is the source of truth.

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

Nodes are `Step<OrchestratorState, OrchestratorState>`. Terminals are carried in `state.halt`, **not** thrown (this is the resolution of review §6 — no `Terminate` sentinel, no handoff→abstain collapse). `halting` wraps each node so a set `halt` skips the rest of the graph deterministically. The finalizer converts `halt` (or a genuine crash) into the returned `Result`.

> **AS-BUILT (commits `af35acf`→`7e6772e`, verified against the source this revision).** The snippets below
> reflect the SHIPPED API, which diverged from the original sketch in three deliberate ways discovered while
> grounding against the real dependencies: (1) `verifyAndEmit` returns a discriminated **`EmitDecision`**
> (`emit | repair | abstain`), not `Result | null` with a `state.critique` side-effect; (2) the turn depends on
> a **narrow `Verifier` port** (`deps.verify.check`) — there is no `failClosed` verifier-config field (it never
> existed); (3) the answer **repair-retry** rewrites a failed draft via `deps.rewrite` (a `RewriteFn`) and
> re-verifies it through the SAME emit edge up to `deps.maxRepairRounds` — it does NOT use `refine.repairDraft`,
> and a rewritten draft is never trusted (a bad rewrite re-enters verification, so it cannot ship).

### 4.1 Graph topology

```
runAgent(state0, deps, signal)
  │
  ├─(A) injectionGate ───────────── inbound runFilterChain (guardrails/filters.ts:64); throw → handoff too
  │
  ├─(B) retrieveNode ────────────── retriever.query → knowledgeBoundaryGate (refine/index.ts:83)
  │
  ├─(C) cacheNode ───────────────── AnswerCache.lookup (narrow port; sets cachedDraft; NEVER emits)
  │
  ├─(D) criticLoop ──────────────── reason ⇄ (tool via runTools | answer → verifyAndEmit)  [bounded by maxAttempts]
  │        │
  │        └─(D.emit) verifyAndEmit ─ verify → ≥1 grounded citation → outbound leak gate → emit
  │
  └─(F) finalize ────────────────── halt → Result;  else abstain default
```

### 4.2 Node source

```ts
// packages/agent/src/orchestrator.ts
import { runWorkflow, sequential, withTimeout, type Step } from '@tenet/workflow';

/** Guard: once state.halt is set, every downstream node is a no-op. */
export function halting(step: Step<OrchestratorState, OrchestratorState>): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => (s.halt !== undefined ? s : step(s, ctx));
}

/** THE FAIL-CLOSED DEFAULT: a graph that ended without a carried terminal abstains. */
export function finalize(state: OrchestratorState): Result {
  return state.halt ?? abstainResult('graph ended without a terminal');
}

export async function runAgent(
  state0: OrchestratorState,
  deps: AgentDeps,
  signal: AbortSignal,          // per-turn cancellation → runWorkflow → ctx → nodes
): Promise<Result> {
  const graph = sequential(
    halting(withTimeout(injectionGate(deps), deps.timeouts.gate)),
    halting(withTimeout(retrieveNode(deps),  deps.timeouts.retrieve)),
    halting(withTimeout(cacheNode(deps),     deps.timeouts.cache)),
    halting(criticLoop(deps)),               // sets state.halt to its terminal Result
  );
  try {
    const end = await runWorkflow(graph, state0, { runId: state0.event.conversationId, signal });
    return finalize(end);
  } catch (err) {
    // Any WorkflowError (timeout/aborted/retry_exhausted) or thrown node → abstain.
    // Terminals are carried in state.halt, never thrown, so no handoff is lost here.
    return abstainResult(`orchestrator error: ${(err as Error).message}`);
  }
}
```

```ts
// packages/agent/src/nodes.ts
export function injectionGate(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s) => {
    let chain: ReturnType<typeof runFilterChain>;
    try {
      chain = runFilterChain(s.event.text, deps.inboundFilters);           // guardrails/filters.ts:64
    } catch (err) {
      // A guardrail that THROWS cannot clear the input — hand off, never pass it through.
      return { ...s, halt: handoffResult('security', `filter error: ${(err as Error).message}`) };
    }
    return chain.verdict.kind === 'block'
      ? { ...s, halt: handoffResult('security', `blocked by ${chain.filterId}: ${chain.verdict.reason}`) }
      : s;                                                                   // FAIL CLOSED → handoff
  };
}

export function retrieveNode(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => {
    let scored: ReadonlyArray<ScoredResult>;
    try {
      scored = await deps.retriever.query({
        text: s.event.text, k: deps.retrieveK, tenantId: s.event.tenantId, signal: ctx.signal,
      });
    } catch (err) {
      return { ...s, halt: abstainResult(`retrieval error: ${(err as Error).message}`) }; // FAIL CLOSED
    }
    const results = scored ?? [];  // a retriever that resolves null → zero evidence → gate abstains
    // Feed RETRIEVAL RELEVANCE (the producer score), NOT Source.confidence (review §8).
    const gate = knowledgeBoundaryGate(results.map((c) => ({ score: c.score })), deps.boundary);
    if (!gate.proceed) return { ...s, halt: abstainResult(gate.reason) };   // FAIL CLOSED → abstain
    return { ...s, chunks: results.map((c) => ({ source: c.source, relevance: c.score })) };
  };
}

export function cacheNode(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => {
    const hit = await deps.cache.lookup(s.event.text, ctx.signal).catch(() => null); // throw → no hit
    // A cache hit is a CANDIDATE draft only. It is NOT emitted here; it re-enters
    // verification in criticLoop. Resolves the similarity-hit fail-open (review §3).
    return hit ? { ...s, cachedDraft: hit.answer } : s;
  };
}
```

### 4.3 `criticLoop` — the turn driver, and `verifyAndEmit` the single emit edge

`criticLoop` owns the reason/tool loop and consumes `verifyAndEmit`'s `EmitDecision` directly.
`refine.repairDraft` is **not** used; on a `repair` signal criticLoop rewrites the draft via `deps.rewrite`
(a `RewriteFn`) and re-verifies it through the SAME emit edge, up to `deps.maxRepairRounds`, then fails closed
to `abstain`. The rewritten draft is never trusted — it re-enters `verifyAndEmit`, so a bad rewrite cannot ship.

```ts
// packages/agent/src/criticLoop.ts
export function criticLoop(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => {
    // Cache-hit candidate → re-verify through the SAME emit edge. A verified hit resolves;
    // a bad guess (repair/abstain) does NOT abstain the turn — fall through to reasoning.
    if (s.cachedDraft !== undefined) {
      const cached = await verifyAndEmit(s.cachedDraft, s, deps);
      if (cached.kind === 'emit') return { ...s, halt: cached.result };
    }

    let state = s;
    for (let turn = 0; turn < deps.maxAttempts; turn++) {
      if (ctx.signal.aborted) return { ...state, halt: abstainResult('aborted') };   // FAIL CLOSED

      let decision: ReasonerOutput;
      try { decision = await deps.reasoner.reason(state, ctx.signal); }
      catch (err) { return { ...state, halt: abstainResult(`reasoner error: ${(err as Error).message}`) }; } // FAIL CLOSED

      switch (decision.kind) {
        case 'abstain': return { ...state, halt: abstainResult(decision.reason) };
        case 'handoff': return { ...state, halt: handoffResult(decision.handoff.target, decision.handoff.reason) };

        case 'tool': {
          // Governance gates every call BEFORE execution (runTools → PolicyEvaluator.evaluate).
          const run = await runTools(decision.calls, deps.tools, deps.policy,
            { tenantId: state.event.tenantId, principalId: state.event.userId }, ctx.signal);
          if (run.denied) return { ...state, halt: handoffResult('ops', `tool denied: ${run.reason}`) }; // FAIL CLOSED
          state = { ...state, history: appendToolResults(state.history, run.results) };
          continue; // loop back to reason, capped by maxAttempts
        }

        case 'answer': {
          // Verify → (on repair) rewrite from the critique → re-verify, up to maxRepairRounds.
          // The rewritten draft is NOT trusted — it re-enters the SAME emit edge.
          let draft = decision.draft;
          for (let round = 0; round <= deps.maxRepairRounds; round++) {
            if (ctx.signal.aborted) return { ...state, halt: abstainResult('aborted') };
            const emit = await verifyAndEmit(draft, state, deps);           // the ONLY emit edge
            if (emit.kind === 'emit') return { ...state, halt: emit.result };
            if (emit.kind === 'abstain') return { ...state, halt: abstainResult(emit.reason) }; // not repairable
            // emit.kind === 'repair'
            if (round === deps.maxRepairRounds) {
              return { ...state, halt: abstainResult(`unverified after ${deps.maxRepairRounds} repair round(s): ${emit.critique}`) };
            }
            try { draft = await deps.rewrite({ draft, critique: emit.critique, signal: ctx.signal }); }
            catch (err) { return { ...state, halt: abstainResult(`repair failed: ${(err as Error).message}`) }; }
          }
          return { ...state, halt: abstainResult('repair budget exhausted') }; // unreachable; fail closed
        }
      }
    }
    // Exhausted every turn still calling tools without ever drafting an answer → abstain.
    return { ...state, halt: abstainResult(`no answer within ${deps.maxAttempts} attempts`) }; // FAIL CLOSED
  };
}
```

```ts
// packages/agent/src/emit.ts
export type EmitDecision =
  | { readonly kind: 'emit';    readonly result: Result }
  | { readonly kind: 'repair';  readonly critique: string }   // verify failed → caller may retry
  | { readonly kind: 'abstain'; readonly reason: string };    // verifier throw / uncited / leak → fail closed

/** The single emit edge. Depends on a NARROW Verifier PORT (deps.verify.check); the concrete
 *  verifyDraft(model, {...}, { claimPreChecks: defaultPreChecks() }) is adapted behind it at
 *  composition. There is NO `failClosed` verifier-config field — fail-closed is enforced HERE. */
export async function verifyAndEmit(
  draft: string, state: OrchestratorState, deps: AgentDeps,
): Promise<EmitDecision> {
  let verdict: VerifierVerdict;
  try {
    verdict = await deps.verify.check({
      sources: knowledgeBlock(state.chunks),
      sourceRecords: (state.chunks ?? []).map((c) => c.source),
      draft,
    });
  } catch (err) {
    return { kind: 'abstain', reason: `verifier error: ${(err as Error).message}` }; // FAIL CLOSED
  }

  if (!verdict.pass) return { kind: 'repair', critique: verdict.critique };

  // FAIL-CLOSED GUARD: emit only if ≥1 approved citation is genuinely grounded (non-blank
  // sourceId AND quote). Catches the zero-claim pass=true AND a blank custom sourcePicker.
  const grounded = verdict.approvedCitations.some((c) => c.sourceId.trim() !== '' && c.quote.trim() !== '');
  if (!grounded) return { kind: 'abstain', reason: 'verified but no grounded citation' };

  // OUTBOUND system-prompt / constitution leak gate (review §5): a leaked draft never emits.
  const out = runFilterChain(draft, deps.outboundFilters);  // includes systemPromptLeakFilter()
  if (out.verdict.kind === 'block') {
    return { kind: 'abstain', reason: `outbound gate blocked by ${out.filterId}: ${out.verdict.reason}` };
  }

  // (Cache write-through of verified answers is deferred — the AnswerCache port is lookup-only;
  //  a store port + query embedding land with the write-through increment.)
  return { kind: 'emit', result: emitResult(draft, verdict.approvedCitations) };
}
```

### 4.4 Fail-CLOSED inventory — every edge

| # | Edge | Failure condition | Outcome | Grounding |
|---|------|-------------------|---------|-----------|
| A | injection gate | inbound `runFilterChain` → `block` | `handed_off` (security), via `state.halt` | guardrails/filters.ts:64 |
| B | retrieve | `knowledgeBoundaryGate.proceed=false` **or** query throws (timeout) | `disqualified` (abstain) | refine/index.ts:77-82 |
| C | cache | lookup throws | continue (no hit); **hits never emit here** | `AnswerCache` port (`deps.cache`) |
| C→D | cache hit | candidate draft fails verify **or** outbound gate | fall through to reasoning (no emit) | §4.3 |
| D | reasoner | throw / parse-fail / `tool_use`-with-no-tools / refusal / aborted | `disqualified` (abstain) | §3 |
| D | tool | `PolicyEvaluator` deny / approval unmet | `handed_off` (ops) | governance evaluate |
| D | verify | `deps.verify.check` **throws** | `abstain` (`EmitDecision`) — orchestrator never trusts internal fail-open | emit.ts (Verifier port) |
| D | verify | verdict `pass=false` | `EmitDecision:'repair'` → rewrite via `deps.rewrite` + re-verify (≤ `maxRepairRounds`), then `abstain` | criticLoop.ts / emit.ts |
| D.emit | uncited pass | verdict `pass=true` but no citation with non-blank `sourceId`+`quote` (incl. zero-claim) | `abstain` — an uncited answer never ships | emit.ts (grounded-citation guard) |
| D.emit | outbound leak | `runFilterChain(draft, outboundFilters)` → `block` (incl. `systemPromptLeakFilter`) | `abstain` — leaked draft never emits | promptInjection.ts:66 |
| F | top-level | any `WorkflowError` (timeout/aborted/retry_exhausted) or uncaught node throw | `disqualified` (abstain) | orchestrator catch |
| **emit** | reached **only** when verify `pass===true` **and** ≥1 grounded citation **and** outbound gate passes | — | `resolved` | single emit edge |

**Invariant (true against the code):** `NormalizedReply.text` carrying a fact is produced at exactly one call site — `emitResult` inside `verifyAndEmit`, reachable only past a fail-closed verifier, a grounded-citation guard, and an outbound leak gate. Cache hits, tool paths, reasoner ambiguity, and crashes cannot reach it. `criticLoop` never imports `emitResult`, so it cannot mint a `resolved` result itself.

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

## 6. Verifier fail-CLOSED mode (Phase 3.1 — SHIPPED)

> **AS-BUILT status.** `VerifierConfig.failClosed?: boolean` (default `false`, preserving existing callers) now
> ships in `@tenet/verifier`. Two layers of defense now exist: (a) the ORCHESTRATOR's emit edge — `verifyAndEmit`
> (§4.3) wraps `deps.verify.check` in `try/catch` → abstain, requires ≥1 grounded citation, runs the outbound
> leak gate; and (b) the VERIFIER's own `failClosed` mode below, so it never returns a spurious `pass` on infra
> breakage even for consumers that lack the orchestrator's guard. The composition that adapts `verifyDraft`
> behind the agent's `Verifier` port sets `failClosed: true`.

The original invariant ("nothing else can produce a fact") was false because fail-**open** paths let verifier INFRA breakage ship a claim. `failClosed` closes them at the source. When `failClosed === true`:

1. **`claimExtractor.ts`** — on an extractor error/timeout, throws `ClaimExtractionError` (not `[]`); `verifyDraft` catches it → `pass:false`. A slow/broken extractor can no longer masquerade as zero claims → auto-pass.
2. **`judge.ts`** — a judge error/timeout OR a total-garbage (no-parse) response marks the affected claims `supported:false` (was the fail-OPEN "all supported"). A judge we could not run cannot clear a claim; the permissive re-judge runs the same broken model, so it stays `supported:false` → `pass:false`.

> **DELIBERATE DEVIATION from the original proposal (point 2, "zero claims → pass:false"):** a GENUINELY
> claim-free draft (greeting/filler; extractor returns `NONE`/empty, no error) still returns `pass:true`. It is
> vacuously grounded — there is nothing to fabricate — and whether to EMIT a citation-free reply is emit policy,
> which belongs to the orchestrator (its grounded-citation guard abstains on it), NOT to the verifier's grounding
> check. Conflating the two would make the verifier reject legitimate greetings. The extractor-ERROR case (which
> point 1 handles by throwing) is what must fail closed — not a legitimate empty.

**Consequence, stated plainly:** with `failClosed:true` and no real judge/extractor model, the runtime abstains on any non-deterministic claim, emitting only what the deterministic tier (quote-grounding / numeric) supports. The system stays silent rather than fabricating.

**Still Phase 3 (NOT in 3.1):** the non-numeric claim tier (3.2 — named-entity coverage + negation/scope guard), spelled-out-number fabrication + `max_tokens` truncation→abstain + `maxClaims`-drop→abstain (3.3).

---

## 7. Open questions for the owner

1. **Native tool_use rollout.** This PR lands native `tool_use` for `models/anthropic` only; the other five adapters stay text-only until a follow-up. Confirm that is acceptable, or name which additional providers must be tool-capable at first ship.
2. **Retrieval relevance source (blocks §5.7).** `knowledgeBoundaryGate` now requires a real relevance score. Does the community-bot retriever backend already expose a cosine/BM25/rerank score we can surface into `RetrievedChunk.relevance`, or must we add a reranking step? The gate is decorative without a true relevance signal — we need the owner to point at the score or approve adding a reranker. **Proposed default floors pending an answer:** `minTopScore=0.5, minTotalScore=1.0, minHits=1` (fail-closed until calibrated).
3. **Cache hit policy.** The design re-verifies every cache hit against current sources before emit (safe, but adds one verify round-trip per hit). Acceptable, or should we instead store a source-snapshot fingerprint and serve a hit only when the fingerprint matches current retrieval (cheaper, but colder cache)?
4. **Outbound leak block → abstain vs. handoff.** A blocked outbound draft currently resolves to `disqualified` (abstain). Confirm abstain, or should suspected system-prompt leakage escalate to a security handoff for audit?
5. **Numeric knobs.** `maxAttempts`, per-node timeouts (`gate`/`retrieve`/`cache`), and `maxTokens` are left as `AgentDeps` config with no baked defaults. Owner to set the initial values (proposed starting point: `maxAttempts=2`, gate `1s`, retrieve `5s`, cache `500ms`).
6. **`stop_sequence` semantics.** We preserve `stop_sequence` distinct from `end_turn`. If no downstream logic actually branches on stop-sequence-driven control, confirm we may treat them identically in the orchestrator (the type stays lossless regardless).