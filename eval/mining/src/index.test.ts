import {
  mineAssertions,
  dedupAssertions,
  emitEvalCases,
  cosine,
  type AssertionMiner,
  type Embedder,
  type ConversationTrace,
  type MinedAssertion,
} from './index.js';

const trace = (id: string, outcome: ConversationTrace['outcome'] = 'resolved'): ConversationTrace => ({
  id,
  tenantId: 't1',
  userTurn: `q-${id}`,
  agentAnswer: `a-${id}`,
  citedSourceIds: ['s1'],
  outcome,
  capturedAtMs: 1_700_000_000_000,
});

const fixedMiner = (rules: Array<Omit<MinedAssertion, 'traceId' | 'assertionId'>>): AssertionMiner => ({
  async mine() { return rules; },
});

describe('cosine', () => {
  it('1 for identical vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
  });
  it('0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
  it('throws on length mismatch', () => {
    expect(() => cosine([1], [1, 2])).toThrow();
  });
});

describe('mineAssertions', () => {
  it('produces one MinedAssertion per (trace, miner-output) pair', async () => {
    const miner = fixedMiner([
      { kind: 'must_contain', description: 'mention paris', value: 'Paris' },
    ]);
    const r = await mineAssertions([trace('a'), trace('b')], miner);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.traceId)).toEqual(['a', 'b']);
  });

  it('id stays stable per (trace,kind,value)', async () => {
    const miner = fixedMiner([{ kind: 'must_contain', description: 'd', value: 'X' }]);
    const r1 = await mineAssertions([trace('a')], miner);
    const r2 = await mineAssertions([trace('a')], miner);
    expect(r1[0]!.assertionId).toBe(r2[0]!.assertionId);
  });
});

describe('dedupAssertions', () => {
  // Identity embedder: hash by description length parity → produces
  // near-duplicates for assertions of the same length parity.
  const sameLenEmbedder: Embedder = {
    async embed(text) {
      return text.length % 2 === 0 ? [1, 0] : [0, 1];
    },
  };

  it('drops near-duplicates above threshold', async () => {
    const a: MinedAssertion[] = [
      { traceId: 'x', assertionId: 'a1', kind: 'must_contain', description: 'AB', value: 'X' },
      { traceId: 'x', assertionId: 'a2', kind: 'must_contain', description: 'CD', value: 'Y' },
      { traceId: 'x', assertionId: 'a3', kind: 'must_contain', description: 'EFG', value: 'Z' },
    ];
    const r = await dedupAssertions(a, sameLenEmbedder, { threshold: 0.99 });
    expect(r.kept).toHaveLength(2); // [1,0] kept; [1,0] dup; [0,1] kept
    expect(r.dropped).toBe(1);
  });

  it('keeps everything when threshold = 1 + no exact matches', async () => {
    const orthogEmbedder: Embedder = {
      async embed(text) {
        return Array.from({ length: 4 }, (_, i) => (text.charCodeAt(0) % 4 === i ? 1 : 0));
      },
    };
    const a: MinedAssertion[] = ['A', 'B', 'C', 'D'].map((c, i): MinedAssertion => ({
      traceId: 't',
      assertionId: `id${i}`,
      kind: 'must_contain',
      description: c,
      value: c,
    }));
    const r = await dedupAssertions(a, orthogEmbedder, { threshold: 1 });
    expect(r.kept).toHaveLength(4);
  });

  it('throws on out-of-range threshold', async () => {
    await expect(dedupAssertions([], sameLenEmbedder, { threshold: 0 })).rejects.toThrow();
    await expect(dedupAssertions([], sameLenEmbedder, { threshold: 1.5 })).rejects.toThrow();
  });
});

describe('emitEvalCases', () => {
  const traces = [trace('a', 'resolved'), trace('b', 'handed_off')];
  const assertions: MinedAssertion[] = [
    { traceId: 'a', assertionId: 'a:must_contain:Paris', kind: 'must_contain', description: 'mention paris', value: 'Paris' },
    { traceId: 'a', assertionId: 'a:must_not_contain:Tokyo', kind: 'must_not_contain', description: 'no tokyo', value: 'Tokyo' },
    { traceId: 'b', assertionId: 'b:must_cite:s1', kind: 'must_cite', description: 'cite s1', value: 's1' },
  ];

  it('emits one case per trace with the mined assertions', () => {
    const cases = emitEvalCases(traces, assertions);
    expect(cases).toHaveLength(2);
    expect(cases[0]!.assertions).toHaveLength(2);
    expect(cases[1]!.assertions).toHaveLength(1);
  });

  it('attaches outcome + tenant labels', () => {
    const cases = emitEvalCases(traces, assertions);
    expect(cases[0]!.labels).toEqual(['resolved', 'tenant:t1']);
    expect(cases[1]!.labels).toEqual(['handed_off', 'tenant:t1']);
  });

  it('must_contain assertion passes when output contains the value', async () => {
    const cases = emitEvalCases(traces, assertions);
    const passResult = await cases[0]!.assertions[0]!.check({ output: 'Paris is great', case: cases[0]! });
    expect(passResult.kind).toBe('pass');
    const failResult = await cases[0]!.assertions[0]!.check({ output: 'London', case: cases[0]! });
    expect(failResult.kind).toBe('fail');
  });

  it('must_cite assertion checks for [id] / (id) pattern', async () => {
    const cases = emitEvalCases(traces, assertions);
    const ok = await cases[1]!.assertions[0]!.check({ output: 'see [s1] for details', case: cases[1]! });
    expect(ok.kind).toBe('pass');
    const bad = await cases[1]!.assertions[0]!.check({ output: 'no cite here', case: cases[1]! });
    expect(bad.kind).toBe('fail');
  });
});
