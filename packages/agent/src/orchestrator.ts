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
import type { Step } from '@tenet/workflow';
import type { OrchestratorState, Result } from './types.js';
import { abstainResult } from './terminals.js';

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
