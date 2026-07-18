/**
 * Orchestrator graph mechanics (design gate §4).
 *
 * Terminals are carried in `OrchestratorState.halt`, NOT thrown — so a handoff or
 * abstain is a normal value that flows to the finalizer, never an exception that a
 * catch could mis-handle. `halting` makes every downstream node a no-op once a
 * terminal is set; `finalize` converts the carried terminal into the returned
 * Result, and — critically — FAILS CLOSED if the graph somehow ended without one.
 *
 * (The nodes, the critic loop, and `runAgent` itself land in later 2.1b increments.)
 */
import { runWorkflow, sequential, withTimeout, type Step } from '@tenet/workflow';
import type { OrchestratorState, Result } from './types.js';
import type { AgentDeps } from './deps.js';
import { abstainResult } from './terminals.js';
import { cacheNode, injectionGate, retrieveNode } from './nodes.js';
import { criticLoop } from './criticLoop.js';

/** Wrap a graph node so that, once `state.halt` is set, the node is skipped and the
 *  state passes through unchanged. Lets the graph short-circuit to its terminal
 *  deterministically without every node re-checking `halt` itself. */
export function halting(
  step: Step<OrchestratorState, OrchestratorState>,
): Step<OrchestratorState, OrchestratorState> {
  return async (s, ctx) => (s.halt !== undefined ? s : step(s, ctx));
}

/** Convert the carried terminal into the returned Result. THE FAIL-CLOSED DEFAULT:
 *  a graph that finished WITHOUT setting a terminal abstains — it never emits an
 *  unverified or empty answer. */
export function finalize(state: OrchestratorState): Result {
  return state.halt ?? abstainResult('graph ended without a terminal');
}

/**
 * The composition root: drive `OrchestratorState` through the labeled graph
 * (design gate §4.1) and return the terminal `Result`.
 *
 *   injectionGate → retrieveNode → cacheNode → criticLoop
 *
 * Each pre-reasoning node runs under a wall-clock budget and behind `halting`, so a
 * terminal set upstream short-circuits the rest. Two independent fail-closed layers
 * guarantee no ungrounded answer escapes: (1) `finalize` abstains if the graph ever
 * returns without a carried terminal; (2) the top-level catch converts ANY thrown
 * failure — a `WorkflowError` (timeout / abort / retry-exhausted) or an uncaught node
 * throw — into an abstain. Terminals are CARRIED in `state.halt`, never thrown, so a
 * real handoff/abstain is never mistaken for a crash by this catch.
 */
export async function runAgent(
  state0: OrchestratorState,
  deps: AgentDeps,
  signal: AbortSignal,
): Promise<Result> {
  const graph = sequential(
    halting(withTimeout(injectionGate(deps), deps.timeouts.gate)),
    halting(withTimeout(retrieveNode(deps), deps.timeouts.retrieve)),
    halting(withTimeout(cacheNode(deps), deps.timeouts.cache)),
    halting(criticLoop(deps)),
  );
  try {
    const end = await runWorkflow(graph, state0, { runId: state0.event.conversationId, signal });
    return finalize(end);
  } catch (err) {
    return abstainResult(`orchestrator error: ${(err as Error).message}`); // FAIL CLOSED
  }
}
