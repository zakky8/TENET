/**
 * criticLoop — the turn driver (design gate §4.3), a `Step<OrchestratorState>`.
 *
 * It composes the already-built, already-tested pieces into the reasoning loop:
 *   - a cache-hit candidate is re-verified through the SAME emit edge, never around it;
 *   - each turn the reasoner decides: abstain | handoff | tool | answer;
 *   - a tool decision runs through governance (runTools) and its results fold back into
 *     history for the next pass; a denied tool → ops handoff (FAIL CLOSED);
 *   - an answer decision goes through verifyAndEmit — the ONLY emit edge.
 *
 * Fail-CLOSED at every edge: an aborted signal, a reasoner throw, a denied tool, a
 * verify failure, or running out of turns all resolve to abstain/handoff — never a
 * shipped unverified answer.
 *
 * Scope (2.1b-iii-b-ii-1): a verify FAILURE ('repair') fail-closes to abstain here. The
 * rewrite-and-retry loop is a capability enhancement on this safe floor and lands in a
 * follow-up increment (it needs a RewriteFn dep); until then, unverifiable = abstain.
 */
import type { Step } from '@tenet/workflow';
import type { OrchestratorState, ReasonerOutput } from './types.js';
import type { AgentDeps } from './deps.js';
import { abstainResult, handoffResult } from './terminals.js';
import { verifyAndEmit } from './emit.js';
import { appendToolResults, runTools } from './tools.js';

export function criticLoop(deps: AgentDeps): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => {
    // Cache-hit candidate → re-verify through the emit edge. A verified hit resolves;
    // a bad guess (repair/abstain) does NOT abstain the turn — fall through to reasoning.
    if (s.cachedDraft !== undefined) {
      const cached = await verifyAndEmit(s.cachedDraft, s, deps);
      if (cached.kind === 'emit') return { ...s, halt: cached.result };
    }

    let state = s;
    for (let turn = 0; turn < deps.maxAttempts; turn++) {
      if (ctx.signal.aborted) return { ...state, halt: abstainResult('aborted') }; // FAIL CLOSED

      let decision: ReasonerOutput;
      try {
        decision = await deps.reasoner.reason(state, ctx.signal);
      } catch (err) {
        return { ...state, halt: abstainResult(`reasoner error: ${(err as Error).message}`) }; // FAIL CLOSED
      }

      switch (decision.kind) {
        case 'abstain':
          return { ...state, halt: abstainResult(decision.reason) };

        case 'handoff':
          return {
            ...state,
            halt: handoffResult(decision.handoff.target, decision.handoff.reason),
          };

        case 'tool': {
          const run = await runTools(
            decision.calls,
            deps.tools,
            deps.policy,
            { tenantId: state.event.tenantId, principalId: state.event.userId },
            ctx.signal,
          );
          if (run.denied) {
            return { ...state, halt: handoffResult('ops', `tool denied: ${run.reason}`) }; // FAIL CLOSED
          }
          state = { ...state, history: appendToolResults(state.history, run.results) };
          continue; // gather more, capped by maxAttempts
        }

        case 'answer': {
          // Verify → (on repair) rewrite from the critique → re-verify, up to maxRepairRounds.
          // The rewritten draft is NOT trusted: it re-enters the SAME emit edge, so a bad
          // rewrite can never ship. A verifier-throw / uncited / outbound-leak abstain is NOT
          // repairable — only a `repair` (verify pass=false) is retried.
          let draft = decision.draft;
          for (let round = 0; round <= deps.maxRepairRounds; round++) {
            if (ctx.signal.aborted) return { ...state, halt: abstainResult('aborted') }; // FAIL CLOSED

            const emit = await verifyAndEmit(draft, state, deps);
            if (emit.kind === 'emit') return { ...state, halt: emit.result };
            if (emit.kind === 'abstain') return { ...state, halt: abstainResult(emit.reason) }; // not repairable

            // emit.kind === 'repair'
            if (round === deps.maxRepairRounds) {
              return {
                ...state,
                halt: abstainResult(`unverified after ${deps.maxRepairRounds} repair round(s): ${emit.critique}`),
              }; // FAIL CLOSED — budget spent
            }
            try {
              draft = await deps.rewrite({ draft, critique: emit.critique, signal: ctx.signal });
            } catch (err) {
              return { ...state, halt: abstainResult(`repair failed: ${(err as Error).message}`) }; // FAIL CLOSED
            }
          }
          // Unreachable (the loop returns on every path), but fail closed by construction.
          return { ...state, halt: abstainResult('repair budget exhausted') };
        }
      }
    }

    // Exhausted every turn still calling tools without ever drafting an answer → abstain.
    return { ...state, halt: abstainResult(`no answer within ${deps.maxAttempts} attempts`) };
  };
}
