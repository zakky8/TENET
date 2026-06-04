import { QdrantVectorStore, QdrantError, type QdrantHttp } from './index.js';

type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

function mockHttp(reply: { status: number; body: string }, capture: Call[] = []): QdrantHttp {
  return {
    async fetch(url, init) {
      capture.push({ url, init });
      return {
        status: reply.status,
        async text() {
          return reply.body;
        },
      };
    },
  };
}

const SEARCH_OK = JSON.stringify({
  result: [
    {
      id: 'a',
      score: 0.91,
      payload: { uri: 'u', text: 'hello', confidence: 0.9, lang: 'en', tenant_id: 'T' },
    },
  ],
});

describe('QdrantVectorStore — construction', () => {
  it('rejects invalid collectionName', () => {
    expect(() => new QdrantVectorStore(mockHttp({ status: 200, body: '{}' }), { collectionName: 'foo;DROP' })).toThrow();
    expect(() => new QdrantVectorStore(mockHttp({ status: 200, body: '{}' }), { collectionName: '' })).toThrow();
    expect(() => new QdrantVectorStore(mockHttp({ status: 200, body: '{}' }), { collectionName: 'a b' })).toThrow();
  });
  it('accepts valid name', () => {
    expect(() => new QdrantVectorStore(mockHttp({ status: 200, body: '{}' }), { collectionName: 'tenet_vectors' })).not.toThrow();
  });
});

describe('QdrantVectorStore — upsert', () => {
  it('PUTs /collections/X/points with mapped payload', async () => {
    const calls: Call[] = [];
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: '{"result":{"status":"ok"}}' }, calls), { collectionName: 'c' });
    await s.upsert([
      {
        source: { id: '1', uri: 'u', text: 't', confidence: 0.8, metadata: { lang: 'en' } },
        embedding: [0.1, 0.2],
        tenantId: 'T',
      },
    ]);
    expect(calls[0]!.url).toContain('/collections/c/points');
    expect(calls[0]!.init.method).toBe('PUT');
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.points[0].id).toBe('1');
    expect(body.points[0].vector).toEqual([0.1, 0.2]);
    expect(body.points[0].payload.tenant_id).toBe('T');
    expect(body.points[0].payload.lang).toBe('en');
  });
  it('noop on empty input', async () => {
    const calls: Call[] = [];
    await new QdrantVectorStore(mockHttp({ status: 200, body: '{}' }, calls), { collectionName: 'c' }).upsert([]);
    expect(calls).toHaveLength(0);
  });
  it('throws QdrantError on non-2xx', async () => {
    const s = new QdrantVectorStore(mockHttp({ status: 500, body: 'down' }), { collectionName: 'c' });
    await expect(s.upsert([{ source: { id: '1', uri: 'u', text: 't', confidence: 1 }, embedding: [0] }])).rejects.toBeInstanceOf(QdrantError);
  });
});

describe('QdrantVectorStore — query', () => {
  it('POSTs /points/search with vector + limit + with_payload', async () => {
    const calls: Call[] = [];
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: SEARCH_OK }, calls), { collectionName: 'c' });
    await s.query({ embedding: [1, 0], k: 5 });
    expect(calls[0]!.url).toContain('/collections/c/points/search');
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.vector).toEqual([1, 0]);
    expect(body.limit).toBe(5);
    expect(body.with_payload).toBe(true);
    expect(body.filter).toBeUndefined();
  });

  it('emits filter.must when tenantId provided', async () => {
    const calls: Call[] = [];
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: SEARCH_OK }, calls), { collectionName: 'c' });
    await s.query({ embedding: [1, 0], k: 5, tenantId: 'T1' });
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.filter.must).toEqual([{ key: 'tenant_id', match: { value: 'T1' } }]);
  });

  it('emits filter.must for arbitrary filter kv pairs (with key validation)', async () => {
    const calls: Call[] = [];
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: SEARCH_OK }, calls), { collectionName: 'c' });
    await s.query({ embedding: [1, 0], k: 5, filter: { lang: 'en' } });
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.filter.must.some((c: { key: string }) => c.key === 'lang')).toBe(true);
  });

  it('rejects SQL-injection-style filter keys via validateFilterKey', async () => {
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: SEARCH_OK }), { collectionName: 'c' });
    await expect(s.query({ embedding: [1, 0], k: 5, filter: { "'; DROP": 'x' } })).rejects.toThrow(/Invalid filter key/);
  });

  it('returns parsed ScoredSource records, stripping reserved keys from metadata', async () => {
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: SEARCH_OK }), { collectionName: 'c' });
    const out = await s.query({ embedding: [1, 0], k: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]!.source.id).toBe('a');
    expect(out[0]!.score).toBeCloseTo(0.91);
    // Reserved payload keys (uri/text/confidence/tenant_id) NOT in metadata
    expect(out[0]!.source.metadata?.tenant_id).toBeUndefined();
    expect(out[0]!.source.metadata?.uri).toBeUndefined();
    expect(out[0]!.source.metadata?.lang).toBe('en');
  });

  it('returns [] for k <= 0 without calling http', async () => {
    const calls: Call[] = [];
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: SEARCH_OK }, calls), { collectionName: 'c' });
    const out = await s.query({ embedding: [1, 0], k: 0 });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('throws AbortError if signal already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: SEARCH_OK }), { collectionName: 'c' });
    await expect(s.query({ embedding: [1, 0], k: 1, signal: ctrl.signal })).rejects.toThrow();
  });
});

describe('QdrantVectorStore — delete', () => {
  it('POSTs /points/delete with array of ids', async () => {
    const calls: Call[] = [];
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: '{}' }, calls), { collectionName: 'c' });
    await s.delete(['a', 'b']);
    expect(calls[0]!.url).toContain('/collections/c/points/delete');
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ points: ['a', 'b'] });
  });
});

describe('QdrantVectorStore — api-key header', () => {
  it('sets api-key header when provided', async () => {
    const calls: Call[] = [];
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: SEARCH_OK }, calls), { collectionName: 'c', apiKey: 'qd-secret' });
    await s.query({ embedding: [1, 0], k: 1 });
    expect(calls[0]!.init.headers['api-key']).toBe('qd-secret');
  });

  it('does NOT set api-key header when absent', async () => {
    const calls: Call[] = [];
    const s = new QdrantVectorStore(mockHttp({ status: 200, body: SEARCH_OK }, calls), { collectionName: 'c' });
    await s.query({ embedding: [1, 0], k: 1 });
    expect(calls[0]!.init.headers['api-key']).toBeUndefined();
  });
});
