import type {
  EmbeddingModel,
  LexicalScorer,
  Reranker,
  ScoredSource,
  VectorStore,
} from './types.js';
import { reciprocalRankFusion } from './rrf.js';

export interface HybridPipelineOptions {
  embedder: EmbeddingModel;
  lexical: LexicalScorer;
  dense: VectorStore;
  /** Optional reranker for the final stage. */
  reranker?: Reranker;
  /** Top-K from each retrieval branch. Default 50. */
  branchK?: number;
  /** Top-N after fusion (and rerank, if enabled). Default 10. */
  topN?: number;
  /** RRF k. Default 60. */
  rrfK?: number;
}

export interface HybridQueryResult {
  results: ReadonlyArray<ScoredSource>;
  metrics: {
    bm25Returned: number;
    denseReturned: number;
    fusedReturned: number;
    rerankedReturned: number;
    embedMs: number;
    denseMs: number;
    bm25Ms: number;
    fuseMs: number;
    rerankMs: number;
  };
}

/**
 * Hybrid retrieval — runs BM25 + dense in parallel, fuses via RRF,
 * optionally reranks, emits per-stage metrics.
 *
 * Follows the Anthropic Contextual Retrieval recipe (BM25 + dense
 * + rerank) from the BENCHMARKS.md reference. The contextual chunk
 * prepending step happens at ingestion time before upsert (out of
 * scope for this module; lives in the ingestion pipeline).
 */
export class HybridPipeline {
  constructor(private readonly opts: HybridPipelineOptions) {
    if ((opts.branchK ?? 50) <= 0) throw new Error('HybridPipeline: branchK must be > 0');
    if ((opts.topN ?? 10) <= 0) throw new Error('HybridPipeline: topN must be > 0');
  }

  async query(args: {
    text: string;
    tenantId?: string;
    signal?: AbortSignal;
  }): Promise<HybridQueryResult> {
    const branchK = this.opts.branchK ?? 50;
    const topN = this.opts.topN ?? 10;
    const rrfK = this.opts.rrfK ?? 60;

    const tEmbedStart = perfNow();
    const queryEmbedding = await this.opts.embedder.embed(args.text, args.signal);
    const embedMs = perfNow() - tEmbedStart;

    const tBm25Start = perfNow();
    const bm25 = this.opts.lexical.query({
      text: args.text,
      k: branchK,
      ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
    });
    const bm25Ms = perfNow() - tBm25Start;

    const tDenseStart = perfNow();
    const dense = await this.opts.dense.query({
      embedding: queryEmbedding,
      k: branchK,
      ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });
    const denseMs = perfNow() - tDenseStart;

    const tFuseStart = perfNow();
    const fused = reciprocalRankFusion([bm25, dense], { k: rrfK, limit: branchK });
    const fuseMs = perfNow() - tFuseStart;

    let final: ReadonlyArray<ScoredSource> = fused.slice(0, topN);
    let rerankMs = 0;
    if (this.opts.reranker && fused.length > 0) {
      const tRerankStart = perfNow();
      final = await this.opts.reranker.rerank({
        query: args.text,
        candidates: fused,
        topN,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
      rerankMs = perfNow() - tRerankStart;
    }

    return {
      results: final,
      metrics: {
        bm25Returned: bm25.length,
        denseReturned: dense.length,
        fusedReturned: fused.length,
        rerankedReturned: final.length,
        embedMs,
        denseMs,
        bm25Ms,
        fuseMs,
        rerankMs,
      },
    };
  }
}

function perfNow(): number {
  // High-resolution time when available; falls back to Date.now in older runtimes.
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
