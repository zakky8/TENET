import type { Source } from '@tenet/core';

/** A scored retrieval result. Score semantics depend on the producer. */
export interface ScoredSource {
  source: Source;
  /** Producer-specific score. BM25 ≈ unbounded positive; cosine in [-1,1]; rerank in [0,1]. */
  score: number;
}

/** Maps text to a dense embedding vector. */
export interface EmbeddingModel {
  /** Embed a single query string. */
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  /** Optional: batch embed for ingestion. Default impl loops over embed(). */
  embedBatch?(texts: ReadonlyArray<string>, signal?: AbortSignal): Promise<ReadonlyArray<number[]>>;
  /** Dimensionality; used for store-config validation. */
  dim: number;
}

/** Persistent dense-vector index. */
export interface VectorStore {
  /** Insert / replace a batch. */
  upsert(records: ReadonlyArray<VectorRecord>): Promise<void>;
  /** Top-K cosine query. */
  query(args: {
    embedding: number[];
    k: number;
    tenantId?: string;
    filter?: Readonly<Record<string, string | number | boolean>>;
    signal?: AbortSignal;
  }): Promise<ReadonlyArray<ScoredSource>>;
  /** Remove records by id. */
  delete(ids: ReadonlyArray<string>): Promise<void>;
}

export interface VectorRecord {
  source: Source;
  embedding: number[];
  tenantId?: string;
}

/** Cross-encoder / LLM-as-judge reranker. */
export interface Reranker {
  rerank(args: {
    query: string;
    candidates: ReadonlyArray<ScoredSource>;
    topN: number;
    signal?: AbortSignal;
  }): Promise<ReadonlyArray<ScoredSource>>;
}

/** BM25-style lexical scorer over an in-memory corpus. */
export interface LexicalScorer {
  upsert(records: ReadonlyArray<{ source: Source; tenantId?: string }>): void;
  query(args: {
    text: string;
    k: number;
    tenantId?: string;
  }): ReadonlyArray<ScoredSource>;
}
