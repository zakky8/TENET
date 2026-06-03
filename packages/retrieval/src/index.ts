/**
 * TENET retrieval.
 *
 * Hybrid pipeline (per Anthropic Contextual Retrieval benchmark — 35/49/67% failure reductions):
 *   1. Chunker (semantic, 200-400 tokens)
 *   2. Contextualizer (LLM prepends 50-100 token chunk-context string)
 *   3. Parallel index: BM25 lexical + HNSW dense
 *   4. Query: parallel top-K from each, fused via RRF
 *   5. Cross-encoder rerank → top-N to context window
 *
 * Per-stage metrics emitted to @tenet/telemetry.
 * Pluggable vector store (default: pgvector).
 *
 * See docs/ARCHITECTURE.md §8.
 */

export const VERSION = '0.0.0';
