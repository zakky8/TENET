import type { ConversationMessage } from '@tenet/core';

/**
 * Working memory: bounded ring buffer of the most recent messages in
 * a conversation. Sized so the entire window fits in a single model
 * context budget; older turns are dropped (or summarized — that's an
 * app concern, not framework).
 *
 * Designed to be cheap: O(1) append, O(window) read, no allocation
 * after construction.
 */
export interface WorkingMemoryOptions {
  /** Maximum number of messages retained. Default 20. */
  capacity?: number;
  /**
   * Optional token-budget cap. When the sum of message-content lengths
   * (rough token proxy: chars / 4) exceeds this, oldest messages are
   * dropped until under budget. 0 = disabled.
   */
  tokenBudget?: number;
}

export class WorkingMemory {
  private readonly capacity: number;
  private readonly tokenBudget: number;
  private buf: ConversationMessage[] = [];

  constructor(opts: WorkingMemoryOptions = {}) {
    this.capacity = opts.capacity ?? 20;
    this.tokenBudget = opts.tokenBudget ?? 0;
    if (this.capacity <= 0) throw new Error('WorkingMemory: capacity must be > 0');
    if (this.tokenBudget < 0) throw new Error('WorkingMemory: tokenBudget must be >= 0');
  }

  append(msg: ConversationMessage): void {
    this.buf.push(msg);
    while (this.buf.length > this.capacity) this.buf.shift();
    if (this.tokenBudget > 0) {
      while (this.buf.length > 1 && this.estimateTokens() > this.tokenBudget) {
        this.buf.shift();
      }
    }
  }

  /** Read-only view of current messages, oldest → newest. */
  messages(): ReadonlyArray<ConversationMessage> {
    return this.buf;
  }

  size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf = [];
  }

  /** Rough char/4 estimate; replace via subclassing if you need a real tokenizer. */
  protected estimateTokens(): number {
    let total = 0;
    for (const m of this.buf) total += Math.ceil(m.content.length / 4);
    return total;
  }
}
