/**
 * A2A server — exposes a TENET agent to the A2A ecosystem.
 *
 * Transport-agnostic: handleRequest(jsonText) → response JSON text.
 * Mount it on any HTTP server (the REST surface, Express, Hono, a
 * Lambda) and serve agentCardJson() at /.well-known/agent-card.json.
 *
 * The agent handler is injected: it receives the user message + task
 * and returns the agent's reply parts (or asks for more input). Task
 * state transitions and history are managed here.
 */

import { randomBytes } from 'node:crypto';
import {
  A2A_ERRORS,
  A2A_METHODS,
  TERMINAL_STATES,
  type AgentCard,
  type Artifact,
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type Message,
  type MessageSendParams,
  type Part,
  type Task,
  type TaskIdParams,
  type TaskQueryParams,
} from './types.js';

// ── Agent handler contract ────────────────────────────────────────────

export interface AgentReply {
  /** Reply parts from the agent. */
  parts: Part[];
  /** Optional artifacts produced while handling the message. */
  artifacts?: Artifact[];
  /**
   * 'completed' (default) finishes the task; 'input-required' parks it
   * waiting for the next user message; 'failed'/'rejected' terminal.
   */
  state?: 'completed' | 'input-required' | 'failed' | 'rejected';
}

export interface A2AAgentHandler {
  handle(args: {
    message: Message;
    task: Task;
    signal: AbortSignal;
  }): Promise<AgentReply>;
}

// ── Task store (pluggable; in-memory default) ─────────────────────────

export interface TaskStore {
  get(id: string): Promise<Task | undefined>;
  put(task: Task): Promise<void>;
}

export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  async get(id: string): Promise<Task | undefined> {
    return this.tasks.get(id);
  }
  async put(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }
  /** All tasks (diagnostics / tests). Not part of the TaskStore contract. */
  list(): Task[] {
    return [...this.tasks.values()];
  }
}

// ── Server ────────────────────────────────────────────────────────────

export interface A2AServerOptions {
  card: AgentCard;
  handler: A2AAgentHandler;
  store?: TaskStore;
  /** Cap stored per-task history to bound memory. Default 200 messages. */
  maxHistory?: number;
}

export class A2AServer {
  private readonly card: AgentCard;
  private readonly handler: A2AAgentHandler;
  private readonly store: TaskStore;
  private readonly maxHistory: number;
  private readonly inflight = new Map<string, AbortController>();

  constructor(opts: A2AServerOptions) {
    this.card = opts.card;
    this.handler = opts.handler;
    this.store = opts.store ?? new InMemoryTaskStore();
    this.maxHistory = opts.maxHistory ?? 200;
    if (this.maxHistory <= 0) throw new Error('maxHistory must be > 0');
  }

  /** Serve this at /.well-known/agent-card.json. */
  agentCardJson(): string {
    return JSON.stringify(this.card);
  }

  /** One JSON-RPC request in, one response out. */
  async handleRequest(jsonText: string): Promise<string> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(jsonText) as JsonRpcRequest;
    } catch {
      return JSON.stringify(this.failure(null, A2A_ERRORS.PARSE_ERROR, 'parse error'));
    }
    if (req === null || typeof req !== 'object' || req.jsonrpc !== '2.0'
        || (typeof req.id !== 'string' && typeof req.id !== 'number')
        || typeof req.method !== 'string') {
      return JSON.stringify(this.failure(null, A2A_ERRORS.INVALID_REQUEST, 'invalid request'));
    }

    try {
      switch (req.method) {
        case A2A_METHODS.MESSAGE_SEND:
          return JSON.stringify(await this.onMessageSend(req));
        case A2A_METHODS.TASKS_GET:
          return JSON.stringify(await this.onTasksGet(req));
        case A2A_METHODS.TASKS_CANCEL:
          return JSON.stringify(await this.onTasksCancel(req));
        case A2A_METHODS.MESSAGE_STREAM:
          // Streaming requires an SSE transport; the JSON-RPC unary
          // endpoint advertises it as unsupported rather than hanging.
          return JSON.stringify(this.failure(
            req.id, A2A_ERRORS.UNSUPPORTED_OPERATION,
            'message/stream requires the SSE transport; use message/send',
          ));
        default:
          return JSON.stringify(this.failure(req.id, A2A_ERRORS.METHOD_NOT_FOUND, `unknown method '${req.method}'`));
      }
    } catch (err) {
      return JSON.stringify(this.failure(
        req.id, A2A_ERRORS.INTERNAL_ERROR,
        err instanceof Error ? err.message : 'internal error',
      ));
    }
  }

  private failure(id: string | number | null, code: number, message: string): JsonRpcFailure {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  private newId(prefix: string): string {
    return `${prefix}_${randomBytes(12).toString('hex')}`;
  }

  private async onMessageSend(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const p = req.params as MessageSendParams | undefined;
    const msg = p?.message;
    if (msg === undefined || !Array.isArray(msg.parts) || msg.role !== 'user'
        || typeof msg.messageId !== 'string') {
      return this.failure(req.id, A2A_ERRORS.INVALID_PARAMS,
        'message/send requires params.message {role:"user", parts, messageId}');
    }

    // Continue an existing task or open a new one.
    let task: Task;
    if (typeof msg.taskId === 'string') {
      const found = await this.store.get(msg.taskId);
      if (found === undefined) {
        return this.failure(req.id, A2A_ERRORS.TASK_NOT_FOUND, `task '${msg.taskId}' not found`);
      }
      if (TERMINAL_STATES.has(found.status.state)) {
        return this.failure(req.id, A2A_ERRORS.INVALID_PARAMS,
          `task '${msg.taskId}' is ${found.status.state}; start a new task`);
      }
      task = found;
    } else {
      task = {
        id: this.newId('task'),
        contextId: typeof msg.contextId === 'string' ? msg.contextId : this.newId('ctx'),
        status: { state: 'submitted' },
        artifacts: [],
        history: [],
      };
    }

    const userMsg: Message = { ...msg, taskId: task.id, contextId: task.contextId };
    task.history.push(userMsg);
    task.status = { state: 'working', timestamp: new Date().toISOString() };
    await this.store.put(task);

    const ctrl = new AbortController();
    this.inflight.set(task.id, ctrl);
    try {
      const reply = await this.handler.handle({ message: userMsg, task, signal: ctrl.signal });
      const agentMsg: Message = {
        role: 'agent',
        parts: reply.parts,
        messageId: this.newId('msg'),
        taskId: task.id,
        contextId: task.contextId,
      };
      task.history.push(agentMsg);
      if (task.history.length > this.maxHistory) {
        task.history = task.history.slice(-this.maxHistory);
      }
      if (reply.artifacts !== undefined) task.artifacts.push(...reply.artifacts);
      const state = reply.state ?? 'completed';
      task.status = { state, message: agentMsg, timestamp: new Date().toISOString() };
      await this.store.put(task);
      return { jsonrpc: '2.0', id: req.id, result: task };
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      task.status = {
        state: aborted ? 'canceled' : 'failed',
        timestamp: new Date().toISOString(),
      };
      await this.store.put(task);
      if (aborted) return { jsonrpc: '2.0', id: req.id, result: task };
      return this.failure(req.id, A2A_ERRORS.INTERNAL_ERROR,
        err instanceof Error ? err.message : 'agent error');
    } finally {
      this.inflight.delete(task.id);
    }
  }

  private async onTasksGet(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const p = req.params as TaskQueryParams | undefined;
    if (p === undefined || typeof p.id !== 'string') {
      return this.failure(req.id, A2A_ERRORS.INVALID_PARAMS, 'tasks/get requires params.id');
    }
    const task = await this.store.get(p.id);
    if (task === undefined) {
      return this.failure(req.id, A2A_ERRORS.TASK_NOT_FOUND, `task '${p.id}' not found`);
    }
    const result: Task = p.historyLength !== undefined && p.historyLength >= 0
      ? { ...task, history: task.history.slice(-p.historyLength) }
      : task;
    return { jsonrpc: '2.0', id: req.id, result };
  }

  private async onTasksCancel(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const p = req.params as TaskIdParams | undefined;
    if (p === undefined || typeof p.id !== 'string') {
      return this.failure(req.id, A2A_ERRORS.INVALID_PARAMS, 'tasks/cancel requires params.id');
    }
    const task = await this.store.get(p.id);
    if (task === undefined) {
      return this.failure(req.id, A2A_ERRORS.TASK_NOT_FOUND, `task '${p.id}' not found`);
    }
    if (TERMINAL_STATES.has(task.status.state)) {
      return this.failure(req.id, A2A_ERRORS.TASK_NOT_CANCELABLE,
        `task '${p.id}' is already ${task.status.state}`);
    }
    this.inflight.get(task.id)?.abort();
    task.status = { state: 'canceled', timestamp: new Date().toISOString() };
    await this.store.put(task);
    return { jsonrpc: '2.0', id: req.id, result: task };
  }
}
