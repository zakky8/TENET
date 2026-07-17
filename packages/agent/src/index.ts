/**
 * @tenet/agent — the verification-first agent turn.
 *
 * Public surface. Increment 2.1a ships the type contract (see ./types.ts);
 * the Reasoner (2.2), the graph nodes, and the orchestrator (runAgent) land in
 * subsequent increments and are exported from here as they arrive.
 */
export type {
  ToolCall,
  RetrievedChunk,
  Result,
  OrchestratorState,
  ReasonerOutput,
  Reasoner,
} from './types.js';

export const VERSION = '0.0.0';
