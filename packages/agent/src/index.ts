/**
 * @tenet/agent — the verification-first agent turn.
 *
 * Public surface. Increment 2.1a ships the type contract (see ./types.ts);
 * increment 2.2a ships the fail-closed Reasoner (see ./reasoner.ts); the graph
 * nodes and the orchestrator (runAgent) land in subsequent increments and are
 * exported from here as they arrive.
 */
export type {
  ToolCall,
  RetrievedChunk,
  Result,
  OrchestratorState,
  ReasonerOutput,
  Reasoner,
} from './types.js';

export { modelReasoner, parseEnvelope, buildSystem } from './reasoner.js';

export {
  emitResult,
  abstainResult,
  handoffResult,
  ABSTAIN_REPLY,
  HANDOFF_REPLY,
} from './terminals.js';
export { halting, finalize } from './orchestrator.js';

export type {
  AgentDeps,
  Retriever,
  AnswerCache,
  ScoredResult,
  Verifier,
  VerifierInput,
  VerifierVerdict,
  ToolExecutor,
} from './deps.js';
export type { ToolResultBlock } from './types.js';
export { injectionGate, retrieveNode, cacheNode } from './nodes.js';
export { verifyAndEmit, knowledgeBlock, type EmitDecision } from './emit.js';
export { runTools, appendToolResults, type ToolRunContext, type ToolRunResult } from './tools.js';
export { criticLoop } from './criticLoop.js';

export const VERSION = '0.0.0';
