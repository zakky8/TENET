import { PgVectorStore, type PgQueryExecutor } from './index.js';

function mockClient(rowsForQuery: ReadonlyArray<Record<string, unknown>> = []): PgQueryExecutor & {
  calls: Array<{ sql: string; params: ReadonlyArray<unknown> }>;
} {
  const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: rowsForQuery };
    },
  };
}

describe('PgVectorStore — construction', () => {
  it('rejects invalid tableName (SQL identifier injection guard)', () => {
    const c = mockClient();
    expect(() => new PgVectorStore(c, { tableName: 'foo;DROP TABLE x' })).toThrow();
    expect(() => new PgVectorStore(c, { tableName: 'foo bar' })).toThrow();
    expect(() => new PgVectorStore(c, { tableName: '1starts_with_digit' })).toThrow();
  });

  it('accepts valid SQL identifier table names', () => {
    expect(() => new PgVectorStore(mockClient(), { tableName: 'tenet_vectors' })).not.toThrow();
    expect(() => new PgVectorStore(mockClient(), { tableName: '_underscore_ok' })).not.toThrow();
  });
});

describe('PgVectorStore — upsert', () => {
  it('parameter-binds every value; embedding as vector literal', async () => {
    const c = mockClient();
    const s = new PgVectorStore(c);
    await s.upsert([
      {
        source: {
          id: "id'1",
          uri: 'u',
          text: 'hello',
          confidence: 0.9,
          metadata: { lang: 'en' },
        },
        embedding: [0.1, 0.2],
        tenantId: 'T',
      },
    ]);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.sql).toMatch(/INSERT INTO tenet_vectors/);
    // ID with apostrophe must arrive as a bound param, not interpolated
    expect(c.calls[0]!.params).toContain("id'1");
    expect(c.calls[0]!.params).toContain('[0.1,0.2]');
  });

  it('noop on empty input', async () => {
    const c = mockClient();
    await new PgVectorStore(c).upsert([]);
    expect(c.calls).toHaveLength(0);
  });
});

describe('PgVectorStore — query', () => {
  it('parses scored rows back into Source records', async () => {
    const c = mockClient([
      { id: 'A', uri: 'u', text: 'x', confidence: 1, metadata: { tag: 't' }, score: 0.95 },
    ]);
    const s = new PgVectorStore(c);
    const out = await s.query({ embedding: [1, 0], k: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]!.source.id).toBe('A');
    expect(out[0]!.source.metadata?.tag).toBe('t');
    expect(out[0]!.score).toBeCloseTo(0.95);
  });

  it('emits tenant_id filter when tenantId provided', async () => {
    const c = mockClient();
    await new PgVectorStore(c).query({ embedding: [1, 0], k: 3, tenantId: 'T1' });
    expect(c.calls[0]!.sql).toMatch(/tenant_id = \$2/);
    expect(c.calls[0]!.params).toContain('T1');
  });

  it('emits metadata filter via ->>operator with parameter binding', async () => {
    const c = mockClient();
    await new PgVectorStore(c).query({ embedding: [1, 0], k: 5, filter: { lang: 'en' } });
    expect(c.calls[0]!.sql).toMatch(/metadata->>'lang'/);
    expect(c.calls[0]!.params).toContain('en');
  });

  it('validateFilterKey blocks SQL injection in filter keys', async () => {
    const s = new PgVectorStore(mockClient());
    await expect(
      s.query({ embedding: [1, 0], k: 5, filter: { "'; DROP TABLE x;--": 'x' } }),
    ).rejects.toThrow(/Invalid filter key/);
  });

  it('returns [] when k <= 0', async () => {
    const c = mockClient();
    const out = await new PgVectorStore(c).query({ embedding: [1, 0], k: 0 });
    expect(out).toEqual([]);
    expect(c.calls).toHaveLength(0);
  });

  it('throws AbortError when signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      new PgVectorStore(mockClient()).query({ embedding: [1, 0], k: 5, signal: ctrl.signal }),
    ).rejects.toThrow();
  });
});

describe('PgVectorStore — delete', () => {
  it('builds a parameterized IN clause', async () => {
    const c = mockClient();
    await new PgVectorStore(c).delete(['A', 'B', 'C']);
    expect(c.calls[0]!.sql).toMatch(/DELETE FROM tenet_vectors WHERE id IN \(\$1, \$2, \$3\)/);
    expect(c.calls[0]!.params).toEqual(['A', 'B', 'C']);
  });

  it('noop on empty input', async () => {
    const c = mockClient();
    await new PgVectorStore(c).delete([]);
    expect(c.calls).toHaveLength(0);
  });
});
