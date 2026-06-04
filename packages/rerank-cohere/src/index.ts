/**
 * Cohere Rerank API adapter.
 *
 * Implements the Reranker contract that the hybrid retrieval pipeline
 * consumes — give it a query + N candidate documents, get back the
 * top-K reordered by relevance.
 *
 * No `cohere-ai` SDK hard dep — injectable fetch shape. Operators
 * who need a different provider (BGE-Reranker, Voyage Rerank,
 * Jina Reranker) ship a parallel adapter against the same shape.
 *
 * API ref: POST https://api.cohere.com/v2/rerank
 *   { model, query, documents: [{text}], top_n }
 *   → { results: [{index, relevance_score}] }
 */

export interface RerankCandidate {
  /** Caller-owned id; passed through to the result. */
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  /** Cohere relevance score in [0,1]. */
  score: number;
  /** Original index in the candidates array. */
  index: number;
}

export interface RerankerFetch {
  fetch(input: string, init: {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string> }>;
}

export interface CohereRerankerOptions {
  apiKey: string;
  /** Model id, e.g. 'rerank-v3.5'. */
  model: string;
  /** Default top_n if rerank() caller doesn't supply one. */
  defaultTopN?: number;
  /** Base URL. Default 'https://api.cohere.com'. */
  baseUrl?: string;
}

export class CohereRerankerError extends Error {
  constructor(
    public readonly code: 'http_error' | 'invalid_response' | 'no_candidates' | 'invalid_top_n',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CohereRerankerError';
  }
}

export class CohereReranker {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultTopN: number;
  private readonly baseUrl: string;

  constructor(
    private readonly http: RerankerFetch,
    opts: CohereRerankerOptions,
  ) {
    if (!opts.apiKey) throw new Error('CohereReranker: apiKey required');
    if (!opts.model) throw new Error('CohereReranker: model required');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.defaultTopN = opts.defaultTopN ?? 10;
    this.baseUrl = (opts.baseUrl ?? 'https://api.cohere.com').replace(/\/+$/, '');
  }

  async rerank(args: {
    query: string;
    candidates: ReadonlyArray<RerankCandidate>;
    topN?: number;
    signal?: AbortSignal;
  }): Promise<ReadonlyArray<RerankResult>> {
    if (args.candidates.length === 0) {
      throw new CohereRerankerError('no_candidates', 'candidates is empty');
    }
    const topN = args.topN ?? this.defaultTopN;
    if (topN <= 0) {
      throw new CohereRerankerError('invalid_top_n', `topN must be > 0, got ${topN}`);
    }
    const requested = Math.min(topN, args.candidates.length);

    const body = JSON.stringify({
      model: this.model,
      query: args.query,
      documents: args.candidates.map((c) => ({ text: c.text })),
      top_n: requested,
    });

    const res = await this.http.fetch(`${this.baseUrl}/v2/rerank`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body,
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    });

    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new CohereRerankerError('http_error', `Cohere returned ${res.status}: ${text.slice(0, 200)}`, res.status);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new CohereRerankerError('invalid_response', `not JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new CohereRerankerError('invalid_response', 'not an object');
    }
    const results = (parsed as { results?: unknown }).results;
    if (!Array.isArray(results)) {
      throw new CohereRerankerError('invalid_response', 'results is not an array');
    }

    const out: RerankResult[] = [];
    for (const r of results) {
      if (!r || typeof r !== 'object') continue;
      const idx = (r as { index?: unknown }).index;
      const score = (r as { relevance_score?: unknown }).relevance_score;
      if (typeof idx !== 'number' || typeof score !== 'number') continue;
      const cand = args.candidates[idx];
      if (!cand) continue;
      out.push({ id: cand.id, index: idx, score });
    }
    return out;
  }
}

export const VERSION = '0.0.0';
