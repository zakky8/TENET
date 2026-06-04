import type { Source } from '@tenet/core';
import { InMemoryVectorStore } from './inMemoryVectorStore.js';

function src(id: string, text = 'sample'): Source {
  return { id, uri: `https://example.com/${id}`, text, confidence: 1 };
}

describe('InMemoryVectorStore — upsert + query', () => {
  it('ranks by cosine similarity', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([
      { source: src('A'), embedding: [1, 0, 0] },
      { source: src('B'), embedding: [0, 1, 0] },
      { source: src('C'), embedding: [1, 1, 0] },
    ]);
    const out = await s.query({ embedding: [1, 0, 0], k: 3 });
    expect(out[0]?.source.id).toBe('A');
    expect(out[1]?.source.id).toBe('C'); // 45° = ~0.707
    expect(out[2]?.source.id).toBe('B'); // orthogonal = 0
  });

  it('respects k', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([
      { source: src('A'), embedding: [1, 0] },
      { source: src('B'), embedding: [1, 0] },
      { source: src('C'), embedding: [1, 0] },
    ]);
    const out = await s.query({ embedding: [1, 0], k: 2 });
    expect(out).toHaveLength(2);
  });
});

describe('InMemoryVectorStore — tenant + filter scoping', () => {
  it('filters by tenantId', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([
      { source: src('A'), embedding: [1, 0], tenantId: 'T1' },
      { source: src('B'), embedding: [1, 0], tenantId: 'T2' },
    ]);
    const out = await s.query({ embedding: [1, 0], k: 10, tenantId: 'T1' });
    expect(out.map((r) => r.source.id)).toEqual(['A']);
  });

  it('filters by metadata kv', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([
      {
        source: { ...src('A'), metadata: { lang: 'en' } },
        embedding: [1, 0],
      },
      {
        source: { ...src('B'), metadata: { lang: 'es' } },
        embedding: [1, 0],
      },
    ]);
    const out = await s.query({ embedding: [1, 0], k: 10, filter: { lang: 'en' } });
    expect(out.map((r) => r.source.id)).toEqual(['A']);
  });
});

describe('InMemoryVectorStore — delete + AbortSignal', () => {
  it('removes by id', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert([{ source: src('A'), embedding: [1, 0] }]);
    await s.delete(['A']);
    expect(s.size()).toBe(0);
  });

  it('throws AbortError if signal is already aborted', async () => {
    const s = new InMemoryVectorStore();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(s.query({ embedding: [1, 0], k: 1, signal: ctrl.signal })).rejects.toThrow();
  });
});
