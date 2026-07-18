import { measureAll, DEFAULT_TARGETS } from './runner.js';
import { FIXTURE_MANIFEST, QA_FIXTURES, INJECTION_FIXTURES, type QAFixture } from './fixtures.js';
import {
  stubAnswer,
  stubVerify,
  stubGuardrail,
  stubInvokeTool,
  stubRetrieve,
  stubRoute,
  stubDetectPii,
} from './stubSut.js';

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

  it('every QA fixture has a reference + ≥1 relevant source in a distractor-bearing corpus', () => {
    for (const c of QA_FIXTURES) {
      expect(c.reference.length).toBeGreaterThan(0);
      expect(c.relevantSourceIds.length).toBeGreaterThanOrEqual(1);
      // Every relevant id must be retrievable from this fixture's corpus,
      // and the corpus must carry ≥1 distractor (else the selection is
      // trivial and the QA metric would be vacuous again).
      const corpusIds = c.corpus.map((chunk) => chunk.id);
      for (const rid of c.relevantSourceIds) expect(corpusIds).toContain(rid);
      expect(c.corpus.length).toBeGreaterThan(c.relevantSourceIds.length);
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

describe('QA grounding is MEASURED, not identity (de-tautologized)', () => {
  it('cites the highest term-overlap chunk, resisting an adjacent distractor', () => {
    const fx: QAFixture = {
      id: 'x', question: 'What is the capital of France?', reference: 'Paris',
      relevantSourceIds: ['s_paris'],
      corpus: [
        { id: 'd_berlin', text: 'Berlin is the capital of Germany.' }, // listed FIRST — order must not save it
        { id: 's_paris', text: 'Paris is the capital of France.' },
      ],
    };
    expect(stubAnswer(fx).citedSourceIds).toEqual(['s_paris']);
    expect(stubVerify(fx, stubAnswer(fx))).toBe(true);
  });

  // The metric has TEETH: when a distractor out-overlaps the relevant chunk,
  // the stub cites it and verification FAILS — impossible under the old
  // identity-pass, where every cite was ground truth by construction.
  it('a distractor-dominant fixture makes stubVerify FAIL (the tautology is gone)', () => {
    const fx: QAFixture = {
      id: 'adv', question: 'What is the capital of France?', reference: 'Paris',
      relevantSourceIds: ['s_right'],
      corpus: [
        { id: 's_right', text: 'Paris.' }, // low overlap with the question
        { id: 'd_wrong', text: 'What is the capital of France capital France?' }, // higher overlap, wrong id
      ],
    };
    expect(stubAnswer(fx).citedSourceIds).toEqual(['d_wrong']);
    expect(stubVerify(fx, stubAnswer(fx))).toBe(false);
  });

  it('no overlap / empty corpus → no cite → unsupported (fail-closed, not a spurious pass)', () => {
    const empty: QAFixture = { id: 'e', question: 'anything', reference: 'x', relevantSourceIds: ['s'], corpus: [] };
    expect(stubAnswer(empty).citedSourceIds).toEqual([]);
    expect(stubVerify(empty, stubAnswer(empty))).toBe(false);
    const noOverlap: QAFixture = {
      id: 'n', question: 'zzz qqq', reference: 'x', relevantSourceIds: ['s'],
      corpus: [{ id: 's', text: 'entirely unrelated tokens here' }],
    };
    expect(stubAnswer(noOverlap).citedSourceIds).toEqual([]);
    expect(stubVerify(noOverlap, stubAnswer(noOverlap))).toBe(false);
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

  it('hallucination is 0 and groundedness 1 — MEASURED (real retrieval grounds every fixture)', () => {
    // Not tautological: the stub selects citations by term overlap over each
    // fixture's distractor-bearing corpus. This asserts it grounds ALL 20 —
    // an authoring regression (a distractor out-overlapping the relevant
    // chunk) would push hallucination > 0 and fail here.
    const report = measureAll();
    const hall = report.metrics.find((x) => x.metric === 'hallucination_rate')!;
    const ground = report.metrics.find((x) => x.metric === 'groundedness_rate')!;
    expect(hall.value).toBe(0);
    expect(ground.value).toBe(1);
  });

  it('determinism on stub SUT is 1', () => {
    const report = measureAll();
    const m = report.metrics.find((x) => x.metric === 'determinism_rate')!;
    expect(m.value).toBe(1);
  });
});
