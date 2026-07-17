import { SpeculativeAgent } from './speculative.js';
import type { RouterChatModel } from './types.js';

function model(name: string, delayMs: number, failure?: boolean): RouterChatModel {
  return {
    chat: () =>
      new Promise((resolve, reject) => {
        setTimeout(() => {
          if (failure) reject(new Error(`${name} failed`));
          else
            resolve({
              content: [{ type: 'text', text: `output-${name}` }],
              stopReason: 'end_turn',
            });
        }, delayMs);
      }),
  };
}

describe('SpeculativeAgent', () => {
  it('returns cheap-verified when verifier accepts', async () => {
    const agent = new SpeculativeAgent({
      cheap: model('cheap', 5),
      flagship: model('flagship', 10),
      verify: async () => true,
    });
    const out = await agent.run({ system: 's', user: 'u', maxTokens: 100 });
    expect(out.reason).toBe('cheap-verified');
    expect(out.accepted).toBe(true);
    expect(out.cheap).toBe('output-cheap');
  });

  it('returns flagship-promoted when verifier rejects cheap', async () => {
    const agent = new SpeculativeAgent({
      cheap: model('cheap', 5),
      flagship: model('flagship', 10),
      verify: async () => false,
    });
    const out = await agent.run({ system: 's', user: 'u', maxTokens: 100 });
    expect(out.reason).toBe('flagship-promoted');
    expect(out.accepted).toBe(false);
    expect(out.flagship).toBe('output-flagship');
  });

  it('returns flagship-timeout when flagship exceeds budget', async () => {
    const agent = new SpeculativeAgent({
      cheap: model('cheap', 5),
      flagship: model('flagship', 200),
      verify: async () => false, // would reject, but flagship times out first
      flagshipTimeoutMs: 30,
    });
    const out = await agent.run({ system: 's', user: 'u', maxTokens: 100 });
    expect(out.reason).toBe('flagship-timeout');
    expect(out.accepted).toBe(true);
  });

  it('returns flagship-error when flagship throws', async () => {
    const agent = new SpeculativeAgent({
      cheap: model('cheap', 5),
      flagship: model('flagship', 10, true),
      verify: async () => false,
    });
    const out = await agent.run({ system: 's', user: 'u', maxTokens: 100 });
    expect(out.reason).toBe('flagship-error');
    expect(out.accepted).toBe(true);
  });
});
