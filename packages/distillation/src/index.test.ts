import {
  shouldSample,
  traceToJsonl,
  emitJsonl,
  buildDataset,
  DEFAULT_POLICY,
  DistillationError,
  type DistillationTrace,
} from './index.js';

const trace = (overrides: Partial<DistillationTrace> = {}): DistillationTrace => ({
  id: 't1',
  tenantId: 'tenant-a',
  capturedAtMs: 1_700_000_000_000,
  system: 'You are grounded.',
  user: 'What is the capital of France?',
  flagshipAnswer: 'Paris.',
  verdict: { passed: true, score: 0.99 },
  sources: [{ id: 's1', text: 'Paris is the capital of France.' }],
  ...overrides,
});

const alwaysKeep = (): number => 0; // always <= sampleRate
const alwaysSkip = (): number => 1; // always > sampleRate

describe('shouldSample', () => {
  it('keeps high-score passed trace under default policy', () => {
    const d = shouldSample(trace(), DEFAULT_POLICY, alwaysKeep);
    expect(d.keep).toBe(true);
  });

  it('drops failed-verdict trace', () => {
    const d = shouldSample(trace({ verdict: { passed: false, score: 0.99 } }), DEFAULT_POLICY, alwaysKeep);
    expect(d).toEqual({ keep: false, reason: 'verdict_failed' });
  });

  it('drops below-threshold trace', () => {
    const d = shouldSample(trace({ verdict: { passed: true, score: 0.9 } }), DEFAULT_POLICY, alwaysKeep);
    expect(d.keep).toBe(false);
    if (!d.keep) expect(d.reason).toMatch(/0\.9 < min 0\.95/);
  });

  it('drops oversized answer', () => {
    const big = 'x'.repeat(DEFAULT_POLICY.maxOutputChars + 1);
    const d = shouldSample(trace({ flagshipAnswer: big }), DEFAULT_POLICY, alwaysKeep);
    expect(d.keep).toBe(false);
  });

  it('respects sampling — alwaysSkip drops a valid trace', () => {
    const d = shouldSample(trace(), DEFAULT_POLICY, alwaysSkip);
    expect(d).toEqual({ keep: false, reason: 'sampling' });
  });

  it('throws on invalid sampleRate', () => {
    expect(() => shouldSample(trace(), { ...DEFAULT_POLICY, sampleRate: 0 }, alwaysKeep)).toThrow(DistillationError);
    expect(() => shouldSample(trace(), { ...DEFAULT_POLICY, sampleRate: 2 }, alwaysKeep)).toThrow(DistillationError);
  });
});

describe('traceToJsonl', () => {
  it('produces a 3-message OpenAI-shape row', () => {
    const row = traceToJsonl(trace());
    expect(row.messages).toHaveLength(3);
    expect(row.messages[0]!.role).toBe('system');
    expect(row.messages[1]!.role).toBe('user');
    expect(row.messages[2]!.role).toBe('assistant');
  });

  it('inlines sources into the system prompt', () => {
    const row = traceToJsonl(trace());
    expect(row.messages[0]!.content).toContain('[s1] Paris is the capital');
  });

  it('omits sources block when sources is empty', () => {
    const row = traceToJsonl(trace({ sources: [] }));
    expect(row.messages[0]!.content).not.toContain('Sources:');
  });

  it('attaches metadata: traceId / tenantId / score', () => {
    const row = traceToJsonl(trace());
    expect(row.metadata).toEqual({ traceId: 't1', tenantId: 'tenant-a', verifierScore: 0.99 });
  });
});

describe('emitJsonl', () => {
  it('writes one JSON object per line + trailing newline', () => {
    const rows = [traceToJsonl(trace()), traceToJsonl(trace({ id: 't2' }))];
    const out = emitJsonl(rows);
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).metadata.traceId).toBe('t1');
  });

  it('returns empty string for empty rows', () => {
    expect(emitJsonl([])).toBe('');
  });
});

describe('buildDataset', () => {
  it('keeps all valid traces with alwaysKeep rng', () => {
    const result = buildDataset(
      [trace({ id: 'a' }), trace({ id: 'b' }), trace({ id: 'c' })],
      DEFAULT_POLICY,
      alwaysKeep,
    );
    expect(result.kept).toBe(3);
    expect(result.dropped).toEqual([]);
  });

  it('reports per-trace drop reasons', () => {
    const result = buildDataset(
      [
        trace({ id: 'a', verdict: { passed: false, score: 0.99 } }),
        trace({ id: 'b' }),
      ],
      DEFAULT_POLICY,
      alwaysKeep,
    );
    expect(result.kept).toBe(1);
    expect(result.dropped).toEqual([{ traceId: 'a', reason: 'verdict_failed' }]);
  });
});
