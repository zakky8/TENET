import { CohereReranker, CohereRerankerError, type RerankerFetch } from './index.js';

function mockHttp(status: number, body: unknown): { http: RerankerFetch; calls: Array<{ url: string; body: string; headers: Readonly<Record<string, string>> }> } {
  const calls: Array<{ url: string; body: string; headers: Readonly<Record<string, string>> }> = [];
  return {
    http: {
      async fetch(url, init) {
        calls.push({ url, body: init.body, headers: init.headers });
        return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
      },
    },
    calls,
  };
}

const CANDIDATES = [
  { id: 'a', text: 'paris france' },
  { id: 'b', text: 'london uk' },
  { id: 'c', text: 'tokyo japan' },
];

describe('CohereReranker — construction', () => {
  it('requires apiKey + model', () => {
    const { http } = mockHttp(200, { results: [] });
    expect(() => new CohereReranker(http, { apiKey: '', model: 'm' })).toThrow();
    expect(() => new CohereReranker(http, { apiKey: 'k', model: '' })).toThrow();
  });
});

describe('CohereReranker.rerank', () => {
  it('throws no_candidates on empty input', async () => {
    const { http } = mockHttp(200, { results: [] });
    const r = new CohereReranker(http, { apiKey: 'k', model: 'rerank-v3.5' });
    await expect(r.rerank({ query: 'q', candidates: [] })).rejects.toMatchObject({ code: 'no_candidates' });
  });

  it('throws invalid_top_n on topN <= 0', async () => {
    const { http } = mockHttp(200, { results: [] });
    const r = new CohereReranker(http, { apiKey: 'k', model: 'rerank-v3.5' });
    await expect(r.rerank({ query: 'q', candidates: CANDIDATES, topN: 0 })).rejects.toMatchObject({ code: 'invalid_top_n' });
  });

  it('sends authorization + content-type headers + bearer key', async () => {
    const { http, calls } = mockHttp(200, { results: [] });
    const r = new CohereReranker(http, { apiKey: 'sk-test', model: 'rerank-v3.5' });
    await r.rerank({ query: 'q', candidates: CANDIDATES });
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-test');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
  });

  it('sends model + query + documents + top_n', async () => {
    const { http, calls } = mockHttp(200, { results: [] });
    const r = new CohereReranker(http, { apiKey: 'k', model: 'rerank-v3.5' });
    await r.rerank({ query: 'capital of france', candidates: CANDIDATES, topN: 2 });
    const sent = JSON.parse(calls[0]!.body);
    expect(sent.model).toBe('rerank-v3.5');
    expect(sent.query).toBe('capital of france');
    expect(sent.documents).toEqual([{ text: 'paris france' }, { text: 'london uk' }, { text: 'tokyo japan' }]);
    expect(sent.top_n).toBe(2);
  });

  it('clamps top_n to candidates.length', async () => {
    const { http, calls } = mockHttp(200, { results: [] });
    const r = new CohereReranker(http, { apiKey: 'k', model: 'rerank-v3.5' });
    await r.rerank({ query: 'q', candidates: CANDIDATES, topN: 100 });
    expect(JSON.parse(calls[0]!.body).top_n).toBe(3);
  });

  it('returns parsed results keyed back to candidate ids', async () => {
    const { http } = mockHttp(200, {
      results: [
        { index: 0, relevance_score: 0.95 },
        { index: 2, relevance_score: 0.6 },
      ],
    });
    const r = new CohereReranker(http, { apiKey: 'k', model: 'rerank-v3.5' });
    const out = await r.rerank({ query: 'q', candidates: CANDIDATES });
    expect(out).toEqual([
      { id: 'a', index: 0, score: 0.95 },
      { id: 'c', index: 2, score: 0.6 },
    ]);
  });

  it('translates non-2xx to http_error with status', async () => {
    const { http } = mockHttp(401, 'unauthorized');
    const r = new CohereReranker(http, { apiKey: 'k', model: 'rerank-v3.5' });
    await expect(r.rerank({ query: 'q', candidates: CANDIDATES })).rejects.toMatchObject({ code: 'http_error', status: 401 });
  });

  it('translates non-JSON to invalid_response', async () => {
    const { http } = mockHttp(200, 'not json');
    const r = new CohereReranker(http, { apiKey: 'k', model: 'rerank-v3.5' });
    await expect(r.rerank({ query: 'q', candidates: CANDIDATES })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('drops malformed result entries silently', async () => {
    const { http } = mockHttp(200, {
      results: [
        { index: 0, relevance_score: 0.9 },
        { index: 'wrong', relevance_score: 0.5 },
        null,
        { index: 99, relevance_score: 0.4 }, // out-of-range
      ],
    });
    const r = new CohereReranker(http, { apiKey: 'k', model: 'rerank-v3.5' });
    const out = await r.rerank({ query: 'q', candidates: CANDIDATES });
    expect(out).toEqual([{ id: 'a', index: 0, score: 0.9 }]);
  });
});
