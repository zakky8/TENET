import { measureAll, DEFAULT_TARGETS } from './runner.js';
import { FIXTURE_MANIFEST, QA_FIXTURES, INJECTION_FIXTURES } from './fixtures.js';
import { stubGuardrail, stubInvokeTool, stubRetrieve, stubRoute, stubDetectPii } from './stubSut.js';

describe('fixtures shape', () => {
  it('manifest counts add up', () => {
    expect(FIXTURE_MANIFEST.total).toBe(
      FIXTURE_MANIFEST.qa +
        FIXTURE_MANIFEST.injection +
        FIXTURE_MANIFEST.toolCall +
        FIXTURE_MANIFEST.retrieval +
        FIXTURE_MANIFEST.router +
        FIXTURE_MANIFEST.privacy,
    );
    expect(FIXTURE_MANIFEST.total).toBeGreaterThanOrEqual(80);
  });

  it('every QA fixture has a reference + ≥1 relevant source', () => {
    for (const c of QA_FIXTURES) {
      expect(c.reference.length).toBeGreaterThan(0);
      expect(c.relevantSourceIds.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('injection fixtures cover both shouldBlock branches', () => {
    const blocked = INJECTION_FIXTURES.filter((f) => f.shouldBlock).length;
    const allowed = INJECTION_FIXTURES.length - blocked;
    expect(blocked).toBeGreaterThan(0);
    expect(allowed).toBeGreaterThan(0);
  });
});

describe('stub SUT contract', () => {
  it('guardrail blocks every injection-labeled-block fixture', () => {
    const wrong = INJECTION_FIXTURES.filter((f) => stubGuardrail(f) !== f.shouldBlock);
    expect(wrong).toEqual([]);
  });

  it('tool stub validates schemas', () => {
    expect(stubInvokeTool({ id: 'x', toolName: 'add', args: { a: 1, b: 2 }, shouldSucceed: true })).toBe(true);
    expect(stubInvokeTool({ id: 'x', toolName: 'add', args: { a: 'x', b: 2 }, shouldSucceed: false })).toBe(false);
    expect(stubInvokeTool({ id: 'x', toolName: 'unknown', args: {}, shouldSucceed: false })).toBe(false);
  });

  it('retrieve scores by term overlap', () => {
    const result = stubRetrieve(
      {
        queryId: 'q',
        query: 'paris france',
        corpus: [
          { id: 'a', text: 'paris is in france' },
          { id: 'b', text: 'london is in uk' },
          { id: 'c', text: 'apples are red' },
        ],
        relevantIds: ['a'],
      },
      2,
    );
    expect(result[0]).toBe('a');
  });

  it('router picks tier by complexity band', () => {
    expect(stubRoute({ caseId: 'a', complexity: 0.1, oracle: 'haiku' })).toBe('haiku');
    expect(stubRoute({ caseId: 'a', complexity: 0.5, oracle: 'sonnet' })).toBe('sonnet');
    expect(stubRoute({ caseId: 'a', complexity: 0.9, oracle: 'opus' })).toBe('opus');
  });

  it('PII detector flags email + phone + SSN + card', () => {
    expect(stubDetectPii({ id: 'x', text: 'mail me at a@b.example', containsPii: true })).toBe(true);
    expect(stubDetectPii({ id: 'x', text: 'no pii here', containsPii: false })).toBe(false);
  });
});

describe('measureAll', () => {
  it('emits one MetricResult per dimension', () => {
    const report = measureAll();
    expect(report.sut).toBe('stub');
    const metricIds = report.metrics.map((m) => m.metric);
    expect(metricIds).toEqual(
      expect.arrayContaining([
        'hallucination_rate',
        'groundedness_rate',
        'cost_per_resolution_usd',
        'ttft_p95_ms',
        'e2e_latency_p95_ms',
        'tool_call_success_rate',
        'injection_block_rate',
        'privacy_block_rate',
        'retrieval_recall_at_10',
        'router_decision_accuracy',
        'determinism_rate',
      ]),
    );
  });

  it('emits gate verdicts when targets supplied', () => {
    const report = measureAll(DEFAULT_TARGETS);
    expect(report.verdicts).toBeDefined();
    expect(report.verdicts!.length).toBe(DEFAULT_TARGETS.length);
  });

  it('is deterministic — same call → identical numbers', () => {
    const a = measureAll(DEFAULT_TARGETS);
    const b = measureAll(DEFAULT_TARGETS);
    expect(JSON.stringify(a.metrics)).toBe(JSON.stringify(b.metrics));
  });

  it('hallucination on stub SUT is exactly 0 (every cite is in-set)', () => {
    const report = measureAll();
    const m = report.metrics.find((x) => x.metric === 'hallucination_rate')!;
    expect(m.value).toBe(0);
  });

  it('determinism on stub SUT is 1', () => {
    const report = measureAll();
    const m = report.metrics.find((x) => x.metric === 'determinism_rate')!;
    expect(m.value).toBe(1);
  });
});
