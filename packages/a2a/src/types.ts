/**
 * Agent2Agent (A2A) protocol v1 types.
 *
 * A2A is the Linux Foundation agent-interop protocol (v1.0 spec,
 * May 2026; 150+ member orgs; shipped in Google ADK, CrewAI
 * enterprise, Microsoft Agent Framework, and all three clouds).
 * Agents publish an AgentCard and exchange task-scoped messages over
 * JSON-RPC 2.0.
 *
 * This module covers the core surface: AgentCard discovery, the task
 * lifecycle, message/send, tasks/get, tasks/cancel, and the streaming
 * event shapes. Extensions (push-notification configs, signed cards,
 * gRPC binding) layer on without changing these types.
 */

// ── Agent Card ────────────────────────────────────────────────────────

/** Well-known discovery path, per spec v0.3+. */
export const AGENT_CARD_PATH = '/.well-known/agent-card.json';

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface AgentCard {
  /** Spec protocol version this agent speaks. */
  protocolVersion: string;
  name: string;
  description: string;
  /** Base URL of the agent's A2A endpoint. */
  url: string;
  version: string;
  capabilities: AgentCapabilities;
  skills: AgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  provider?: { organization: string; url?: string };
  documentationUrl?: string;
}

// ── Messages, parts, artifacts ────────────────────────────────────────

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'file'; file: { name?: string; mimeType?: string; uri?: string; bytes?: string } }
  | { kind: 'data'; data: Record<string, unknown> };

export interface Message {
  role: 'user' | 'agent';
  parts: Part[];
  messageId: string;
  taskId?: string;
  contextId?: string;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
}

// ── Task lifecycle ────────────────────────────────────────────────────

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

/** States from which no further transitions are allowed. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'completed', 'failed', 'canceled', 'rejected',
]);

export interface TaskStatus {
  state: TaskState;
  /** Agent message accompanying the state (e.g. the input-required question). */
  message?: Message;
  timestamp?: string;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts: Artifact[];
  history: Message[];
}

// ── Streaming events (message/stream + tasks/resubscribe) ─────────────

export type A2AStreamEvent =
  | { kind: 'task'; task: Task }
  | { kind: 'status-update'; taskId: string; contextId: string; status: TaskStatus; final: boolean }
  | { kind: 'artifact-update'; taskId: string; contextId: string; artifact: Artifact; lastChunk: boolean };

// ── JSON-RPC 2.0 envelopes ────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export const A2A_METHODS = {
  MESSAGE_SEND: 'message/send',
  MESSAGE_STREAM: 'message/stream',
  TASKS_GET: 'tasks/get',
  TASKS_CANCEL: 'tasks/cancel',
} as const;

/** JSON-RPC reserved + A2A-specific error codes (spec §8). */
export const A2A_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
} as const;

// ── Method params/results ─────────────────────────────────────────────

export interface MessageSendParams {
  message: Message;
  configuration?: {
    acceptedOutputModes?: string[];
    blocking?: boolean;
  };
}

export interface TaskQueryParams {
  id: string;
  historyLength?: number;
}

export interface TaskIdParams {
  id: string;
}
