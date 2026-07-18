/**
 * @tenet/agent — the verification-first agent turn.
 *
 * Public surface: the type contract (./types.ts), the fail-closed Reasoner
 * (./reasoner.ts), the DI surface + narrow ports (./deps.ts), the pre-reasoning
 * graph nodes (./nodes.ts), the single emit edge (./emit.ts), governance-gated
 * tools (./tools.ts), the critic loop (./criticLoop.ts), and the composition root
 * `runAgent` that drives them all as a fail-closed workflow graph (./orchestrator.ts).
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
export { halting, finalize, runAgent } from './orchestrator.js';

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
