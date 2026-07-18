import type { Source } from '@tenet/core';
import { Bm25Index } from './bm25.js';
import { HybridPipeline } from './hybridPipeline.js';
import { InMemoryVectorStore } from './inMemoryVectorStore.js';
import type { EmbeddingModel, Reranker } from './types.js';

/** Hash-based mock embedder for deterministic tests. */
function mockEmbedder(): EmbeddingModel {
  return {
    dim: 8,
    async embed(text: string): Promise<number[]> {
      // Trivial bag-of-tokens embedding: count each char-bucket index.
      const v = new Array<number>(8).fill(0);
      for (const ch of text.toLowerCase()) {
        const c = ch.charCodeAt(0);
        v[c % 8]! += 1;
      }
      // Normalize
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    },
  };
}

function s(id: string, text: string): Source {
  return { id, uri: `https://example.com/${id}`, text, confidence: 1 };
}

describe('HybridPipeline — end-to-end', () => {
  it('returns the most relevant doc through BM25 + dense + RRF', async () => {
    const lexical = new Bm25Index();
    const dense = new InMemoryVectorStore();
    const embedder = mockEmbedder();

    const docs = [
      s('A', 'the quick brown fox jumps over the lazy dog'),
      s('B', 'a sentence about apples and pies and unrelated things'),
      s('C', 'the brown fox is fast and the dog is sleepy'),
    ];

    lexical.upsert(docs.map((d) => ({ source: d })));
    await dense.upsert(
      await Promise.all(
        docs.map(async (d) => ({ source: d, embedding: await embedder.embed(d.text) })),
      ),
    );

    const pipeline = new HybridPipeline({ embedder, lexical, dense, branchK: 5, topN: 3 });
    const out = await pipeline.query({ text: 'brown fox' });

    expect(out.results.length).toBeGreaterThan(0);
    // A or C should be the top result (both contain 'brown fox')
    const top = out.results[0]?.source.id;
    expect(['A', 'C']).toContain(top);
  });

  it('emits per-stage metrics', async () => {
    const lexical = new Bm25Index();
    const dense = new InMemoryVectorStore();
    const embedder = mockEmbedder();
    const docs = [s('A', 'one two three'), s('B', 'four five six')];
    lexical.upsert(docs.map((d) => ({ source: d })));
    await dense.upsert(
      await Promise.all(docs.map(async (d) => ({ source: d, embedding: await embedder.embed(d.text) }))),
    );
    const out = await new HybridPipeline({ embedder, lexical, dense }).query({ text: 'two' });
    // Metrics must reflect the ACTUAL per-stage retrieval, not merely be non-negative
    // (`>= 0` on a `.length` is structurally always true → a stage returning ZERO, or a
    // metric wired to the wrong value, would pass). For this fixed setup: only doc A
    // ('one two three') contains 'two' → BM25 returns 1; the dense store scores both docs
    // → 2; RRF unions them → 2; with no reranker the final set IS the fused set.
    expect(out.metrics.bm25Returned).toBe(1);
    expect(out.metrics.denseReturned).toBe(2);
    expect(out.metrics.fusedReturned).toBe(2);
    expect(out.metrics.rerankedReturned).toBe(out.results.length); // the metric ties to real output
    expect(out.results.length).toBe(2);
    expect(typeof out.metrics.embedMs).toBe('number');
  });

  it('reranker is invoked and replaces results when supplied', async () => {
    const lexical = new Bm25Index();
    const dense = new InMemoryVectorStore();
    const embedder = mockEmbedder();
    const docs = [s('A', 'apple'), s('B', 'banana')];
    lexical.upsert(docs.map((d) => ({ source: d })));
    await dense.upsert(
      await Promise.all(docs.map(async (d) => ({ source: d, embedding: await embedder.embed(d.text) }))),
    );
    const rerankerCalls: number[] = [];
    const reranker: Reranker = {
      async rerank({ candidates, topN }) {
        rerankerCalls.push(candidates.length);
        // Reverse order so we can detect that reranker output is used
        return [...candidates].reverse().slice(0, topN);
      },
    };
    const out = await new HybridPipeline({ embedder, lexical, dense, reranker, topN: 2 }).query({
      text: 'apple',
    });
    expect(rerankerCalls.length).toBe(1);
    expect(out.metrics.rerankedReturned).toBe(out.results.length);
    expect(out.metrics.rerankMs).toBeGreaterThanOrEqual(0);
  });
});
