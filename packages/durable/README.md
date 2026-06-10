# @tenet/durable

Step-level durable execution for agents — journaled deterministic replay,
suspend/resume across process restarts, and `interrupt()` human-in-the-loop.
No workflow cluster required: the journal persists through any
`StateStore` (in-memory, Redis via `@tenet/stores-state-redis`, Postgres
via `@tenet/stores-state-postgres`).

## Why

The 2026 bar for agent frameworks is not "can checkpoint" but
*deterministic replay that survives deploys*. Step-level memoization means
a crashed or redeployed agent re-runs its function from the top and every
completed step returns its recorded result instantly — only the
not-yet-done work executes.

## Usage

```ts
import { DurableRunner, StateStoreJournal } from '@tenet/durable';
import { InMemoryStateStore } from '@tenet/stores-state-redis';

const runner = new DurableRunner(new StateStoreJournal(new InMemoryStateStore()));

const result = await runner.run('ticket-4711', async (ctx) => {
  const intake  = await ctx.step('classify', () => classify(ticket));
  const draft   = await ctx.step('draft',    () => draftReply(intake));

  // Human-in-the-loop: suspends here — for minutes or days — until
  // resolveInterrupt() is called. Survives restarts.
  const approved = await ctx.interrupt<boolean>('approval', { draft });

  if (!approved) return 'escalated';
  await ctx.step('send', () => send(draft));
  return 'resolved';
});

if (result.status === 'suspended') {
  // drive your approval UI from runner.pendingInterrupts(runId)
}

// later — from any process:
await runner.resolveInterrupt('ticket-4711', 'approval', true);
await runner.run('ticket-4711', fn); // replays past the gate, finishes
```

## Rules

- **Step names are the memoization key** — unique per run; suffix loop
  indices (`fetch:${i}`). This makes `Promise.all()` of steps replay-safe.
- **Step results must be JSON-serializable.**
- **One active executor per runId.** Enforce with a lease upstream if you
  run replicas. (For Temporal-grade distributed routing, wire Temporal —
  this covers the zero-infra 95%.)
- A failed step is **retried on the next run()**; completed steps are not
  re-executed.
- `ctx.sleep(name, ms)` journals the wake time and suspends — the caller
  owns re-invocation scheduling (cron, queue, setTimeout).
- Replay drift (same name, different kind) throws `NondeterminismError`
  instead of silently corrupting state.

## Governance composition

When `@tenet/governance` policy says `require_approval`, call
`ctx.interrupt(name, request)` and resolve it from your approval surface
(Slack modal, ticket comment, REST endpoint). See the
"composes with an ApprovalGate-shaped policy" test for the pattern.
