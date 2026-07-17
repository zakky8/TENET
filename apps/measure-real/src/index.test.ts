import type { LegacyChatModel as ChatModel } from '@tenet/models-anthropic';
import type { HhemScorer } from '@tenet/judge-hhem';
import { measureReal, makeCostMeter, type CostMeter, type RealCase } from './runner.js';
import { PUBLIC_SLICE, PUBLIC_SLICE_VERSION } from './dataset.js';

/** Test ChatModel — deterministic answers per case id. */
function fakeModel(answersById: Record<string, string>): ChatModel {
  return {
    async chat({ user }) {
      const match = user.match(/Question:\s*(.+)$/);
      const q = match?.[1]?.trim() ?? '';
      // Look up by exact question match against PUBLIC_SLICE
      const c = PUBLIC_SLICE.find((x) => x.question === q);
      if (!c) return 'Answer: unknown';
      return `Answer: ${answersById[c.id] ?? c.acceptableAnswers[0]}`;
    },
  };
}

const FULL_OVERLAP_HHEM: HhemScorer = {
  async score({ premise, hypothesis }) {
    const tk = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const h = tk(hypothesis);
    if (h.length === 0) return 1;
    const p = new Set(tk(premise));
    return h.filter((t) => p.has(t)).length / h.length;
  },
};

const NOOP_COST: CostMeter = { estimate: () => 0.001 };

describe('makeCostMeter', () => {
  it('computes USD from token counts and price table', () => {
    const meter = makeCostMeter({
      'claude-sonnet-4-5': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
    });
    const cost = meter.estimate({
      model: 'claude-sonnet-4-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18, 5);
  });

  it('returns 0 for unknown model', () => {
    const meter = makeCostMeter({});
    expect(meter.estimate({ model: 'ghost', inputTokens: 100, outputTokens: 100 })).toBe(0);
  });
});

describe('measureReal', () => {
  it('emits a real RealMeasurementReport with sut=real + modelId + datasetVersion', async () => {
    const report = await measureReal({
      model: fakeModel({}),
      modelId: 'fake-model',
      hhem: FULL_OVERLAP_HHEM,
      cost: NOOP_COST,
    });
    expect(report.sut).toBe('real');
    expect(report.modelId).toBe('fake-model');
    expect(report.datasetVersion).toBe(PUBLIC_SLICE_VERSION);
    expect(report.datasetSize).toBe(PUBLIC_SLICE.length);
  });

  it('all-correct fake model → groundedness = 1, hallucination = 0', async () => {
    const report = await measureReal({
      model: fakeModel({}), // defaults to first acceptableAnswer
      modelId: 'fake',
      hhem: FULL_OVERLAP_HHEM,
      cost: NOOP_COST,
    });
    const grounded = report.metrics.find((m) => m.metric === 'groundedness_rate')!;
    const hall = report.metrics.find((m) => m.metric === 'hallucination_rate')!;
    expect(grounded.value).toBe(1);
    expect(hall.value).toBe(0);
  });

  it('answer containing distractor → grounded = false for that case', async () => {
    const wrongAnswers: Record<string, string> = { p1: 'Lyon' };
    const report = await measureReal({
      model: fakeModel(wrongAnswers),
      modelId: 'fake',
      hhem: FULL_OVERLAP_HHEM,
      cost: NOOP_COST,
    });
    const grounded = report.metrics.find((m) => m.metric === 'groundedness_rate')!;
    expect(grounded.value).toBeLessThan(1);
  });

  it('honors a custom dataset', async () => {
    const tiny: RealCase[] = [
      {
        id: 'x',
        question: 'q?',
        acceptableAnswers: ['yes'],
        knownDistractors: ['no'],
        context: 'yes is the answer',
      },
    ];
    const m: ChatModel = { async chat() { return 'Answer: yes'; } };
    const report = await measureReal({
      model: m,
      modelId: 'fake',
      hhem: FULL_OVERLAP_HHEM,
      cost: NOOP_COST,
      dataset: tiny,
    });
    expect(report.datasetSize).toBe(1);
  });

  it('runs gate when targets supplied + verdicts present', async () => {
    const report = await measureReal(
      {
        model: fakeModel({}),
        modelId: 'fake',
        hhem: FULL_OVERLAP_HHEM,
        cost: NOOP_COST,
      },
      [{ metric: 'groundedness_rate', target: 0.99, unit: 'rate', direction: 'maximize' }],
    );
    expect(report.verdicts).toHaveLength(1);
    expect(report.verdicts![0]!.kind).toBe('pass');
  });
});
