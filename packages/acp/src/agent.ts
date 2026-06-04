/**
 * ACP agent runtime — wraps a TENET-shaped handler in the JSON-RPC
 * v1 protocol expected by Zed, Cursor, Helix, Aider, and any other
 * ACP-aware editor.
 *
 * Operator hands us a `handlePrompt` callback that receives the
 * session id + prompt content blocks and yields ACP `session/update`
 * notifications until it returns a final `stopReason`.
 *
 * Wire / dispatch / transport live in adjacent modules.
 */

import { randomBytes } from 'node:crypto';
import {
  ACP_METHODS,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AgentInfo,
  type ContentBlock,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type SessionCancelParams,
  type SessionNewParams,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionUpdate,
  type SessionUpdateParams,
  type StopReason,
} from './types.js';

// ── Operator-facing handler shape ─────────────────────────────────────

export interface AcpPromptContext {
  sessionId: string;
  /** Cancellation — fires on session/cancel from the client. */
  signal: AbortSignal;
  /** Emit a session/update notification to the client. */
  emit(update: SessionUpdate): void;
}

export interface AcpHandler {
  /** Final result must include a stopReason. Yield updates via ctx.emit(). */
  handlePrompt(
    prompt: ReadonlyArray<ContentBlock>,
    ctx: AcpPromptContext,
  ): Promise<SessionPromptResult>;
}

// ── Outbound message sink (injected — operator wires stdio / ws) ──────

export interface AcpOutboundSink {
  send(msg: JsonRpcSuccess | JsonRpcError | JsonRpcNotification): void;
}

// ── Agent class ───────────────────────────────────────────────────────

export interface AcpAgentOptions {
  info: AgentInfo;
  /** Operator-declared capabilities. Spec rule: omitted = UNSUPPORTED. */
  capabilities: AgentCapabilities;
  handler: AcpHandler;
  /** Optional supported auth methods. */
  authMethods?: ReadonlyArray<string>;
  /** Optional clock for deterministic session ids in tests. */
  now?: () => number;
}

export class AcpAgent {
  private readonly sessions = new Map<string, AbortController>();
  private sessionCounter = 0;
  private initialized = false;
  private negotiatedVersion: number = PROTOCOL_VERSION;

  constructor(
    private readonly opts: AcpAgentOptions,
    private readonly out: AcpOutboundSink,
  ) {}

  /**
   * Drive a single inbound JSON-RPC request. Notifications and
   * malformed messages are tolerated silently per JSON-RPC.
   */
  async dispatch(req: JsonRpcRequest): Promise<void> {
    if (req.jsonrpc !== '2.0') {
      this.sendError(req.id ?? null, INVALID_PARAMS, 'invalid jsonrpc version');
      return;
    }
    try {
      switch (req.method) {
        case ACP_METHODS.initialize:
          this.handleInitialize(req);
          return;
        case ACP_METHODS.sessionNew:
          this.handleSessionNew(req);
          return;
        case ACP_METHODS.sessionPrompt:
          await this.handleSessionPrompt(req);
          return;
        case ACP_METHODS.sessionCancel:
          this.handleSessionCancel(req);
          return;
        default:
          this.sendError(req.id, METHOD_NOT_FOUND, `unknown method: ${req.method}`);
      }
    } catch (e) {
      this.sendError(req.id, INTERNAL_ERROR, (e as Error).message);
    }
  }

  // ── handlers ────────────────────────────────────────────────────────

  private handleInitialize(req: JsonRpcRequest): void {
    const p = req.params as InitializeParams | undefined;
    if (!p || typeof p !== 'object' || typeof p.protocolVersion !== 'number') {
      this.sendError(req.id, INVALID_PARAMS, 'initialize requires protocolVersion + clientCapabilities + clientInfo');
      return;
    }
    // SECURITY 2026-06-04 vuln-test #B2: reject 0/negative/non-integer
    // versions. Spec says "single integer that identifies a MAJOR
    // protocol version" — ≥1.
    if (!Number.isInteger(p.protocolVersion) || p.protocolVersion < 1) {
      this.sendError(req.id, INVALID_PARAMS, 'protocolVersion must be a positive integer');
      return;
    }
    // Spec: respond with same version if supported, else latest we support.
    this.negotiatedVersion = p.protocolVersion <= PROTOCOL_VERSION ? p.protocolVersion : PROTOCOL_VERSION;
    this.initialized = true;
    const result: InitializeResult = {
      protocolVersion: this.negotiatedVersion,
      agentCapabilities: this.opts.capabilities,
      agentInfo: this.opts.info,
      ...(this.opts.authMethods !== undefined ? { authMethods: this.opts.authMethods } : {}),
    };
    this.sendSuccess(req.id, result);
  }

  private handleSessionNew(req: JsonRpcRequest): void {
    if (!this.initialized) {
      this.sendError(req.id, INVALID_PARAMS, 'initialize must precede session/new');
      return;
    }
    void (req.params as SessionNewParams | undefined);
    const sessionId = this.mintSessionId();
    this.sessions.set(sessionId, new AbortController());
    const result: SessionNewResult = { sessionId };
    this.sendSuccess(req.id, result);
  }

  private async handleSessionPrompt(req: JsonRpcRequest): Promise<void> {
    if (!this.initialized) {
      this.sendError(req.id, INVALID_PARAMS, 'initialize must precede session/prompt');
      return;
    }
    const p = req.params as SessionPromptParams | undefined;
    if (!p || typeof p.sessionId !== 'string' || !Array.isArray(p.prompt)) {
      this.sendError(req.id, INVALID_PARAMS, 'session/prompt requires sessionId + prompt');
      return;
    }
    if (!this.sessions.has(p.sessionId)) {
      this.sendError(req.id, INVALID_PARAMS, `unknown sessionId ${p.sessionId}`);
      return;
    }
    // CORRECTNESS 2026-06-04 vuln-test #B1: fresh AbortController per
    // prompt. Previously a cancelled session retained its aborted
    // controller, so subsequent prompts immediately fired the abort
    // path and returned user_cancel without running the handler.
    // Sessions persist; cancellation scope is per-turn.
    const ctrl = new AbortController();
    this.sessions.set(p.sessionId, ctrl);
    const ctx: AcpPromptContext = {
      sessionId: p.sessionId,
      signal: ctrl.signal,
      emit: (update) => this.sendNotification<SessionUpdateParams>(ACP_METHODS.sessionUpdate, {
        sessionId: p.sessionId,
        update,
      }),
    };
    let result: SessionPromptResult;
    try {
      result = await this.opts.handler.handlePrompt(p.prompt, ctx);
    } catch (e) {
      if (ctrl.signal.aborted) {
        const cancelled: SessionPromptResult = { stopReason: 'user_cancel' as StopReason };
        this.sendSuccess(req.id, cancelled);
        return;
      }
      this.sendError(req.id, INTERNAL_ERROR, (e as Error).message);
      return;
    }
    this.sendSuccess(req.id, result);
  }

  private handleSessionCancel(req: JsonRpcRequest): void {
    const p = req.params as SessionCancelParams | undefined;
    if (!p || typeof p.sessionId !== 'string') {
      // CORRECTNESS 2026-06-04 vuln-test #B3: tolerate notification form
      // (no id). Per JSON-RPC, a notification gets no response.
      if (req.id !== undefined) {
        this.sendError(req.id, INVALID_PARAMS, 'session/cancel requires sessionId');
      }
      return;
    }
    const ctrl = this.sessions.get(p.sessionId);
    if (!ctrl) {
      if (req.id !== undefined) {
        this.sendError(req.id, INVALID_PARAMS, `unknown sessionId ${p.sessionId}`);
      }
      return;
    }
    ctrl.abort();
    if (req.id !== undefined) this.sendSuccess(req.id, {});
  }

  // ── outbound helpers ────────────────────────────────────────────────

  private sendSuccess<T>(id: number | string, result: T): void {
    this.out.send({ jsonrpc: '2.0', id, result });
  }

  private sendError(id: number | string | null, code: number, message: string): void {
    const err: JsonRpcError = { jsonrpc: '2.0', id, error: { code, message } };
    this.out.send(err);
  }

  private sendNotification<P>(method: string, params: P): void {
    const n: JsonRpcNotification<P> = { jsonrpc: '2.0', method, params };
    this.out.send(n);
  }

  // ── id mint ─────────────────────────────────────────────────────────

  private mintSessionId(): string {
    // SECURITY 2026-06-04 vuln-test #A5: cryptographically-random session
    // ids. Previous Date.now()+counter was fully predictable — over HTTP/WS
    // transport (spec-defined remote profile) a connected client could
    // guess another client's session id and call session/cancel on it.
    // 128 bits is the standard floor.
    void this.sessionCounter;
    return `sess_${randomBytes(16).toString('hex')}`;
  }
}
