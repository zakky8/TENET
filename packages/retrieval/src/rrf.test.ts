import type { Source } from '@tenet/core';
import { reciprocalRankFusion } from './rrf.js';

function s(id: string): Source {
  return { id, uri: `https://example.com/${id}`, text: id, confidence: 1 };
}

describe('reciprocalRankFusion', () => {
  it('fuses two ranked lists', () => {
    const list1 = [{ source: s('A'), score: 10 }, { source: s('B'), score: 5 }];
    const list2 = [{ source: s('B'), score: 0.9 }, { source: s('C'), score: 0.5 }];
    const out = reciprocalRankFusion([list1, list2]);
    // B appears in both at rank 2 + rank 1 → highest combined score
    expect(out[0]?.source.id).toBe('B');
  });

  it('handles empty lists', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[]])).toEqual([]);
  });

  it('respects limit', () => {
    const list1 = [
      { source: s('A'), score: 1 },
      { source: s('B'), score: 1 },
      { source: s('C'), score: 1 },
    ];
    const out = reciprocalRankFusion([list1], { limit: 2 });
    expect(out).toHaveLength(2);
  });

  it('higher rank (lower index) gets larger RRF contribution', () => {
    const list = [
      { source: s('A'), score: 1 },
      { source: s('B'), score: 1 },
    ];
    const out = reciprocalRankFusion([list]);
    expect(out[0]?.source.id).toBe('A');
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
  });

  it('rejects k <= 0', () => {
    expect(() => reciprocalRankFusion([[]], { k: 0 })).toThrow();
  });
});
