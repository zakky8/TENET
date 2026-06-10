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

const hits = index.query({ text: question, k: 5 });
const gate = knowledgeBoundaryGate(hits, { minTopScore: 1.0 });
if (!gate.proceed) return "I don't have sources covering that.";

const verify = (draft: string) =>
  verifyDraft(model, { sources, draft }, { claimPreChecks: defaultPreChecks() });

// 3 parallel samples, winner by supported-claim ratio
const { best } = await bestOfN(
  [0, 1, 2].map(() => () => model.chat({ system, user, maxTokens: 512 })),
  verify,
);

// If even the winner fails, repair instead of abstaining wholesale
const final = best.result.pass
  ? best
  : await repairDraft(best.draft, verify, ({ draft, critique }) =>
      model.chat({
        system: 'Rewrite the draft. Remove or correct ONLY the claims listed in the critique. Use ONLY the sources.',
        user: `SOURCES:\n${sources}\n\nDRAFT:\n${draft}\n\nCRITIQUE:\n${critique}`,
        maxTokens: 512,
      }));
```

## Cost/speed model

| Lever | Extra model calls | Wall-clock |
|---|---|---|
| boundary gate | **−1 draft − judges** when it blocks | faster |
| bestOfN(3) | 3× draft + 3× verify, parallel | ≈ +1 round-trip |
| repairDraft | +1 rewrite + 1 verify per round | bounded by maxRounds |
| selfConsistency | 0 (reuses bestOfN verdicts) | free |
