/**
 * A2A client — call remote A2A agents (discover card, send messages,
 * poll/cancel tasks). Fetch-injected; no HTTP library dep.
 */

import {
  A2A_METHODS,
  AGENT_CARD_PATH,
  type AgentCard,
  type JsonRpcResponse,
  type Message,
  type Part,
  type Task,
} from './types.js';

export interface FetchLike {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string> }>;
}

export class A2AClientError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'A2AClientError';
  }
}

export interface A2AClientOptions {
  /** Base URL of the remote agent (the AgentCard `url`). */
  baseUrl: string;
  fetch: FetchLike;
  /** Extra headers (auth) added to every request. */
  headers?: Record<string, string>;
}

export class A2AClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;
  private nextId = 1;

  constructor(opts: A2AClientOptions) {
    if (!opts.baseUrl) throw new Error('A2AClient: baseUrl required');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetch;
    this.headers = opts.headers ?? {};
  }

  /** Fetch the remote agent's card from the well-known path. */
  async fetchAgentCard(signal?: AbortSignal): Promise<AgentCard> {
    const url = this.baseUrl + AGENT_CARD_PATH;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.headers,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new A2AClientError(res.status, `agent card fetch failed: HTTP ${res.status}`);
    }
    const card = JSON.parse(await res.text()) as AgentCard;
    if (typeof card.name !== 'string' || typeof card.url !== 'string') {
      throw new A2AClientError(0, 'agent card missing required fields (name, url)');
    }
    return card;
  }

  private async rpc(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new A2AClientError(res.status, `A2A rpc failed: HTTP ${res.status}`);
    }
    const parsed = JSON.parse(await res.text()) as JsonRpcResponse;
    if ('error' in parsed) {
      throw new A2AClientError(parsed.error.code, parsed.error.message);
    }
    return parsed.result;
  }

  /** Send a message; returns the resulting Task (new or continued). */
  async sendMessage(args: {
    parts: Part[];
    messageId: string;
    taskId?: string;
    contextId?: string;
    signal?: AbortSignal;
  }): Promise<Task> {
    const message: Message = {
      role: 'user',
      parts: args.parts,
      messageId: args.messageId,
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      ...(args.contextId !== undefined ? { contextId: args.contextId } : {}),
    };
    return await this.rpc(A2A_METHODS.MESSAGE_SEND, { message }, args.signal) as Task;
  }

  /** Convenience: send plain text. */
  async sendText(text: string, opts: { messageId: string; taskId?: string; signal?: AbortSignal }): Promise<Task> {
    return this.sendMessage({ parts: [{ kind: 'text', text }], ...opts });
  }

  async getTask(id: string, opts?: { historyLength?: number; signal?: AbortSignal }): Promise<Task> {
    const params = opts?.historyLength !== undefined
      ? { id, historyLength: opts.historyLength }
      : { id };
    return await this.rpc(A2A_METHODS.TASKS_GET, params, opts?.signal) as Task;
  }

  async cancelTask(id: string, signal?: AbortSignal): Promise<Task> {
    return await this.rpc(A2A_METHODS.TASKS_CANCEL, { id }, signal) as Task;
  }
}

/** Extract all text parts from a task's latest agent message. */
export function latestAgentText(task: Task): string {
  for (let i = task.history.length - 1; i >= 0; i--) {
    const m = task.history[i]!;
    if (m.role === 'agent') {
      return m.parts.filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
        .map((p) => p.text).join('');
    }
  }
  return '';
}
