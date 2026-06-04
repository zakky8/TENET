import {
  ExternalMemoryAdapter,
  mem0Provider,
  lettaProvider,
  zepProvider,
  type MemoryHttp,
} from './index.js';
import type { SemanticFact } from '@tenet/memory';

type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

function mockHttp(reply: { status: number; body: string }, calls: Call[] = []): MemoryHttp {
  return {
    async fetch(url, init) {
      calls.push({ url, init });
      return { status: reply.status, async text() { return reply.body; } };
    },
  };
}

function fact(extras: Partial<SemanticFact> = {}): SemanticFact {
  return {
    id: 'f1',
    text: 'fact text',
    tenantId: 'T1',
    recordedAtMs: 1000,
    confidence: 0.9,
    ...extras,
  };
}

describe('ExternalMemoryAdapter — confidence validation', () => {
  const provider = mem0Provider(mockHttp({ status: 200, body: '{}' }), { apiKey: 'k' });
  const adapter = new ExternalMemoryAdapter(provider);

  it('rejects upsert when confidence out of [0,1]', async () => {
    await expect(adapter.upsert([fact({ confidence: -0.1 })])).rejects.toThrow();
    await expect(adapter.upsert([fact({ confidence: 1.1 })])).rejects.toThrow();
  });

  it('exposes providerName for telemetry', () => {
    expect(adapter.providerName()).toBe('mem0');
  });
});

describe('mem0Provider', () => {
  it('requires apiKey', () => {
    expect(() => mem0Provider(mockHttp({ status: 200, body: '{}' }), { apiKey: '' })).toThrow();
  });

  it('POSTs /v1/memories with Token header', async () => {
    const calls: Call[] = [];
    const p = mem0Provider(mockHttp({ status: 200, body: '{}' }, calls), { apiKey: 'mem0-sk' });
    await p.upsert([fact({ subjectId: 'u1', labels: ['profile'] })]);
    expect(calls[0]!.url).toContain('/v1/memories');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers.Authorization).toBe('Token mem0-sk');
    const body = JSON.parse(calls[0]!.init.body!);
    expect(body.memories[0].metadata.tenant_id).toBe('T1');
    expect(body.memories[0].metadata.labels).toEqual(['profile']);
  });

  it('list filters by tenant_id on the client', async () => {
    const responseBody = JSON.stringify({
      memories: [
        { memory_id: 'A', memory: 'one', metadata: { tenant_id: 'T1', recorded_at: 1, confidence: 1 } },
        { memory_id: 'B', memory: 'two', metadata: { tenant_id: 'OTHER', recorded_at: 1, confidence: 1 } },
      ],
    });
    const p = mem0Provider(mockHttp({ status: 200, body: responseBody }), { apiKey: 'k' });
    const out = await p.list({ tenantId: 'T1', limit: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('A');
  });

  it('delete sends DELETE per id', async () => {
    const calls: Call[] = [];
    const p = mem0Provider(mockHttp({ status: 200, body: '{}' }, calls), { apiKey: 'k' });
    await p.delete(['a', 'b']);
    expect(calls.map((c) => c.init.method)).toEqual(['DELETE', 'DELETE']);
  });
});

describe('lettaProvider', () => {
  it('requires apiKey + agentId', () => {
    const h = mockHttp({ status: 200, body: '{}' });
    expect(() => lettaProvider(h, { apiKey: '', agentId: 'a' })).toThrow();
    expect(() => lettaProvider(h, { apiKey: 'k', agentId: '' })).toThrow();
  });

  it('POSTs /v1/agents/{id}/archival-memory with Bearer header', async () => {
    const calls: Call[] = [];
    const p = lettaProvider(mockHttp({ status: 200, body: '{}' }, calls), { apiKey: 'k', agentId: 'AG-1' });
    await p.upsert([fact()]);
    expect(calls[0]!.url).toContain('/v1/agents/AG-1/archival-memory');
    expect(calls[0]!.init.headers.Authorization).toBe('Bearer k');
  });

  it('list filters by tenant_id AND subject_id on the client', async () => {
    const responseBody = JSON.stringify({
      items: [
        { id: 'a', text: 'x', metadata: { tenant_id: 'T1', subject_id: 'u1', recorded_at: 0, confidence: 1 } },
        { id: 'b', text: 'y', metadata: { tenant_id: 'T1', subject_id: 'u2', recorded_at: 0, confidence: 1 } },
        { id: 'c', text: 'z', metadata: { tenant_id: 'OTHER', subject_id: 'u1', recorded_at: 0, confidence: 1 } },
      ],
    });
    const p = lettaProvider(mockHttp({ status: 200, body: responseBody }), { apiKey: 'k', agentId: 'a' });
    const out = await p.list({ tenantId: 'T1', subjectId: 'u1', limit: 10 });
    expect(out.map((f) => f.id)).toEqual(['a']);
  });
});

describe('zepProvider', () => {
  it('requires apiKey', () => {
    expect(() => zepProvider(mockHttp({ status: 200, body: '{}' }), { apiKey: '' })).toThrow();
  });

  it('POSTs /v3/facts with Api-Key header', async () => {
    const calls: Call[] = [];
    const p = zepProvider(mockHttp({ status: 200, body: '{}' }, calls), { apiKey: 'zep-key' });
    await p.upsert([fact()]);
    expect(calls[0]!.url).toContain('/v3/facts');
    expect(calls[0]!.init.headers.Authorization).toBe('Api-Key zep-key');
  });

  it('list filters by tenant_id and maps fact shape', async () => {
    const responseBody = JSON.stringify({
      facts: [
        { uuid: 'a', fact: 'one', user_id: 'u1', metadata: { tenant_id: 'T1', recorded_at: 0, confidence: 0.8 } },
        { uuid: 'b', fact: 'two', user_id: 'u2', metadata: { tenant_id: 'OTHER', recorded_at: 0, confidence: 0.8 } },
      ],
    });
    const p = zepProvider(mockHttp({ status: 200, body: responseBody }), { apiKey: 'k' });
    const out = await p.list({ tenantId: 'T1', limit: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('a');
    expect(out[0]!.text).toBe('one');
    expect(out[0]!.subjectId).toBe('u1');
  });
});

describe('all providers — non-2xx throws', () => {
  it('mem0', async () => {
    const p = mem0Provider(mockHttp({ status: 500, body: 'oops' }), { apiKey: 'k' });
    await expect(p.upsert([fact()])).rejects.toThrow(/500/);
  });
  it('letta', async () => {
    const p = lettaProvider(mockHttp({ status: 401, body: 'no' }), { apiKey: 'k', agentId: 'a' });
    await expect(p.upsert([fact()])).rejects.toThrow(/401/);
  });
  it('zep', async () => {
    const p = zepProvider(mockHttp({ status: 503, body: 'down' }), { apiKey: 'k' });
    await expect(p.upsert([fact()])).rejects.toThrow(/503/);
  });
});
