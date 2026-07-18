# @tenet/app-community-bot

Reference deployment showing how to compose `@tenet/core` + `@tenet/verifier` + `@tenet/retrieval` + `@tenet/telemetry` + `@tenet/memory` into a working agent.

This is **not** a production runtime — it's a hand-wired composition that proves the framework pieces fit together. Phase 2 ships a state-machine harness.

## Honest outcome telemetry

`verifierPassed` reflects the real verifier verdict (the bot actually runs `verifier.verify()`): `true` on a
genuine pass, `false` on rejection, `null` on a model error. `costUsd` is not hardcoded — inject a `costMeter`
(structurally `{ total(): number }`, satisfied by `@tenet/telemetry`'s `CostMeter` with no extra dependency);
with no meter wired, cost is `0` (explicitly *unmetered*, never a fabricated figure). Cost is recorded on
every outcome path — resolved, verifier-rejected, and model-error alike.
