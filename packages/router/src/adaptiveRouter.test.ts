import { AdaptiveRouter } from './adaptiveRouter.js';
import type { RouteClassifier, RouterChatModel } from './types.js';

function mockClassifier(tier: string, confidence: number): RouteClassifier {
  return {
    async classify() {
      return { tier, confidence };
    },
  };
}

function mockModel(name: string, fail = false): RouterChatModel {
  return {
    async chat() {
      if (fail) throw new Error(`${name} failed`);
      return `output-from-${name}`;
    },
  };
}

describe('AdaptiveRouter — construction', () => {
  it('rejects flagshipTier not in tiers', () => {
    expect(
      () =>
        new AdaptiveRouter({
          classifier: mockClassifier('x', 1),
          tiers: { cheap: mockModel('cheap') },
        }),
    ).toThrow(/flagshipTier/);
  });

  it('rejects confidenceFloor out of range', () => {
    expect(
      () =>
        new AdaptiveRouter({
          classifier: mockClassifier('flagship', 1),
          tiers: { flagship: mockModel('f') },
          confidenceFloor: 1.5,
        }),
    ).toThrow();
  });
});

describe('AdaptiveRouter — routing decisions', () => {
  it('uses classifier-picked tier when confidence is high', async () => {
    const r = new AdaptiveRouter({
      classifier: mockClassifier('cheap', 0.95),
      tiers: { cheap: mockModel('cheap'), flagship: mockModel('flagship') },
    });
    const out = await r.route({ text: 'q', system: 's', user: 'u', maxTokens: 100 });
    expect(out.tierUsed).toBe('cheap');
    expect(out.text).toBe('output-from-cheap');
    expect(out.fellBackToFlagship).toBe(false);
  });

  it('falls back to flagship when confidence < floor', async () => {
    const r = new AdaptiveRouter({
      classifier: mockClassifier('cheap', 0.3),
      tiers: { cheap: mockModel('cheap'), flagship: mockModel('flagship') },
    });
    const out = await r.route({ text: 'q', system: 's', user: 'u', maxTokens: 100 });
    expect(out.tierUsed).toBe('flagship');
    expect(out.fellBackToFlagship).toBe(true);
  });

  it('falls back to flagship when picked tier is unknown', async () => {
    const r = new AdaptiveRouter({
      classifier: mockClassifier('non-existent', 0.9),
      tiers: { flagship: mockModel('flagship') },
    });
    const out = await r.route({ text: 'q', system: 's', user: 'u', maxTokens: 100 });
    expect(out.tierUsed).toBe('flagship');
    expect(out.fellBackToFlagship).toBe(true);
  });

  it('falls back to flagship on picked-tier error', async () => {
    const r = new AdaptiveRouter({
      classifier: mockClassifier('cheap', 0.95),
      tiers: { cheap: mockModel('cheap', /*fail=*/ true), flagship: mockModel('flagship') },
    });
    const out = await r.route({ text: 'q', system: 's', user: 'u', maxTokens: 100 });
    expect(out.tierUsed).toBe('flagship');
    expect(out.text).toBe('output-from-flagship');
  });

  it('propagates flagship-tier error (no second fallback)', async () => {
    const r = new AdaptiveRouter({
      classifier: mockClassifier('flagship', 0.95),
      tiers: { flagship: mockModel('flagship', true) },
    });
    await expect(
      r.route({ text: 'q', system: 's', user: 'u', maxTokens: 100 }),
    ).rejects.toThrow();
  });
});
