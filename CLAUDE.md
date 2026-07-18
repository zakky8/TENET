# TENET — Operating Manual

TENET is a **verification-first, anti-hallucination agent framework**. The guarantee it exists to keep:
an agent turn either answers with a grounded, verified citation, or it abstains / hands off to a human.
It must **never** state a fact it cannot ground in a source. Every change is judged by whether it moves
the framework toward *enforcing* that guarantee — never toward weakening it.

This file is auto-loaded into context. It is the **durable** contract for how to work in this repo
accurately. Read it before acting. When it and any other document disagree, this file and the code win.

---

## 0. The prime directive: FAIL CLOSED

The worst acceptable outcome of a turn is a **human handoff**, never a wrong answer.

- Any infra failure — extractor error, judge/model timeout, truncation, a parse that doesn't cleanly
  succeed, an unknown branch — must resolve to **abstain or handoff**, never to shipped text.
- There is **no default `answer`**. The only path to member-facing model text is *past* the verify gate.
- A change that makes any path fail *open* (ships unverified text on error) is a regression, full stop —
  even if every test is green. Green tests over a fail-open path are a worse bug than a red test.

---

## 1. Ground truth: the code is the only witness  ⟵ READ THIS TWICE

Accuracy in this repo comes from one discipline: **never assert what you have not observed.**

- **Every factual claim you make — in a commit, a doc, a review, a summary — must be backed by tool
  output you saw THIS session.** `tsc`, `jest`, `grep`, reading the actual file. Not memory, not a doc.
- **Markdown is a HINT, never evidence.** This file, `docs/*`, `.upgrade/PLAN.md`, code comments, prior
  session notes — all carry point-in-time claims that may be stale, aspirational, or simply wrong. They
  tell you *where to look*. They never establish that something *is*.
- **Re-read the actual file before you change it.** Do not trust your own summary of it from ten minutes
  ago. If the code contradicts a doc, the code is the truth and **the doc is the bug** — fix the doc.
- **No repo fact from training memory.** Re-derive package names, file paths, function signatures,
  test counts, and numbers by looking, every time. If you cannot show where a number came from, it is
  `null` with a reason — not a guess.
- **A change is real only when execution proves it.** "I updated X" is a claim; a green gate is evidence.
  Report what the tool actually printed, including failures. If the gate is red, say so with the output.

If you catch yourself writing a fact you did not just verify, stop and verify it or delete it.

---

## 2. The gate (run exactly these — they are the definition of "green")

```bash
pnpm install                     # link workspace deps after any package.json change
pnpm -r build                    # tsc across every workspace package — the typecheck gate
pnpm test                        # full jest suite (node --experimental-vm-modules)
pnpm --filter @tenet/<pkg> build # typecheck a single package (fast inner loop)
pnpm exec jest packages/<pkg>    # run one package's tests (fast inner loop)
pnpm -r lint                     # lint (several packages are still lint-stubbed — see §10)
pnpm counts:check                # docs' test-count claims must equal the LIVE suite (fails on drift)
pnpm readme:check                # README ```ts examples must COMPILE against the real API (run after build)
pnpm test:coverage               # CI's coverage gate — thresholds in jest.config.cjs (loop gate uses plain `pnpm test`)
```

- Toolchain: **Node 24, pnpm 9.15, TypeScript strict, ESM (NodeNext).**
- **`pnpm -r build` green + `pnpm test` green is the minimum bar for any commit.** Observe both. Do not
  commit on an assumed-green gate; run it and read the output.
- A worker-force-exit warning from jest is teardown noise, not a failure — judge by the `Tests:` line.

---

## 3. Repo map (a map, not a spec — open the package's `src/` before relying on it)

The composition spine, in dependency order:

- **`@tenet/core`** — the shared type contract every package depends on: `ChatModel`/`ChatRequest`/
  `ChatResponse`, `AgentState`, `Citation`, `Source`, `NormalizedReply`, `Outcome`. Minimal by design.
- **`@tenet/workflow`** — the graph engine: `Step<I,O>`, `StepContext`, `runWorkflow`, `sequential`,
  `withTimeout`. Deterministic control flow the agent turn is built on.
- **`@tenet/harness`** — cross-cutting turn primitives (e.g. `Handoff`).
- **`@tenet/agent`** — the composition root: drives `AgentState` as a workflow graph
  (pre-handlers → retrieve → a decides-and-drafts `Reasoner` → fail-closed verify → critique → emit |
  abstain | handoff). This is where the guarantee is assembled and enforced.

Supporting groups (verify purpose in `src/` before depending on any):

- **Answer quality / safety:** `verifier`, `refine`, `guardrails`, `governance`, `policy`,
  `net-policy`, `judge-hhem`, `judge-hhem-onnx`, `distillation`, `tool-call-repair`.
- **Retrieval / memory:** `retrieval`, `memory`, `memory-adapters`, `rerank-cohere`.
- **Routing / models / streaming:** `router`, `streaming`, `voice`, `voice-openai-realtime`.
- **Protocol surfaces:** `a2a`, `acp`, `ag-ui`, `skills`, `tools-mcp`, `tools-mcp-gateway`,
  `tools-wasm-sandbox`, `tools-wasm-sandbox-wasmtime`.
- **Ops:** `durable`, `rate-limit`, `telemetry`, `telemetry-otlp`.
- Plus workspace roots `surfaces/*`, `connectors/*`, `models/*`, `stores/*`, `apps/*`, `eval/*`.

---

## 4. Code style (the traps that actually bite here)

- **ESM, `moduleResolution: NodeNext`** → every relative import carries a **`.js` suffix**
  (`import { x } from './foo.js'`), even from a `.ts` file. Jest maps `.js`→`.ts` via `moduleNameMapper`.
- **`exactOptionalPropertyTypes: true`** → an optional field is *absent*, not `undefined`. Build the
  object conditionally (spread `...(cond ? { k: v } : {})`); never assign `undefined` to an optional key.
- **`noUncheckedIndexedAccess: true`** → `arr[i]` is `T | undefined`. Guard before use.
- **Discriminated unions over booleans/optionals** for outcomes (`ReasonerOutput`, `Result`). The union
  should make the illegal state unrepresentable, so the fail-closed rule is enforced by the *type*.
- **No `any`, no non-null `!` to dodge a real check, no silent `catch {}`** that swallows an error into a
  fake success. On error → fail closed (§0), don't paper over it.
- Match the surrounding file's naming, comment density, and idiom. New code should be unable to be picked
  out from old code.

---

## 5. Tests must be REAL, never tautological

A test that passes whether or not the code is correct is worse than no test — it manufactures false
confidence, the exact thing this repo exists to prevent.

- **Every test must FAIL if the behavior it covers regresses.** Before you keep a test, ask: "what
  one-line change to the source would make this go red?" If the answer is "none," rewrite it.
- Watch for vacuous assertions: `.every()` on an array that can be empty, asserting a value equals
  itself, snapshotting a mock's own return. These have bitten this repo before.
- For anti-hallucination logic, the strongest tests assert the **fail-closed edge**: an uncited answer
  → abstain, an error → abstain, a truncated stop → abstain. Write the test that would catch a
  fail-*open* regression.
- No real model access exists at build time. That is fine and intended: drive model-dependent code with
  a **fake `ChatModel`** returning a canned `ChatResponse`. The guarantee is a deterministic
  `ChatResponse → outcome` mapping, so it is provable without a live model.

---

## 6. How to work: ONE checkpoint-safe increment per unit of work

Do not attempt a cross-cutting change in one shot. Land the smallest change that leaves the tree green
and the guarantee intact. The loop below is the required sequence.

- **Stage 0 — Guard against pileup.** `git status --porcelain` must be clean before you start new work.
  If it is dirty, either finish + commit the in-flight increment first, or stash it — never stack a
  second unfinished change on top. No background build running.
- **Stage 1 — Verify the target.** Re-read the actual files the increment touches (§1). Confirm the
  plan still matches reality; if the code has moved on, correct the plan, don't force a stale one.
- **Stage 2 — Implement** the one increment (see §7 rigor, §8 model allocation).
- **Stage 3 — Gate.** Run §2 and OBSERVE it green. A behavior change also needs a real test that would
  catch its regression (§5). A prompt/model-behavior change that cannot be validated without a live
  model must be **flagged as un-validated** in code + PLAN, not silently shipped as done.
- **Stage 4 — Review** (calibrated by §7). For anything touching logic or a guarantee, an independent
  adversarial pass: does it meet the gate, match the spec, weaken any guarantee, leak anything (§10)?
- **Stage 5 — Commit with evidence.** The commit body states what was verified and how (the gate output,
  the test count delta). Then tick the item in `.upgrade/PLAN.md`.

**Stop condition:** if an increment cannot reach a clean, green checkpoint in the work available, write
the evidence and the exact next step into `.upgrade/PLAN.md` under that item and **STOP**. Never
half-land a cross-cutting change. A clean stop is a good outcome; a broken tree is not.

---

## 7. Rigor calibration (match the proof to the risk)

- **Pure type defs, re-exports, doc-only, mechanical rename** → a green `tsc` build *is* the proof.
  Self-review is enough; no independent reviewer, no probe.
- **Logic, control flow, a fail-closed path, anything a member could see, a test that could be fake** →
  independent adversarial review (§8 reviewer), and — where a live model is available — a real-model
  probe with k≥3 before it counts as done. No live model → ship the deterministic core proven with
  fakes, flag the model-dependent part un-validated.

Over-verifying a re-export wastes the budget; under-verifying a fail-closed path breaks the guarantee.
Spend the rigor where a mistake would ship an ungrounded fact.

---

## 8. Model allocation (who does what)

- **Architecture / cross-cutting design** → two capable models argue it: one proposes, one adversarially
  critiques; the decision is synthesized from the argument, never asserted.
- **Writing** (README, SKILL.md, FAQ, docs, ARCHITECTURE, launch copy) → a high-judgment model; voice
  and precision matter.
- **Big self-contained code** (whole-package sweep, multi-file migration, large refactor) → a
  large-context capable model; one reviewer checks the diff.
- **Bounded code** (one specified file/fix/test, exact spec) → an executor model given precise
  *what / how / what-to-use*. It types the decision; it does **not** redesign, widen scope, or "improve"
  the spec. Every such diff is reviewed.
- **Review** → an independent adversarial pass before any logic/guarantee change counts as done.

Never let a bounded executor make an architecture decision or expand scope.

---

## 9. Docs & pages stay in sync with the code (A-to-Z, old pages too)

The repo's own claims are held to the same standard as an agent's answers: **measured, not marketed.**

- When an increment changes a fact the docs state — a test count, an API shape, a capability, a status —
  update every page that states it, in the **same** increment. New pages AND old pages. A stale README
  number is a hallucination in the repo's own voice.
- Keep a **single source of truth** for repeated numbers; never let two pages disagree.
- **No unsourced claim** in README/docs/marketing — no competitor attacks, no benchmark headline that
  isn't reproducible from `eval/`, no capability that isn't in the code. If you can't trace it, cut it.
- Discoverability / AEO/SEO artifacts (`llms.txt`, JSON-LD, structured FAQ, OG metadata, a real
  `SKILL.md`) are part of "done," not an afterthought — but every fact in them obeys §1 too.

---

## 10. Hard rules (non-negotiable)

- **Branch:** work on `upgrade/top-1pct`. Commit locally, freely, with evidence-bearing messages.
- **Push policy:** push to `main` **only at a phase boundary** — a clean, all-green, non-breaking point.
  Before any push: (a) a FINAL SAFETY SCAN of the whole `main..upgrade/top-1pct` diff, (b) gate green,
  (c) fast-forward `main`, (d) push. Between boundaries, do not push.
- **NEVER commit or echo secrets** — API keys, tokens, `.env` contents, credentials. If you see one,
  stop and report; do not include it in any file, commit, or message.
- **NEVER import content from another project** — no brand, tenant config, customer data, or a single
  customer's words from any private build. Every lesson is generalized to a domain-agnostic form. TENET
  ships nothing that isn't its own.
- **`.upgrade/` is local-only** (git-excluded) — it is orchestration scratch, never pushed.
- **Commit messages** follow the repo's conventional style (`feat(pkg): …`, `fix(pkg): …`,
  `refactor(pkg): …`, `docs: …`, `chore: …`) and state the evidence, not just the intent.
