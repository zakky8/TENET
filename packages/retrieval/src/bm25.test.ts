import type { Source } from '@tenet/core';
import { Bm25Index } from './bm25.js';

function src(id: string, text: string, tenantId?: string): { source: Source; tenantId?: string } {
  return { source: { id, uri: `https://example.com/${id}`, text, confidence: 1 }, tenantId };
}

describe('Bm25Index — basics', () => {
  it('rejects invalid options', () => {
    expect(() => new Bm25Index({ b: -1 })).toThrow();
    expect(() => new Bm25Index({ b: 2 })).toThrow();
    expect(() => new Bm25Index({ k1: 0 })).toThrow();
  });

  it('returns [] when index is empty', () => {
    const idx = new Bm25Index();
    expect(idx.query({ text: 'anything', k: 10 })).toEqual([]);
  });

  it('returns the matching doc with a positive score', () => {
    const idx = new Bm25Index();
    idx.upsert([
      src('A', 'the quick brown fox jumps over the lazy dog'),
      src('B', 'a totally unrelated sentence about pies'),
    ]);
    const out = idx.query({ text: 'brown fox', k: 5 });
    expect(out[0]?.source.id).toBe('A');
    expect(out[0]?.score).toBeGreaterThan(0);
  });

  it('ranks higher when more query terms match', () => {
    const idx = new Bm25Index();
    idx.upsert([
      src('A', 'the quick brown fox'),
      src('B', 'the quick brown fox jumps high'),
      src('C', 'something else entirely'),
    ]);
    const out = idx.query({ text: 'quick brown fox jumps', k: 5 });
    expect(out[0]?.source.id).toBe('B');
  });
});

describe('Bm25Index — upsert + replacement', () => {
  it('replaces an existing doc by id and updates doc-freq stats', () => {
    const idx = new Bm25Index();
    idx.upsert([src('A', 'apple banana cherry')]);
    idx.upsert([src('A', 'completely different words now')]);
    // Old terms should no longer match
    const out = idx.query({ text: 'apple', k: 5 });
    expect(out).toEqual([]);
    // New terms should
    const out2 = idx.query({ text: 'completely different', k: 5 });
    expect(out2[0]?.source.id).toBe('A');
  });
});

describe('Bm25Index — tenant scoping', () => {
  it('only returns docs for the requested tenant', () => {
    const idx = new Bm25Index();
    idx.upsert([
      src('A', 'shared keyword here', 'T1'),
      src('B', 'shared keyword here', 'T2'),
    ]);
    const t1 = idx.query({ text: 'shared keyword', k: 5, tenantId: 'T1' });
    expect(t1.length).toBe(1);
    expect(t1[0]?.source.id).toBe('A');
  });
});
