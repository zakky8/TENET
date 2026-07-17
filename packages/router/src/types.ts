/** Decision returned by an intent classifier — drives cheap/flagship routing. */
export interface RouteDecision {
  /** Stable id for this tier (e.g. 'cheap', 'flagship'). */
  tier: string;
  /** Confidence in [0,1]. Low confidence → fallback to flagship. */
  confidence: number;
  /** Human-readable reason for logs / debugging. */
  reason?: string;
}

/** Pluggable classifier that maps an input to a tier. */
export interface RouteClassifier {
  classify(args: { text: string; intent?: string; signal?: AbortSignal }): Promise<RouteDecision>;
}

/** Generic chat-style model the router invokes — the canonical @tenet/core ChatModel. */
export type { ChatModel as RouterChatModel } from '@tenet/core';

/** Semantic answer-cache lookup result. */
export interface CacheHit {
  /** Cached answer text. */
  answer: string;
  /** Similarity score between this and the cached query in [0,1]. */
  similarity: number;
  /** Cached at (wall-clock ms). */
  cachedAtMs: number;
}

export interface SemanticAnswerCache {
  /** Try to find a cached answer for a query. Returns null on miss. */
  lookup(args: {
    text: string;
    embedding: number[];
    minSimilarity?: number;
  }): Promise<CacheHit | null>;
  /** Store a verified answer for future hits. */
  store(args: {
    text: string;
    embedding: number[];
    answer: string;
    timestampMs?: number;
  }): Promise<void>;
  /** Evict by source text. */
  evict(text: string): Promise<void>;
}
