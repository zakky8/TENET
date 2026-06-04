import type { ConversationMessage } from '@tenet/core';

/**
 * Episodic memory: bounded long-term conversation history.
 *
 * Stored per (tenantId, conversationId). Retrieval shapes:
 *   - `recent(n)`: most recent n messages — cheap path
 *   - `byTimeRange(from, to)`: messages within absolute time window
 *
 * Apps swap implementations:
 *   - InMemoryEpisodicMemory for dev/test (this file)
 *   - PostgresEpisodicMemory or DynamoEpisodicMemory for prod (separate
 *     adapter packages, conforming to the interface)
 *   - mem0 / Letta / Zep adapters layered on top (separate packages)
 */
export interface EpisodicMemory {
  append(args: {
    tenantId: string;
    conversationId: string;
    message: ConversationMessage;
    timestampMs: number;
  }): Promise<void>;

  recent(args: {
    tenantId: string;
    conversationId: string;
    n: number;
  }): Promise<ReadonlyArray<{ message: ConversationMessage; timestampMs: number }>>;

  byTimeRange(args: {
    tenantId: string;
    conversationId: string;
    fromMs: number;
    toMs: number;
  }): Promise<ReadonlyArray<{ message: ConversationMessage; timestampMs: number }>>;

  delete(args: { tenantId: string; conversationId: string }): Promise<void>;
}

interface Entry {
  message: ConversationMessage;
  timestampMs: number;
}

export interface InMemoryEpisodicOptions {
  /** Per-conversation cap. Older entries discarded. Default 1000. */
  perConversationCap?: number;
}

export class InMemoryEpisodicMemory implements EpisodicMemory {
  private readonly perCap: number;
  /** Map<`${tenantId}|${conversationId}`, Entry[]> */
  private readonly store = new Map<string, Entry[]>();

  constructor(opts: InMemoryEpisodicOptions = {}) {
    this.perCap = opts.perConversationCap ?? 1000;
    if (this.perCap <= 0) throw new Error('perConversationCap must be > 0');
  }

  private key(t: string, c: string): string {
    return `${t}|${c}`;
  }

  async append(args: {
    tenantId: string;
    conversationId: string;
    message: ConversationMessage;
    timestampMs: number;
  }): Promise<void> {
    const k = this.key(args.tenantId, args.conversationId);
    let arr = this.store.get(k);
    if (!arr) {
      arr = [];
      this.store.set(k, arr);
    }
    arr.push({ message: args.message, timestampMs: args.timestampMs });
    while (arr.length > this.perCap) arr.shift();
  }

  async recent(args: {
    tenantId: string;
    conversationId: string;
    n: number;
  }): Promise<ReadonlyArray<{ message: ConversationMessage; timestampMs: number }>> {
    if (args.n <= 0) return [];
    const arr = this.store.get(this.key(args.tenantId, args.conversationId)) ?? [];
    return arr.slice(-args.n);
  }

  async byTimeRange(args: {
    tenantId: string;
    conversationId: string;
    fromMs: number;
    toMs: number;
  }): Promise<ReadonlyArray<{ message: ConversationMessage; timestampMs: number }>> {
    const arr = this.store.get(this.key(args.tenantId, args.conversationId)) ?? [];
    return arr.filter((e) => e.timestampMs >= args.fromMs && e.timestampMs <= args.toMs);
  }

  async delete(args: { tenantId: string; conversationId: string }): Promise<void> {
    this.store.delete(this.key(args.tenantId, args.conversationId));
  }

  /** Test helper. */
  size(tenantId: string, conversationId: string): number {
    return this.store.get(this.key(tenantId, conversationId))?.length ?? 0;
  }
}
