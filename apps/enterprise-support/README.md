# @tenet/app-enterprise-support

Reference enterprise composition. Wires multiple surfaces + ticketing connectors + agent runtime + outcome telemetry into a single dispatcher.

Production deployments start here and customize routing, HITL escalation, KB ingestion, etc.

## Outcome telemetry is honest by construction

The dispatcher never fabricates the two values that a naive skeleton gets wrong:

- **`verifierPassed`** is *not* asserted `true` on every dispatch. The dispatcher does not run
  the verifier — the agent does — so it records only what it can observe: a reply with non-blank
  text **and** ≥1 verifier-approved citation is a grounded, verified answer (`true`); an
  abstention/handoff (empty text or no citations) is not (`false`); a dispatch that errored emitted
  no reply (`null`). It never claims a verification it did not observe.
- **`costUsd`** is *not* hardcoded to `0`. Inject a `costMeter` (structurally satisfied by
  `@tenet/telemetry`'s `CostMeter` — no dependency needed); record token usage into the same meter
  from inside the agent, and the dispatcher reads `total()` at outcome time. With no meter wired,
  cost is `0` (explicitly *unmetered*, never a fabricated figure).
