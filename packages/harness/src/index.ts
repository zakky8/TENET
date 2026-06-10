/**
 * @tenet/harness — the long-horizon layer above the tool loop.
 *
 * "Harness" is 2026's noun for it (OpenAI's "in-distribution harness",
 * Microsoft's "Agent Harness"): the machinery that keeps a long-running
 * agent coherent — context compaction when the window fills, a todo
 * ledger so multi-step work survives the loop, and subagent fan-out
 * with bounded concurrency and error isolation.
 *
 * Everything is injected and deterministic-testable; nothing here
 * calls a model directly.
 */

// ── Context compaction ────────────────────────────────────────────────

export interface HarnessMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface TokenEstimator {
  (text: string): number;
}

/** Default: ~4 chars/token — the standard rough estimate for English. */
export const charsPerTokenEstimator: TokenEstimator = (text) => Math.ceil(text.length / 4);

export interface Summarizer {
  /**
   * Summarize a transcript slice into a compact digest. Wire a
   * ChatModel call; the harness never talks to a model itself.
   */
  summarize(messages: HarnessMessage[], signal?: AbortSignal): Promise<string>;
}

export interface CompactorOptions {
  /** Token budget the final message list must fit. */
  budgetTokens: number;
  /** Recent messages always kept verbatim. Default 8. */
  keepRecent?: number;
  estimator?: TokenEstimator;
}

export interface CompactionResult {
  messages: HarnessMessage[];
  compacted: boolean;
  /** Tokens (estimated) before → after. */
  before: number;
  after: number;
}

export class ContextCompactor {
  private readonly budget: number;
  private readonly keepRecent: number;
  private readonly estimate: TokenEstimator;

  constructor(
    private readonly summarizer: Summarizer,
    opts: CompactorOptions,
  ) {
    if (opts.budgetTokens <= 0) throw new Error('budgetTokens must be > 0');
    this.budget = opts.budgetTokens;
    this.keepRecent = opts.keepRecent ?? 8;
    if (this.keepRecent < 0) throw new Error('keepRecent must be >= 0');
    this.estimate = opts.estimator ?? charsPerTokenEstimator;
  }

  total(messages: HarnessMessage[]): number {
    return messages.reduce((sum, m) => sum + this.estimate(m.content), 0);
  }

  /**
   * If over budget: summarize everything between the leading system
   * message(s) and the recent window into one system digest message.
   * Under budget: returns input unchanged.
   */
  async compact(messages: HarnessMessage[], signal?: AbortSignal): Promise<CompactionResult> {
    const before = this.total(messages);
    if (before <= this.budget) {
      return { messages, compacted: false, before, after: before };
    }

    // Leading system prompt(s) are pinned — never summarized away.
    let sysEnd = 0;
    while (sysEnd < messages.length && messages[sysEnd]!.role === 'system') sysEnd++;

    const recentStart = Math.max(sysEnd, messages.length - this.keepRecent);
    const middle = messages.slice(sysEnd, recentStart);
    if (middle.length === 0) {
      // Nothing to fold — already minimal; return as-is (caller may
      // need a bigger budget or smaller keepRecent).
      return { messages, compacted: false, before, after: before };
    }

    const summary = await this.summarizer.summarize(middle, signal);
    const out: HarnessMessage[] = [
      ...messages.slice(0, sysEnd),
      { role: 'system', content: `[conversation summary] ${summary}` },
      ...messages.slice(recentStart),
    ];
    return { messages: out, compacted: true, before, after: this.total(out) };
  }
}

// ── Todo ledger ───────────────────────────────────────────────────────

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TodoItem {
  id: number;
  subject: string;
  status: TodoStatus;
  note?: string;
}

/**
 * Ordered task ledger for long-horizon work. JSON round-trip so it
 * persists through any StateStore; render() produces the compact
 * markdown block you inject into the agent's context each turn.
 */
export class TodoLedger {
  private items: TodoItem[] = [];
  private nextId = 1;

  add(subject: string): TodoItem {
    if (!subject.trim()) throw new Error('todo subject required');
    const item: TodoItem = { id: this.nextId++, subject: subject.trim(), status: 'pending' };
    this.items.push(item);
    return item;
  }

  private find(id: number): TodoItem {
    const item = this.items.find((t) => t.id === id);
    if (item === undefined) throw new Error(`todo #${id} not found`);
    return item;
  }

  start(id: number): void {
    const item = this.find(id);
    if (item.status === 'completed') throw new Error(`todo #${id} already completed`);
    item.status = 'in_progress';
  }

  complete(id: number, note?: string): void {
    const item = this.find(id);
    item.status = 'completed';
    if (note !== undefined) item.note = note;
  }

  fail(id: number, note?: string): void {
    const item = this.find(id);
    item.status = 'failed';
    if (note !== undefined) item.note = note;
  }

  list(): readonly TodoItem[] {
    return [...this.items];
  }

  /** True when every item is terminal (completed or failed). */
  settled(): boolean {
    return this.items.every((t) => t.status === 'completed' || t.status === 'failed');
  }

  /** Compact markdown block for injection into agent context. */
  render(): string {
    if (this.items.length === 0) return '(no todos)';
    const mark: Record<TodoStatus, string> = {
      pending: '[ ]', in_progress: '[~]', completed: '[x]', failed: '[!]',
    };
    return this.items
      .map((t) => `${mark[t.status]} #${t.id} ${t.subject}${t.note !== undefined ? ` — ${t.note}` : ''}`)
      .join('\n');
  }

  toJSON(): string {
    return JSON.stringify({ items: this.items, nextId: this.nextId });
  }

  static fromJSON(json: string): TodoLedger {
    const parsed = JSON.parse(json) as { items: TodoItem[]; nextId: number };
    if (!Array.isArray(parsed.items) || !Number.isInteger(parsed.nextId)) {
      throw new Error('TodoLedger.fromJSON: malformed payload');
    }
    const ledger = new TodoLedger();
    ledger.items = parsed.items;
    ledger.nextId = parsed.nextId;
    return ledger;
  }
}

// ── Subagent primitives ───────────────────────────────────────────────

export interface SubagentTask<T> {
  name: string;
  run(signal: AbortSignal): Promise<T>;
}

export type SubagentResult<T> =
  | { name: string; status: 'ok'; value: T }
  | { name: string; status: 'error'; error: string };

export interface SpawnOptions {
  /** Max tasks running at once. Default 4. */
  concurrency?: number;
  /** Abort all subagents (running + queued) when this fires. */
  signal?: AbortSignal;
}

/**
 * Fan out subagent tasks with bounded concurrency and error isolation:
 * one failed subagent yields an 'error' result; it never rejects the
 * batch. Results return in INPUT order regardless of completion order.
 */
export async function spawnSubagents<T>(
  tasks: SubagentTask<T>[],
  opts: SpawnOptions = {},
): Promise<SubagentResult<T>[]> {
  const concurrency = opts.concurrency ?? 4;
  if (concurrency <= 0) throw new Error('concurrency must be > 0');
  const names = new Set<string>();
  for (const t of tasks) {
    if (names.has(t.name)) throw new Error(`duplicate subagent name '${t.name}'`);
    names.add(t.name);
  }

  const results = new Array<SubagentResult<T>>(tasks.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      if (opts.signal?.aborted) {
        // Mark everything not yet started as aborted.
        while (next < tasks.length) {
          const i = next++;
          results[i] = { name: tasks[i]!.name, status: 'error', error: 'aborted' };
        }
        return;
      }
      const i = next++;
      const task = tasks[i]!;
      try {
        const value = await task.run(opts.signal ?? new AbortController().signal);
        results[i] = { name: task.name, status: 'ok', value };
      } catch (err) {
        results[i] = {
          name: task.name, status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/**
 * Handoff descriptor — the multi-agent primitive where one agent
 * transfers the conversation to a specialist. The orchestrator matches
 * `target` against its agent registry; `reason` and `context` carry
 * over so the specialist starts warm.
 */
export interface Handoff {
  kind: 'handoff';
  target: string;
  reason: string;
  context?: Record<string, unknown>;
}

export function isHandoff(value: unknown): value is Handoff {
  return value !== null && typeof value === 'object'
    && (value as Handoff).kind === 'handoff'
    && typeof (value as Handoff).target === 'string'
    && typeof (value as Handoff).reason === 'string';
}

export const VERSION = '0.0.0';
