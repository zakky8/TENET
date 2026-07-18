import type { ChatResponse } from '@tenet/core';
import { verifyDraft } from './verifier.js';
import type { ChatModel } from './types.js';

function textResponse(text: string): ChatResponse {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

/**
 * FIX #10 regression — when two extracted claims happen to be identical
 * strings, the old Map-by-claim-string merge collapsed permissive verdicts
 * and the merged outcome was driven by whichever verdict happened to be
 * inserted last. Index-based merge keeps alignment exact.
 */
describe('verifyDraft — duplicate-claim permissive merge (FIX #10)', () => {
  function scripted(replies: string[]): ChatModel {
    let i = 0;
    return {
      chat: async () => {
        const r = replies[i] ?? '';
        i++;
        return textResponse(r);
      },
    };
  }

  it('two strict-failed claims with identical strings: permissive verdicts respect input order', async () => {
    const dup = 'the listed item price is five hundred dollars';
    const replies = [
      // extract returns the same claim twice (extractor non-determinism)
      `${dup}\n${dup}`,
      // strict fails both
      '[1] UNSUPPORTED: a-bad\n[2] UNSUPPORTED: b-bad',
      // permissive rescues #1 but not #2 (index 1 supported, index 2 unsupported)
      '[1] SUPPORTED\n[2] UNSUPPORTED: still-bad',
    ];
    const out = await verifyDraft(scripted(replies), { sources: 's', draft: 'd' });

    // Post-fix: one claim should be rescued (the first), one still unsupported
    // → overall pass=false but the critique mentions exactly ONE unsupported claim
    expect(out.pass).toBe(false);
    const stillFailedVerdicts = out.verdicts.filter((v) => !v.supported);
    expect(stillFailedVerdicts).toHaveLength(1);
  });

  it('THREE identical strict-failed claims: index alignment gives each its OWN permissive verdict', async () => {
    // `claimsPerBatch: 3` puts all three in ONE strict + ONE permissive batch, so the
    // 3-reply script is COMPLETE — no empty trailing batch reply that the (default)
    // fail-open judge could mask into "all supported" (which made the previous version of
    // this test pass regardless of the merge — a vacuous test). Permissive rescues #1 and
    // #3 but NOT #2; index alignment must keep the middle one failed. A string-keyed merge
    // (the FIX#10 bug) would collapse the three identical strings to ONE verdict → all
    // rescued → pass:true, which this asserts against.
    const dup = 'budget allocation includes ops and team buckets in the doc';
    const replies = [
      `${dup}\n${dup}\n${dup}`,
      '[1] UNSUPPORTED: x\n[2] UNSUPPORTED: x\n[3] UNSUPPORTED: x', // strict fails all three
      '[1] SUPPORTED\n[2] UNSUPPORTED: still-bad\n[3] SUPPORTED', // permissive rescues #1 and #3, not #2
    ];
    const out = await verifyDraft(scripted(replies), { sources: 's', draft: 'd' }, { claimsPerBatch: 3 });
    expect(out.pass).toBe(false);
    expect(out.verdicts.filter((v) => !v.supported)).toHaveLength(1); // exactly the middle claim
  });
});
