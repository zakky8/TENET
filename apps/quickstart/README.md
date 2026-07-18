# @tenet/app-quickstart

Your first TENET agent, end to end, in three steps — and it runs with **zero API
keys**. It is the smallest *real* composition of the framework: retrieve (BM25) →
draft (any `ChatModel`) → verify (atomic-claim multi-judge) → answer with citations,
or abstain. Nothing is mocked except the model, and even that is swappable for a real
one with a single environment variable.

## Three steps

```bash
# 1. Install (from the repo root)
pnpm install

# 2. Run the REPL — no keys needed; uses the deterministic offline stub model
pnpm quickstart

# 3. (Optional) Point it at a real model
ANTHROPIC_API_KEY=sk-... pnpm quickstart
```

`pnpm quickstart` builds every workspace package and launches
`apps/quickstart/dist/main.js`. Set `TENET_MODEL` to choose the Anthropic model
(default `claude-sonnet-4-6`).

## What you'll see

An example offline session (the banner is printed verbatim by `main.ts`):

```
TENET quickstart — verification-first agent
model: offline stub (set ANTHROPIC_API_KEY for a real model)
Ask about TENET (e.g. "what is the verifier?"). Ctrl+C or "exit" to quit.

you > what is the verifier?

agent > The TENET verifier extracts atomic claims from a draft, then runs a strict judge and a permissive judge over each claim. A claim passes verification only when judged SUPPORTED against the source text.
        sources: docs/ARCHITECTURE.md#verifier
        [verified=true abstained=false 2ms]
```

Every answer carries `verified` / `abstained` flags and the source URIs the claims
were grounded in. Timings vary run to run.

## Offline stub vs. a real model

The zero-key path uses `StubChatModel` — a deterministic model that routes on the
verifier's own prompt markers so the **full** pipeline (draft → claim extraction →
strict + permissive judging) runs offline. Two things to know about it:

- It always grounds its draft in the **top-ranked** retrieved chunk, and its judge
  always returns `SUPPORTED`. So offline you see the retrieve → draft → verify →
  cite mechanics on every question — including an out-of-scope one, which the stub
  answers from the nearest chunk rather than abstaining.
- **Genuine abstention** — the verification-first behaviour where an unsupported
  draft is refused — needs a model that can actually get a claim judged
  `UNSUPPORTED`. That path is exercised in the test suite with a "liar" model
  (`index.test.ts`), and it is what a real model does on a question the knowledge
  base doesn't cover.

Set `ANTHROPIC_API_KEY` and the identical `QuickstartAgent` runs against a real
Anthropic model — same retrieve/draft/verify code, real judgements.

## How it maps to the framework

| Step | Package | What happens |
|---|---|---|
| Retrieve | `@tenet/retrieval` | `Bm25Index.query` ranks the bundled KB against the question |
| Draft | any `ChatModel` | the model answers using ONLY the retrieved KNOWLEDGE block |
| Verify | `@tenet/verifier` | `verifyDraft` extracts atomic claims and judges each (deterministic pre-checks first) |
| Emit / abstain | this app | a passing draft is returned with its citations; a failing one becomes a fixed abstain reply |

The whole agent is ~60 lines in [`src/index.ts`](src/index.ts) — read it top to
bottom to see the guarantee assembled: a fact reaches the user only past the
verifier, and any unsupported claim makes the agent abstain instead of guessing.
