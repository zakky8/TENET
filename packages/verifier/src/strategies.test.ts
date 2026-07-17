import type { ChatResponse } from '@tenet/core';
import {
  urlAllowlistFilter,
  examplesDecorator,
  effectivePreFilters,
  effectiveDecorators,
} from './strategies.js';
import { verifyDraft } from './verifier.js';
import type { ChatModel, ClaimPreFilter, JudgePromptDecorator } from './types.js';

function textResponse(text: string): ChatResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

describe('urlAllowlistFilter', () => {
  it('returns a ClaimPreFilter that auto-passes claims with allowlisted URLs', () => {
    const f = urlAllowlistFilter(['example.com']);
    expect(f.passesWithoutJudging('See example.com for details')).toBe(true);
    expect(f.passesWithoutJudging('See evil.com for details')).toBe(false);
  });
});

describe('examplesDecorator', () => {
  it('appends literal examples after a newline', () => {
    const d = examplesDecorator('TRAP A: foo');
    const out = d.appendToStrictPolicy('STRICT');
    expect(out).toBe('STRICT\nTRAP A: foo');
  });

  it('does not double-newline if examples already start with \\n', () => {
    const d = examplesDecorator('\nTRAP B: bar');
    expect(d.appendToStrictPolicy('STRICT')).toBe('STRICT\nTRAP B: bar');
  });
});

describe('effectivePreFilters / effectiveDecorators — composition order', () => {
  it('app filters run first, URL allowlist convenience runs last', () => {
    const log: string[] = [];
    const appFilter: ClaimPreFilter = {
      passesWithoutJudging(claim) {
        log.push('app:' + claim);
        return false;
      },
    };
    const filters = effectivePreFilters({
      claimPreFilters: [appFilter],
      allowedUrlPatterns: ['example.com'],
    });
    expect(filters).toHaveLength(2);
    filters[0]!.passesWithoutJudging('x');
    filters[1]!.passesWithoutJudging('see example.com');
    expect(log[0]).toBe('app:x');
  });

  it('decorators: app first, examples convenience last', () => {
    const d1: JudgePromptDecorator = {
      appendToStrictPolicy(p) {
        return p + '\nAPP DECORATOR';
      },
    };
    const decorators = effectiveDecorators({
      judgePromptDecorators: [d1],
      adversarialExamples: 'BUILT-IN EXAMPLE',
    });
    expect(decorators).toHaveLength(2);
    const out = decorators.reduce((p, d) => d.appendToStrictPolicy(p), 'STRICT');
    expect(out).toBe('STRICT\nAPP DECORATOR\nBUILT-IN EXAMPLE');
  });

  it('empty config yields empty arrays', () => {
    expect(effectivePreFilters({ allowedUrlPatterns: [] })).toEqual([]);
    expect(effectiveDecorators({})).toEqual([]);
  });
});

describe('verifyDraft — app-supplied ClaimPreFilter short-circuits judging', () => {
  it('app filter auto-passes a claim that does not contain any URL', async () => {
    const trustClaimFilter: ClaimPreFilter = {
      passesWithoutJudging(claim) {
        return claim.includes('TRUSTED');
      },
    };
    let judgeCalls = 0;
    const model: ChatModel = {
      chat: async ({ system }) => {
        if (system.includes('extract atomic')) {
          return textResponse('this is a TRUSTED claim with real content');
        }
        judgeCalls++;
        return textResponse('[1] SUPPORTED');
      },
    };
    const out = await verifyDraft(
      model,
      { sources: 's', draft: 'd' },
      { claimPreFilters: [trustClaimFilter] },
    );
    expect(out.pass).toBe(true);
    expect(judgeCalls).toBe(0);
  });
});
