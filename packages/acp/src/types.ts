/**
 * Agent Client Protocol (ACP) — protocol v1 type definitions.
 *
 * Spec: https://agentclientprotocol.com (fetched 2026-06-04).
 * Wire: JSON-RPC 2.0 over stdio for local, HTTP/WS for remote.
 * Re-uses MCP content-block shapes where possible.
 *
 * Verbatim spec language:
 *   - "protocolVersion is a single integer that identifies a MAJOR
 *      protocol version"
 *   - "Clients and Agents MUST treat all capabilities omitted in the
 *      initialize request as UNSUPPORTED"
 *
 * Only types are exported from this module; transport + dispatch
 * live in adjacent modules.
 */

// ── JSON-RPC envelope ─────────────────────────────────────────────────

export interface JsonRpcRequest<Params = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Params;
}

export interface JsonRpcNotification<Params = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: Params;
}

export interface JsonRpcSuccess<Result = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result: Result;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcError;

// JSON-RPC 2.0 reserved error codes:
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ── ACP-specific types ────────────────────────────────────────────────

/** Single-integer major version. v1 at time of writing. */
export type ProtocolVersion = number;

export const PROTOCOL_VERSION: ProtocolVersion = 1;

/** Stop reason from the spec response payload. */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'user_cancel'
  | 'refusal'
  | 'error';

// ── Content blocks (spec §prompt-turn) ────────────────────────────────

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string };

// ── Capabilities ──────────────────────────────────────────────────────

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  /** Operator extensions land here under a known prefix. */
  experimental?: Readonly<Record<string, unknown>>;
}

export interface AgentCapabilities {
  /** Subset / superset is negotiated; clients omit-as-unsupported. */
  prompt?: {
    text?: boolean;
    image?: boolean;
    audio?: boolean;
    resource?: boolean;
  };
  /** Session multiplexing supported? */
  sessions?: boolean;
  experimental?: Readonly<Record<string, unknown>>;
}

export interface ClientInfo {
  name: string;
  title?: string;
  version: string;
}
export interface AgentInfo {
  name: string;
  title?: string;
  version: string;
}

// ── initialize ────────────────────────────────────────────────────────

export interface InitializeParams {
  protocolVersion: ProtocolVersion;
  clientCapabilities: ClientCapabilities;
  clientInfo: ClientInfo;
}

export interface InitializeResult {
  protocolVersion: ProtocolVersion;
  agentCapabilities: AgentCapabilities;
  agentInfo: AgentInfo;
  authMethods?: ReadonlyArray<string>;
}

// ── session/new ───────────────────────────────────────────────────────

export interface SessionNewParams {
  /** Optional operator-supplied metadata; agent stores opaquely. */
  metadata?: Readonly<Record<string, unknown>>;
}

export interface SessionNewResult {
  sessionId: string;
}

// ── session/prompt ────────────────────────────────────────────────────

export interface SessionPromptParams {
  sessionId: string;
  prompt: ReadonlyArray<ContentBlock>;
}

export interface SessionPromptResult {
  stopReason: StopReason;
}

// ── session/cancel ────────────────────────────────────────────────────

export interface SessionCancelParams {
  sessionId: string;
}

// ── session/update (notification only) ────────────────────────────────

export type SessionUpdate =
  | { type: 'agent_message_chunk'; content: ContentBlock }
  | { type: 'agent_thought_chunk'; content: ContentBlock }
  | { type: 'tool_call_start'; toolCallId: string; name: string }
  | { type: 'tool_call_delta'; toolCallId: string; argsPartial: string }
  | { type: 'tool_call_end'; toolCallId: string; result?: unknown };

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

// ── Method-name constants (keep wire spelling exact) ──────────────────

export const ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
} as const;
