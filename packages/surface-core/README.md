# @tenet/surface-core

Shared primitives for the surface send path.

## Grounded-render gate

The agent's single emit edge already refuses to ship an uncited fact — but a surface can be handed a reply from a path that bypassed it (a cache, a custom fast-path, a bug). `groundedRenderGate` is the last-mile belt-and-suspenders:

```ts
import { groundedRenderGate } from '@tenet/surface-core';

const decision = groundedRenderGate(reply, { fallback: "I can't back that up with a source." });
send(decision.text); // the grounded answer, or the safe fallback — never an ungrounded fact
```

- A reply with **≥1 grounded citation** (non-blank source id *and* quote) → rendered as-is.
- A **fact-bearing reply with no grounded citation** → **refused**; the operator's safe `fallback` is rendered instead. It cannot (and must not try to) tell a legitimate abstention from a fabricated fact that lost its citation, so it treats both the same — strictly safe.
- A **blank reply** carries no fact → passes through unchanged.

Apache-2.0.
