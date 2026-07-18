# @tenet/refine

Answer-quality orchestration above the verifier — four model-agnostic
levers to reduce hallucination, recover better answers, and get smarter
output from *any* model (including small/local ones).

## The pipeline position

```
question
   │
   ├─ 1. knowledgeBoundaryGate(hits)        ← abstain BEFORE drafting
   │      weak retrieval coverage? say "I don't know" now:
   │      zero draft cost, zero judge cost, zero wrong info
   │
   ├─ 2. bestOfN([draft, draft, draft])     ← parallel samples,
   │      verify each, pick max supported-claim ratio
   │
   ├─ 3. repairDraft(draft)                 ← verification failed?
   │      rewrite ONLY the unsupported claims, re-verify
   │      (bounded rounds; the full verifier still gates the result)
   │
   └─ 4. selfConsistency(verdictSets)       ← claims that flip across
          samples are confabulation signals (SelfCheckGPT, claim-level)
```

Use any subset. Composes with `@tenet/verifier` (including the P16
deterministic pre-check tier) and any ChatModel.

## Example

```ts
import { knowledgeBoundaryGate, bestOfN, repairDraft } from '@tenet/refine';
import { verifyDraft, defaultPreChecks } from '@tenet/verifier';
import { responseText, textMessage } from '@tenet/core';

const hits = index.query({ text: question, k: 5 });
const gate = knowledgeBoundaryGate(hits, { minTopScore: 1.0 });
if (!gate.proceed) return "I don't have sources covering that.";

const verify = (draft: string) =>
  verifyDraft(model, { sources, draft }, { claimPreChecks: defaultPreChecks() });

// 3 parallel samples, winner by supported-claim ratio. A DraftFn returns the
// draft STRING, so pull it off the ChatResponse with responseText. ChatModel
// takes a messages array and a required AbortSignal (@tenet/core contract).
const { best } = await bestOfN(
  [0, 1, 2].map(() => (signal?: AbortSignal) =>
    model
      .chat({ system, messages: [textMessage('user', question)], maxTokens: 512, signal: signal ?? new AbortController().signal })
      .then(responseText)),
  verify,
);

// If even the winner fails, repair instead of abstaining wholesale
const final = best.result.pass
  ? best
  : await repairDraft(best.draft, verify, ({ draft, critique, signal }) =>
      model
        .chat({
          system: 'Rewrite the draft. Remove or correct ONLY the claims listed in the critique. Use ONLY the sources.',
          messages: [textMessage('user', `SOURCES:\n${sources}\n\nDRAFT:\n${draft}\n\nCRITIQUE:\n${critique}`)],
          maxTokens: 512,
          signal: signal ?? new AbortController().signal,
        })
        .then(responseText));
```

## One call: the grounded-or-abstain orchestrator

`groundedOrAbstain` chains the boundary gate → draft → verify + bounded
`repairDraft` into a single fail-closed decision — the reference a real
app copies. It takes injected functions only (no provider, no verifier
import); back `verify` with `verifyDraft`. It **fails closed at every
edge**: thin retrieval abstains before drafting, an unsupported draft
that repair can't rescue abstains, and any draft/verify/rewrite throw
resolves to abstain. `status: 'answered'` is returned ONLY past a
passing verifier — including for a "we do not offer X" scope claim the
sources don't positively support, which abstains rather than shipping.

```ts
import { groundedOrAbstain } from '@tenet/refine';
import { verifyDraft, defaultPreChecks } from '@tenet/verifier';
import { responseText, textMessage } from '@tenet/core';

const decision = await groundedOrAbstain(
  {
    hits: index.query({ text: question, k: 5 }),
    draft: (signal) =>
      model
        .chat({ system, messages: [textMessage('user', question)], maxTokens: 512, signal: signal ?? new AbortController().signal })
        .then(responseText),
    verify: (draft) =>
      verifyDraft(model, { sources, draft }, { claimPreChecks: defaultPreChecks() }),
    rewrite: ({ draft, critique, signal }) =>
      model
        .chat({ system: rewriteSystem, messages: [textMessage('user', `SOURCES:\n${sources}\n\nDRAFT:\n${draft}\n\nCRITIQUE:\n${critique}`)], maxTokens: 512, signal: signal ?? new AbortController().signal })
        .then(responseText),
  },
  { boundary: { minTopScore: 1.0 }, maxRepairRounds: 2 },
);

if (decision.status === 'answered') send(decision.draft);
else handoff(decision.reason); // stage: 'boundary' | 'verify' | 'error'
```

## Cost/speed model

| Lever | Extra model calls | Wall-clock |
|---|---|---|
| boundary gate | **−1 draft − judges** when it blocks | faster |
| bestOfN(3) | 3× draft + 3× verify, parallel | ≈ +1 round-trip |
| repairDraft | +1 rewrite + 1 verify per round | bounded by maxRounds |
| selfConsistency | 0 (reuses bestOfN verdicts) | free |
