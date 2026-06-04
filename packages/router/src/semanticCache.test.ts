import { InMemorySemanticAnswerCache } from './semanticCache.js';

describe('InMemorySemanticAnswerCache — construction', () => {
  it('rejects invalid options', () => {
    expect(() => new InMemorySemanticAnswerCache({ maxEntries: 0 })).toThrow();
    expect(() => new InMemorySemanticAnswerCache({ defaultMinSimilarity: -0.1 })).toThrow();
    expect(() => new InMemorySemanticAnswerCache({ defaultMinSimilarity: 1.1 })).toThrow();
  });
});

describe('InMemorySemanticAnswerCache — lookup', () => {
  it('returns null on empty cache', async () => {
    const c = new InMemorySemanticAnswerCache();
    expect(await c.lookup({ text: 'q', embedding: [1, 0] })).toBeNull();
  });

  it('returns hit when similarity exceeds threshold', async () => {
    const c = new InMemorySemanticAnswerCache({ defaultMinSimilarity: 0.5 });
    await c.store({ text: 'q', embedding: [1, 0], answer: 'A' });
    const h = await c.lookup({ text: 'q\'', embedding: [0.95, 0.31] });
    expect(h?.answer).toBe('A');
    expect(h!.similarity).toBeGreaterThan(0.9);
  });

  it('returns null when similarity below threshold', async () => {
    const c = new InMemorySemanticAnswerCache({ defaultMinSimilarity: 0.99 });
    await c.store({ text: 'q', embedding: [1, 0], answer: 'A' });
    expect(await c.lookup({ text: 'q\'', embedding: [0, 1] })).toBeNull();
  });

  it('picks the highest-similarity entry across multiple stored', async () => {
    const c = new InMemorySemanticAnswerCache({ defaultMinSimilarity: 0.5 });
    await c.store({ text: 'q1', embedding: [1, 0], answer: 'A' });
    await c.store({ text: 'q2', embedding: [0.5, 0.86], answer: 'B' });
    const h = await c.lookup({ text: 'q', embedding: [1, 0] });
    expect(h?.answer).toBe('A');
  });
});

describe('InMemorySemanticAnswerCache — store + evict', () => {
  it('evicts LRU when maxEntries exceeded', async () => {
    const c = new InMemorySemanticAnswerCache({ maxEntries: 2 });
    await c.store({ text: 'q1', embedding: [1, 0], answer: 'A' });
    await c.store({ text: 'q2', embedding: [0, 1], answer: 'B' });
    await c.store({ text: 'q3', embedding: [1, 1], answer: 'C' });
    expect(c.size()).toBe(2);
  });

  it('evict by text removes the entry', async () => {
    const c = new InMemorySemanticAnswerCache();
    await c.store({ text: 'q', embedding: [1, 0], answer: 'A' });
    await c.evict('q');
    expect(c.size()).toBe(0);
  });
});
