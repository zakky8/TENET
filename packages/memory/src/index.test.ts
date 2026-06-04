import type { ConversationMessage } from '@tenet/core';
import {
  WorkingMemory,
  InMemoryEpisodicMemory,
  InMemorySemanticMemory,
  type SemanticFact,
} from './index.js';

function msg(content: string): ConversationMessage {
  return { role: 'user', content };
}

describe('WorkingMemory', () => {
  it('rejects invalid construction', () => {
    expect(() => new WorkingMemory({ capacity: 0 })).toThrow();
    expect(() => new WorkingMemory({ tokenBudget: -1 })).toThrow();
  });

  it('appends and reads in order', () => {
    const w = new WorkingMemory({ capacity: 5 });
    w.append(msg('a'));
    w.append(msg('b'));
    expect(w.messages().map((m) => m.content)).toEqual(['a', 'b']);
  });

  it('caps at capacity (drops oldest)', () => {
    const w = new WorkingMemory({ capacity: 2 });
    w.append(msg('a'));
    w.append(msg('b'));
    w.append(msg('c'));
    expect(w.messages().map((m) => m.content)).toEqual(['b', 'c']);
  });

  it('respects tokenBudget when set', () => {
    const w = new WorkingMemory({ capacity: 100, tokenBudget: 10 });
    // ~5 chars each → ~2 tokens (5/4=2 rounded up) → 6 msgs = 12 tokens, over budget
    for (let i = 0; i < 6; i++) w.append(msg('hello'));
    // Should have dropped oldest to fit budget
    expect(w.size()).toBeLessThan(6);
  });

  it('clear empties the buffer', () => {
    const w = new WorkingMemory();
    w.append(msg('x'));
    w.clear();
    expect(w.size()).toBe(0);
  });
});

describe('InMemoryEpisodicMemory', () => {
  it('returns recent(n) in insertion order', async () => {
    const e = new InMemoryEpisodicMemory();
    const ctx = { tenantId: 'T', conversationId: 'C' };
    for (let i = 0; i < 5; i++) {
      await e.append({ ...ctx, message: msg(`m${i}`), timestampMs: i * 1000 });
    }
    const out = await e.recent({ ...ctx, n: 3 });
    expect(out.map((x) => x.message.content)).toEqual(['m2', 'm3', 'm4']);
  });

  it('filters byTimeRange inclusively', async () => {
    const e = new InMemoryEpisodicMemory();
    const ctx = { tenantId: 'T', conversationId: 'C' };
    await e.append({ ...ctx, message: msg('a'), timestampMs: 100 });
    await e.append({ ...ctx, message: msg('b'), timestampMs: 200 });
    await e.append({ ...ctx, message: msg('c'), timestampMs: 300 });
    const out = await e.byTimeRange({ ...ctx, fromMs: 150, toMs: 250 });
    expect(out.map((x) => x.message.content)).toEqual(['b']);
  });

  it('caps per-conversation history at perConversationCap', async () => {
    const e = new InMemoryEpisodicMemory({ perConversationCap: 3 });
    const ctx = { tenantId: 'T', conversationId: 'C' };
    for (let i = 0; i < 10; i++) {
      await e.append({ ...ctx, message: msg(`m${i}`), timestampMs: i });
    }
    expect(e.size('T', 'C')).toBe(3);
  });

  it('isolates conversations per (tenant, conversation)', async () => {
    const e = new InMemoryEpisodicMemory();
    await e.append({ tenantId: 'T1', conversationId: 'A', message: msg('x'), timestampMs: 1 });
    await e.append({ tenantId: 'T2', conversationId: 'A', message: msg('y'), timestampMs: 1 });
    const t1 = await e.recent({ tenantId: 'T1', conversationId: 'A', n: 10 });
    expect(t1.map((m) => m.message.content)).toEqual(['x']);
  });

  it('delete clears one conversation only', async () => {
    const e = new InMemoryEpisodicMemory();
    const a = { tenantId: 'T', conversationId: 'A' };
    const b = { tenantId: 'T', conversationId: 'B' };
    await e.append({ ...a, message: msg('a'), timestampMs: 1 });
    await e.append({ ...b, message: msg('b'), timestampMs: 1 });
    await e.delete(a);
    expect(e.size('T', 'A')).toBe(0);
    expect(e.size('T', 'B')).toBe(1);
  });
});

describe('InMemorySemanticMemory', () => {
  function fact(id: string, tenantId: string, extras: Partial<SemanticFact> = {}): SemanticFact {
    return {
      id,
      text: `fact-${id}`,
      tenantId,
      recordedAtMs: 0,
      confidence: 0.8,
      ...extras,
    };
  }

  it('rejects out-of-range confidence', async () => {
    const s = new InMemorySemanticMemory();
    await expect(s.upsert([fact('a', 'T', { confidence: 1.5 })])).rejects.toThrow();
    await expect(s.upsert([fact('a', 'T', { confidence: -0.1 })])).rejects.toThrow();
  });

  it('list filters by tenant strictly (cross-tenant isolation)', async () => {
    const s = new InMemorySemanticMemory();
    await s.upsert([fact('a', 'T1'), fact('b', 'T2')]);
    const t1 = await s.list({ tenantId: 'T1', limit: 10 });
    expect(t1.map((f) => f.id)).toEqual(['a']);
  });

  it('list filters by subjectId when provided', async () => {
    const s = new InMemorySemanticMemory();
    await s.upsert([
      fact('a', 'T', { subjectId: 'u1' }),
      fact('b', 'T', { subjectId: 'u2' }),
      fact('c', 'T'),
    ]);
    const u1 = await s.list({ tenantId: 'T', subjectId: 'u1', limit: 10 });
    expect(u1.map((f) => f.id)).toEqual(['a']);
  });

  it('list filters by anyLabel (OR semantics)', async () => {
    const s = new InMemorySemanticMemory();
    await s.upsert([
      fact('a', 'T', { labels: ['profile'] }),
      fact('b', 'T', { labels: ['preference'] }),
      fact('c', 'T', { labels: ['other'] }),
    ]);
    const out = await s.list({ tenantId: 'T', anyLabel: ['profile', 'preference'], limit: 10 });
    expect(out.map((f) => f.id).sort()).toEqual(['a', 'b']);
  });

  it('list sorts by confidence desc then recency desc', async () => {
    const s = new InMemorySemanticMemory();
    await s.upsert([
      fact('a', 'T', { confidence: 0.5, recordedAtMs: 100 }),
      fact('b', 'T', { confidence: 0.9, recordedAtMs: 50 }),
      fact('c', 'T', { confidence: 0.9, recordedAtMs: 60 }),
    ]);
    const out = await s.list({ tenantId: 'T', limit: 10 });
    expect(out.map((f) => f.id)).toEqual(['c', 'b', 'a']);
  });

  it('evicts lowest-confidence-then-oldest when perTenantCap exceeded', async () => {
    const s = new InMemorySemanticMemory({ perTenantCap: 2 });
    await s.upsert([
      fact('low', 'T', { confidence: 0.2, recordedAtMs: 100 }),
      fact('hi1', 'T', { confidence: 0.9, recordedAtMs: 50 }),
      fact('hi2', 'T', { confidence: 0.9, recordedAtMs: 60 }),
    ]);
    expect(s.size()).toBe(2);
    const out = await s.list({ tenantId: 'T', limit: 10 });
    expect(out.map((f) => f.id).sort()).toEqual(['hi1', 'hi2']);
  });

  it('delete removes by id', async () => {
    const s = new InMemorySemanticMemory();
    await s.upsert([fact('a', 'T'), fact('b', 'T')]);
    await s.delete(['a']);
    const out = await s.list({ tenantId: 'T', limit: 10 });
    expect(out.map((f) => f.id)).toEqual(['b']);
  });
});
