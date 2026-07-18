# Changelog

All notable changes to TENET are recorded here. Format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 the API surface and behavior may change without major bumps. We will pin breaking changes by minor version (`0.X.Y`).

## [Unreleased]

### Changed — the turn driver's reasoner-decision switch is now exhaustiveness-guarded + fails closed on an unmappable decision (2026-07-18)
`criticLoop` (the central turn driver) `switch`es on `ReasonerOutput.kind` (`abstain | handoff | tool |
answer`) — the point where a model decision becomes an outcome. It had no `default`, so an unexpected variant
fell through to the next loop iteration: today that *incidentally* fails closed via the `maxAttempts` abstain,
but it's not enforced — a loop refactor could turn it fail-OPEN, and meanwhile it burns `maxAttempts` model
calls on a decision it can't map. Added an exhaustiveness `default`:
- **Compile-enforced (CLAUDE.md §4):** `const unexpected: never = decision;` — a future `ReasonerOutput`
  variant that isn't handled above now fails `tsc`, forcing a conscious decision (illegal states
  unrepresentable). Verified it compiles today (the switch *is* exhaustive over the 4 variants).
- **Runtime fail-closed:** any unmappable decision abstains IMMEDIATELY (`unexpected reasoner decision: …`),
  not after looping `maxAttempts` times — never a shipped answer, never wasted model calls.
1 regression test (an unmappable decision kind → abstain with `reasonCalls === 1`). Mutation probe
non-vacuous: reverting the `default` to fall-through reddens it (`"no answer within 5 attempts"` + 5 reason
calls instead of 1). Docs synced (ARCHITECTURE turn-driver line; counts 1300→1301). `pnpm -r build` green;
suite 1300 → **1301** (+1).

### Added — `pnpm inventory:check`: docs' surface/model adapter counts are gated against the filesystem (2026-07-18)
A structural count in the repo's own voice ("9 surface adapters", "6 model adapters") is held to §1 like the
test count — the only witness is the tree. This drift is REAL: `AGENTS.md` had said "Surfaces (12)" while
`ls surfaces/` was 9 (fixed 349940a). `scripts/check-inventory.mjs` (`pnpm inventory:check`, now a CI step)
computes the live counts from `surfaces/` (minus `core`, which is shared infra, not an adapter) and `models/`,
then FAILS on any tracked doc whose adapter-count claim disagrees — across the digit phrasings the docs use
(`N surface adapters`, `N surfaces`, `Surfaces (N adapters)`, `N model adapters`, `Models (N)`).
`docs/CHANGELOG.md` is excluded (it records old counts verbatim, e.g. this entry). Mutation probe **non-vacuous
across all five pattern branches**: bumping a doc's count in each phrasing (e.g. `9 surface adapters`→8,
`Surfaces (9 adapters)`→12, `Models (6)`→7) reddens the gate; files restored byte-identical. Currently 19
claims across 8 docs all match live `9 surface adapters / 6 model adapters`. Tooling/docs only — no TypeScript
source or test changed, so `pnpm -r build`/`pnpm test` are unaffected (green at parent `f26e491`); suite
unchanged at 1300/97. Closes the flagged "surface/model-count gate" follow-up.

### Added — long-history compaction is now a fail-closed pre-step in the agent turn (2.4, 2026-07-18)
`@tenet/harness` shipped a `ContextCompactor` (summarize the middle of an overflowing conversation to fit a
token budget) but nothing consumed it — `git grep ContextCompactor` outside `packages/harness/` returned
nothing, so a long conversation history was sent to the model verbatim, risking a silently truncated prompt
that drops the grounding sources. Wired it into the turn as an OPT-IN pre-step:
- **`HistoryCompactor` port + `compaction?` on `AgentDeps`** — a narrow port over `ConversationMessage`
  (structurally satisfied by a concrete `ContextCompactor` at composition, since `Role` ==
  `HarnessMessage`'s roles). Absent = history used verbatim, so every existing caller is unchanged.
- **`compactNode`** runs at `injectionGate → retrieveNode → cacheNode → **compactNode** → criticLoop` —
  after the fail-closed pre-nodes (so `halting` skips it on a blocked/thin-retrieval turn; it only pays the
  summarizer cost when the turn will actually reason) and before the reasoner reads `history`. **FAILS
  CLOSED:** a compaction error → abstain, never a truncated prompt; `withTimeout` bounds a hung summarizer.
  The compacted history is not trusted — it still flows through the same verify/emit edge, so a summarizer
  hallucination cannot emit (the verifier checks the draft against *sources*, not history).
- **`@tenet/workflow` `sequential`** gained a 5-step typed overload (the runtime was already variadic; this
  is a pure-type addition so the now-5-stage graph type-checks) — a green `tsc` is its proof.

6 new tests (4 `compactNode`: opt-in passthrough / replaces history / **error→abstain** / signal-threaded;
2 `runAgent` E2E: the compactor runs on the full 40-message history then the turn still emits, and a
compaction error abstains the WHOLE turn before the reasoner is reached). Mutation probe non-vacuous:
flipping the catch to fail-open reddens both fail-closed tests — the E2E even distinguishes it (fail-open
reaches the exploding reasoner → `"reasoner error"`, not `"compaction error"`). Docs synced (ARCHITECTURE
pipeline snippet + node list, ROADMAP + PENDING graph strings). `pnpm -r build` green; suite 1294 → **1300**
(+6). Composition note: the concrete `ContextCompactor`→`HistoryCompactor` adapter (with a model summarizer)
is app-level wiring, same as the other ports; this ships the CAPABILITY, fake-proven end to end.

### Changed — purge cross-project references + a fabricated star-count from tracked files (2026-07-18)
TENET ships nothing that isn't its own: every lesson is generalized, no other project's brand/words are
imported (a hard rule), and no number lives in the repo unless it traces to a source (§1/§9). A tree sweep
(`git grep -i openclaw`) found **6 tracked files** attributing TENET's patterns to an external "OpenClaw"
project — and the `Dockerfile` decorated it "(376k★)", a star count no repository on GitHub has (the largest
is ~400k; the actual OpenClaw game project has ~6k), so the figure is fabricated regardless of what OpenClaw
is. Generalized every one to describe the pattern on its own merit, preserving all technical substance:
- `Dockerfile` — dropped "Pattern borrowed from OpenClaw audit (376k★)"; kept every hardening bullet
  (multi-stage, SHA-pinned bases, non-root uid 10001, tini PID 1, HEALTHCHECK, loopback default).
- `.pre-commit-config.yaml` — comment now describes the shift-left hooks directly (hygiene, secret scan,
  Actions audit, per-package typecheck).
- `packages/net-policy/src/index.ts`, `packages/tool-call-repair/src/index.ts` — removed the "Borrowed from
  OpenClaw audit" JSDoc lines; the SSRF/credential-leak and bad-JSON-repair rationale stands unchanged.
- `packages/skills/{package.json,src/index.ts}` — "(Claude Code / OpenClaw convention)" → "compatible with
  the Claude Code SKILL.md convention" (SKILL.md is a real, public Claude Code format — a legitimate interop
  statement, kept); also dropped the unsourced "rising as the agent-skill standard" trend claim (§9).
Left intact: the legitimate `CODE_OF_CONDUCT.md` Contributor-Covenant attribution and internal "…from TENET"
references. Comment/description-only — no behavior change; `pnpm -r build` green, `pnpm test` **1294/97
green** (unchanged), post-edit `git grep -i openclaw` and the star-count scan both return nothing.

### Fixed — `AGENTS.md` reconciled against the code (removed ungrounded + stale claims, 2026-07-18)
The public operating manual is held to §1/§9 like any other doc — a claim contributors rely on that isn't
backed by the code is a hallucination in the repo's own voice. Re-verified every factual claim in `AGENTS.md`
against the repo this session (`ls`/`grep`/reading `ci.yml` + `.pre-commit-config.yaml` + `package.json`) and
corrected the ones that were wrong:
- **Cut the `OWNER_ID` / VPS / "owner-only sensitive ops" / "no public emails" rule** — `git grep OWNER_ID`
  and `VPS` matched **only `AGENTS.md`**; zero code implements any of it. It was bot-shaped boilerplate that
  does not describe this framework. Replaced discipline #7 with the rule that *is* the framework's contract —
  **fail closed** (infra error/timeout/truncation → abstain-or-handoff; no default `answer`; unverified text
  on an error path is a regression even with green tests).
- **"Single-branch policy … No feature branches"** contradicted `ci.yml`'s own `pull_request: branches:[main]`
  trigger (and the actual working branch). Restated as what CI actually does: `main` is the integration
  branch; CI runs on pushes to `main` and PRs targeting it.
- **"Surfaces (12)"** disagreed with its own 9-item list and every other doc ("9 surface adapters"). `ls
  surfaces/` = 9 adapters + `core` (shared infra). Fixed to "9 adapters + ticketing connectors".
- **Security section corrected to the real CI/pre-commit config**: dropped **Semgrep** (referenced nowhere in
  `ci.yml` or `.pre-commit-config.yaml`); the `pnpm audit` CI job is informational (`--audit-level critical`,
  `continue-on-error`), not a `--audit-level=high` gate (that value is the pre-push hook); Trivy is CI
  report-only (SARIF → Security tab); `actionlint`+`zizmor` run via pre-commit.
- **Commands block** now lists the real gates it was missing — `test:coverage`, `counts:check`,
  `readme:check`, `jsonld:check` — and the `pnpm lint` note is exact: **63/63 packages carry the
  `echo 'no lint yet'` stub, zero have a real lint script**, so "no-op stub in every package".
- **Dropped the unsourced "caught 20+ real bugs"** boast (§9: a number must trace to a source).

Left untouched what verified TRUE: Node 22 (`.nvmrc`=22, `engines>=22`, consistent across README/CONTRIBUTING/
ARCHITECTURE), Models (6), HHEM-2.1 (Vectara `hhem-2.1-open`), the `stores/{vector,state}` convention, and the
15-package "already shipped" table (all dirs confirmed present). Docs-only; no TypeScript source or test
changed, so `pnpm -r build`/`pnpm test` are unaffected (green at parent `49a726c`). `counts:check` /
`readme:check` / `jsonld:check` all green, no drift. Suite unchanged at 1294/97.

### Added — FAQ page emits `FAQPage` JSON-LD, now gated by `pnpm jsonld:check` (2026-07-18)
Structured data is machine-readable content the repo emits in its own voice, so it is held to §1 like any
other claim: a malformed or empty block is a broken promise to crawlers shipped silently. Two parts:
- **`FAQPage` JSON-LD on `docs/FAQ.md`** — a `<script type="application/ld+json">` block with 12 `Question`
  entries whose `name`s match the page's 12 visible `##` headings verbatim and whose `acceptedAnswer.text`
  is a faithful plain-text rendering of each visible answer (Google requires JSON-LD FAQ content to match
  the visible content). Completes the 7.3 AEO pairing (`SoftwareSourceCode` on `docs/index.md` landed
  earlier; `FAQPage` was the remaining half).
- **`scripts/check-jsonld.mjs` (`pnpm jsonld:check`, now a CI step)** — parses every `application/ld+json`
  block in the tracked docs and FAILS on a parse error, a wrong `@context`, a missing `@type`, or a
  `FAQPage` with an empty `mainEntity` / a blank `acceptedAnswer.text`. Mutation probe non-vacuous: an
  unquoted JSON value (parse break), a wrong `@context`, and a blanked answer each redden the gate; the
  file restores byte-identical afterward.

Also purged a residual unsourced comparative the owner-session audit missed on this page: the "Does TENET
run the model" answer claimed the framework makes a model "more grounded, cheaper per resolution, and
harder to jailbreak" — an unsourced performance/security claim (§9). Rewritten to the guarantee it can
actually keep: "answer only with a source-grounded, verified citation or abstain." Docs-only + a new
standalone gate script; no TypeScript source or test changed, so `pnpm -r build`/`pnpm test` are unaffected
(green at parent `8472666`). Suite unchanged at 1294/97.

### Security — `MistralApiError` now scrubs secrets from its message + body (2026-07-18)
`MistralApiError` stored and echoed the RAW Mistral error-response body (`.body` unredacted, message =
`body.slice(0,200)`), so a Mistral error that echoed the request's `Bearer` token / `authorization` header /
`api_key` could surface a live credential — the one adapter still missing the scrub the openai + matrix
adapters already had. Added `scrubMistralSecrets` (Bearer / authorization / `api_key` JSON field → `[redacted]`)
and applied it to BOTH the message and the stored `.body`, mirroring `OpenAiApiError` exactly. A model-adapter
error must never surface a credential. 3 regression tests (Bearer + authorization scrubbed from message and
`.body`; `api_key` JSON scrubbed; body bounded to 200 chars); mutation probe non-vacuous (reverting to the raw
body reddens both scrub tests). Closes the "MistralApiError does not scrub secrets" security follow-up (found
by the 1.2b-i review). Suite 1291 → 1294 (+3).

### Added — Matrix surface is a supervised, deployable `/sync` loop (5.2 COMPLETE → Phase 5 done, 2026-07-18)
The Matrix surface already had an injected-fetch transport + a `/sync` long-poll, but the loop **threw on any
non-2xx** — a single 503/429 killed the bot — and it yielded the bot's OWN messages (a reply-loop). Made it
genuinely deployable:
- **Supervised loop with backoff+jitter.** A transient failure (fetch throw, or a 429/408/5xx classified by
  `@tenet/rate-limit`'s `isRetryable`) now backs off with jittered exponential delay and RETRIES instead of
  crashing; a good sync resets the schedule. `initialBackoffMs` / `maxBackoffMs` / `backoffJitter` / `sleep` /
  `random` are injectable (deterministic under test). This wires the resilience taxonomy into a surface.
- **Token-expiry handling.** A 401 (M_UNKNOWN_TOKEN) throws a distinct `MatrixTokenExpiredError` (a
  `MatrixApiError` subclass) — the surface can't re-auth itself, so it STOPS with an actionable signal for the
  supervisor to obtain a fresh token; it does NOT burn requests retrying a dead token. Other 4xx stay fatal.
- **Self-message filter.** A new `userId?` option drops events whose sender is the bot's own mxid.

3 new tests (transient-5xx-recovers, 401→MatrixTokenExpiredError, 400→fatal-no-retry, self-filter) + 2
non-vacuous mutation probes (5xx-throws-instead-of-backoff reddens the recovery test; removing the self-filter
reddens the self-filter test). Suite 1288 → 1291 (+3). **5.2 COMPLETE → PHASE 5 DONE** (5.1 resilience family,
5.2 deployable surface, 5.3 surface hardening all landed; the Phase-5 gate — a surface refuses an ungrounded
reply + a failover test passes — is met).

### Changed — de-fork the two HS256 JWT verifiers into `@tenet/surface-core` (5.3 COMPLETE, 2026-07-18)
The REST and web-widget surfaces each shipped their OWN copy of an HS256 JWT verifier — and the copies had
already drifted once (the web-widget copy silently lost its `alg` + `nbf` checks; fixed in 981be3c). One
shared, hardened implementation now lives in `@tenet/surface-core` (`jwt.ts`: `hs256Verifier` + `JwtClaims` /
`JwtVerifier` / `JwtError`, with the alg-confusion + nbf + timing-safe hardening), and both surfaces
**re-export it** so there is a single source of truth that cannot drift again. Public APIs are unchanged:
web-widget re-exports `hs256Verifier` / `JwtError` / `JwtClaims` / `JwtVerifier` 1:1; REST re-exports
`hs256Verifier as hs256RestVerifier` and aliases `RestJwtClaims` / `RestJwtVerifier` to the shared types — so
both surfaces' existing tests pass unchanged, now exercising the shared impl through their public API. Added a
canonical JWT test suite in surface-core (valid, alg:none/RS256 confusion with a valid HMAC, nbf future/past,
exp, malformed, bad-sig, missing-claims). MUTATION PROBE proves the de-fork's value: removing the alg check in
the ONE shared impl reddens the alg-confusion tests of BOTH surfaces at once. Suite 1278 → 1288 (+10 canonical
tests), 96 → 97 suites. **5.3 COMPLETE.**

### Added — REST surface enforces the grounded-render gate (5.3, Phase-5 gate MET, 2026-07-18)
`RestSurface` gains an opt-in `groundedFallback?: string`. When set, the surface REFUSES to render a
non-stream `/v1/converse` reply that carries no grounded citation — it returns the safe fallback (citations
zeroed) INSTEAD of the possibly-ungrounded reply text, so no ungrounded fact reaches a client even if a reply
reached the wire bypassing the agent's emit edge. Opt-in on purpose (an echo/passthrough deployment isn't
making grounded claims; a grounded-or-abstain deployment turns it on), so existing behavior is unchanged when
unset. This satisfies the Phase-5 gate: "a surface refuses to render an ungrounded factual reply." Streaming
(`/v1/converse/stream`) is NOT gated — grounding a token stream before its citations are known is a distinct
problem (buffer or post-verify), flagged for later. 3 E2E tests through the HTTP handle (refuses an uncited
fact-bearing reply → fallback; renders a grounded reply as-is; opt-in when unset); mutation probe non-vacuous
(bypassing the gate leaks the fact and reddens the refusal test).

**Relocated `@tenet/surface-core` → `surfaces/core/`** (from `packages/surface-core/`): the `@tenet/surface-*`
name maps to `surfaces/*` in jest's moduleNameMapper, so the package could not be imported from `packages/`.
The move makes it convention-correct (resolves automatically, no config hack). Same name, same 63-package
count. Suite 1275 → 1278 (+3).

### Added — `@tenet/surface-core` grounded-render gate (5.3 partial, 2026-07-18)
A new package with `groundedRenderGate(reply, { fallback })` — a fail-closed, last-mile grounding guard for
the surface send path. The agent's single emit edge already refuses to ship an uncited fact, but a surface
can be handed a reply from a path that bypassed it (a cache, a fast-path, a bug); this gate is the belt-and-
suspenders: a reply renders as-is only if it carries a **grounded citation** (non-blank source id AND quote —
the same bar the emit edge applies); a fact-bearing reply with no grounded citation is **refused**, rendering
the operator's safe `fallback` INSTEAD of the ungrounded text; a blank reply carries no fact and passes
through. Citation-based on purpose: it does not try to tell a legitimate abstention from a fabricated fact
that lost its citation — it treats both as not-renderable-as-an-answer and substitutes the fallback, which is
strictly safe. Pure, no provider deps (`@tenet/core` `Citation` only). 6 tests (the refusal of an ungrounded
fact-bearing reply front and centre); mutation probe non-vacuous (rendering the ungrounded text reddens it).
Also establishes the shared `@tenet/surface-core` home the JWT de-fork (5.3a) will move into. STILL OPEN in
5.3: wire the gate into a surface send path (E2E "a surface refuses"), and the JWT de-fork. Workspace now 63
packages; suite 1269 → 1275 (+6), 95 → 96 suites.

### Added — cross-provider `failover` chain, fail-closed (5.1 complete, 2026-07-18)
`failover(providers, opts)` in `@tenet/rate-limit` runs providers in order and moves to the next ONLY on a
transient failure — the fail-over decision is the `isRetryable` taxonomy, so it fails over on a 5xx/429/network
error (the current provider is unhealthy) but NEVER on a fatal class: an AbortError (a cancelled turn must stay
cancelled, not silently re-issued elsewhere) or a 4xx (a bad request/auth fails identically on every provider).
This is the "router MUST NOT fail over on AbortError/4xx" rule as a one-line predicate. Orthogonal to
`retryWithBackoff` — wrap each provider callable in it to retry transient errors on that provider first, then
let `failover` move on once its retries exhaust; the two compose without either knowing about the other. On
exhaustion or a fatal error it re-throws the ORIGINAL error, never a shipped fallback. 9 tests (fail-closed
AbortError/4xx no-failover front and centre; a real composition test with `retryWithBackoff`); mutation probe
non-vacuous (a blind-failover default reddens both fail-closed tests). This completes 5.1's resilience family
(taxonomy → retry-with-backoff → circuit breaker → failover). Suite 1260 → 1269 (+9), 94 → 95 suites.

### Hardened — `counts:check` now also gates the landing page + `llms-full.txt`
Added `docs/index.md` and `llms-full.txt` to the tracked-docs list in `scripts/check-counts.mjs` — both carry
the live test-count claim now, and neither was gated, so the public landing page could silently go stale (the
exact hallucination-in-the-repo's-voice the gate exists to catch). Verified non-vacuous: a planted drift in
`docs/index.md`'s count now fails `pnpm counts:check`.

### Added — wire the CircuitBreaker into `retryWithBackoff` (5.1 partial, 2026-07-18)
`retryWithBackoff` gains an optional `breaker?: CircuitBreakerLike`. When the breaker is OPEN the call is
short-circuited with a `CircuitOpenError` **before `fn` runs** — the retry layer never hammers a failing
upstream (a blind loop on 401/403 is the documented Cloudflare egress-IP-ban risk the breaker exists to
prevent). A success resets the breaker; an AUTH failure (401/403 — via the new `isAuthFailure` predicate)
counts toward opening it, while a 429 (rate-limit, not auth) and every other error deliberately do NOT. The
breaker surface is a structural `CircuitBreakerLike { allow / recordSuccess / recordAuthFailure }` (the real
`CircuitBreaker` satisfies it — testable with a fake, no forced instance). `CircuitOpenError` classifies as
fatal, so it is never itself retried. 7 tests incl. an integration test with the REAL `CircuitBreaker`
(consecutive 401s open it → the next call short-circuits, `fn` never called); 2 mutation probes non-vacuous
(removing the short-circuit or the auth-failure recording each redden 2 tests, incl. the real-breaker case).
Suite 1254 → 1260 (+6). STILL OPEN in 5.1: the cross-provider failover chain (keyed on `retryClass`).

### Fixed — refresh the stale Phase-3 status in ARCHITECTURE §0 (docs-sync, 2026-07-18)
`docs/ARCHITECTURE.md` §0 "Implementation status" claimed Phase-3 "truncation/maxClaims hardening remain" —
a stale status that shipped fires ago (a stale repo fact is a hallucination in the repo's own voice).
Corrected against the CODE, re-verified this fire: the Reasoner abstains on a `max_tokens`/refusal/aborted
stop (`reasoner.ts`), an over-cap claim extraction throws `ClaimExtractionError` under `failClosed`
(`claimExtractor.ts`), and `defaultPreChecks` fails a fabricated number/spelled-amount/URL before any judge
(`deterministic.ts`: `numericFabricationCheck`/`parseSpelledNumbers`/`urlFabricationCheck`); `groundedOrAbstain`
(3.4) ships in `@tenet/refine`. §0 now states Phase 3 effectively-complete (only 3.2's named-entity + negation
guards deferred until a real judge) and Phases 4–5 in progress. Doc-only; suite unchanged (1254/94).

### Added — `retryWithBackoff` fail-closed retry wrapper in `@tenet/rate-limit` (5.1 partial, 2026-07-18)
`retryWithBackoff(fn, opts)` retries an outbound call with jittered exponential backoff, and it fails CLOSED
by construction: the default retry decision is the `isRetryable` taxonomy, so a fatal error (AbortError, 4xx,
or anything unrecognized) is re-thrown on the FIRST attempt with no backoff — only known-transient errors
(429/408, 5xx, transient socket codes) are retried. This is the deliberate opposite of `@tenet/workflow`'s
generic `retry`, whose default `shouldRetry` is `() => true` (retries any throw, including a cancelled call);
the model-call wrapper lives in rate-limit precisely so it can consume the taxonomy without inverting the
workflow→rate-limit layering. Backoff is exponential with FULL JITTER by default (delay ∈ (0, base], capped
at `maxDelayMs`) to de-correlate concurrent clients off a recovering upstream; `sleep`, `random`, and
`shouldRetry` are injectable so the schedule is deterministic under test, and an abort during a backoff wait
rejects immediately. On exhaustion it surfaces the ORIGINAL error, never a shipped fallback. 11 tests (the
fail-closed no-retry cases for AbortError / 4xx / unknown are front and centre; plus the exponential+cap
schedule and the jitter formula); 2 mutation probes non-vacuous (blind-retry default reddens all 3
fail-closed tests; removing jitter reddens the jitter test). Suite 1243 → 1254 (+11), 93 → 94 suites. STILL
OPEN in 5.1: wire the CircuitBreaker into this wrapper, and the cross-provider failover chain.

### Added — retryable-vs-fatal error taxonomy in `@tenet/rate-limit` (5.1 partial, 2026-07-18)
`classifyError(err) → { retryClass: 'retryable' | 'fatal', reason }` + `isRetryable(err)` — the foundation a
resilience layer (retry / backoff / cross-provider failover) must consult BEFORE any retry. Encodes 5.1's
fail-closed rules: an **AbortError is fatal** (a cancelled request must stay cancelled — retrying defeats
cancellation and can duplicate a side effect); **4xx is fatal** (a client error fails identically on retry,
and 401/403/429 blind-retries risk an egress-IP ban — the existing CircuitBreaker's own concern); **429/408
and 5xx are retryable** (transient — with backoff); known transient socket/DNS codes (ECONNRESET, ETIMEDOUT,
…) are retryable. Everything unrecognized is **fatal** — a non-idempotent call is never blindly re-sent on an
error we cannot classify. Pure + duck-typed on `name`/`status`/`code`, so it works across model adapters and
`fetch` impls without importing them. 9 tests across every branch (incl. AbortError-wins-over-503 and the
fail-closed unknown/null/string cases); 3 mutation probes non-vacuous (abort→retryable, unknown→retryable,
4xx→retryable each redden). Suite 1234 → 1243 (+9), 92 → 93 suites. STILL OPEN in 5.1: the retry-with-jittered-
backoff wrapper, wiring the CircuitBreaker, and the cross-provider failover chain (all consume this taxonomy).

### Security — harden the web-widget HS256 JWT verifier to REST parity (5.3 partial, 2026-07-18)
The web-widget surface's `hs256Verifier` was the weaker of the repo's two HS256 verifiers: it verified the
HMAC signature but never checked the header's `alg`, and never checked `nbf`. Two gaps closed, mirroring the
already-hardened REST `hs256RestVerifier`:
- **alg-confusion / alg:none:** the header's `alg` is now asserted to equal `HS256` BEFORE the signature is
  checked. A token whose header claims `alg:none` or `alg:RS256` is rejected even when an HMAC over
  `header.payload` happens to match — exactly the case a signature-only check waves through. (Never trust the
  header's alg.)
- **nbf (not-before):** a token whose `nbf` is in the future is now rejected as "not yet valid", not just an
  expired one; `nbf` added to `JwtClaims`.

4 regression tests, all DISCRIMINATING: the alg-confusion tokens carry a VALID HMAC (signed with the real
secret), so a signature-only verifier would accept them — mutation-removing the alg check reddens both;
removing the nbf check reddens the not-yet-valid test. Suite 1230 → 1234 (+4). STILL OPEN in 5.3: the DRY
de-fork of the two now-parallel verifiers into a shared `@tenet/surface-core` (a public-API refactor across
both surfaces — its own increment), and moving the grounding gate into the surface send path.

### Added — README fenced-TypeScript gate + fixed the measure-real usage example (4.gate, 2026-07-18)
`pnpm readme:check` (`scripts/check-readme-ts.mjs`, now a CI step + in the repo's gate list) extracts every
` ```ts ` block from a tracked README, writes it into the owning package's `examples/` dir (so workspace
`@tenet/*` imports and ESM top-level `await` resolve as an operator's copy would), and typechecks it with
`tsc --noEmit`. A usage example that no longer compiles is stale code in the repo's own voice; the gate fails
CI the moment one drifts from the API it documents. Caught + fixed REAL drift in `apps/measure-real/README.md`:
its `ts` example imported a non-existent `REAL_TARGETS` export and constructed `AnthropicChatModel` with ONE
argument (the real constructor is two — an injected `http` transport, then options), and used the stale model
id `claude-sonnet-4-5-20250929`. Rewrote it to a complete, compilable snippet (two-arg constructor with a real
`http` shape, `claude-sonnet-4-6`); synced the same stale id + the phantom `REAL_TARGETS` out of `cli.ts`'s
usage comment, the canonical `examples/anthropic-sonnet.ts`, and `.github/workflows/measure-real.yml`.
Non-vacuous: re-introducing the one-arg constructor makes the gate exit 1. (Also newly typechecks the
canonical example, which the app build's `include: ["src/**/*"]` had never covered.) Suite unchanged (1230/92).

### Fixed — community-bot no longer hardcodes costUsd: 0 (4.3 partial, 2026-07-18)
The community-bot reference recorded `costUsd: 0` on every outcome (a fabricated "free" measurement,
commented "cost meter integration is Phase 2"). Fixed with the same structural CostMeter wiring as
enterprise-support: a `costMeter?: CostMeterLike` (`{ total(): number }`, satisfied by `@tenet/telemetry`'s
`CostMeter` — no new dependency) is read at outcome time; unmetered defaults to 0 explicitly, never a
fabricated figure. Cost is recorded on all three outcome paths (resolved / verifier-rejected / model-error).
TRUST-CODE correction to the PLAN: community-bot's `verifierPassed` was NOT the enterprise-support
fabrication — it already runs `verifier.verify()` and reports the real verdict (`true` on pass, `false` on
reject, `null` on model error), so only `costUsd` needed fixing. 3 new tests (metered resolved, metered
disqualified, unmetered 0); mutation-verified non-vacuous — and the probe caught a `toBeCloseTo(0.0031)`
that was vacuous under the default 2-digit precision (0 ≈ 0.0031), now exact `toBe`. Suite 1227 → 1230 (+3).

### Fixed — enterprise-support telemetry no longer fabricates verifierPassed / costUsd (4.3 partial, 2026-07-18)
The reference dispatcher recorded a FALSE `verifierPassed = true` on every successful dispatch — set
unconditionally right after `agent.handle()`, without observing any verification (and, if `send` then
threw, it recorded `true` alongside a `disqualified` outcome). A telemetry field asserting a verification
that never happened is a hallucination in the repo's own voice. It also hardcoded `costUsd: 0`, a fabricated
"free" measurement. Fixed: `verifierPassed` is now derived from what the dispatcher can HONESTLY observe —
a non-blank reply with ≥1 verifier-approved citation → `true`; an emitted-but-uncited reply (abstention) →
`false`; a dispatch error (no reply) → `null` — it never claims a verification it didn't see. `costUsd` now
comes from an injected `costMeter` (structural `{ total(): number }`, satisfied by `@tenet/telemetry`'s
`CostMeter` with no new dependency); unmetered defaults to 0 explicitly, never a fabricated figure. 5 new
tests (grounded→true, uncited→false, error→null, metered cost, unmetered 0); the uncited→false and metered
tests RED on the old fabricating code (mutation-verified). Suite 1222 → 1227 (+5). STILL OPEN in 4.3:
community-bot has the identical `costUsd:0` / `verifierPassed` pattern (same fix, separate app); the broader
"genuinely wired real verifier + retrieval + console surface" remains a larger follow-up.

### Changed — de-tautologize the eval's QA grounding metric (4.2 partial, 2026-07-18)
The measurement plane's Dim-1 QA path was an **identity pass**: `stubAnswer` cited exactly
`relevantSourceIds` and `stubVerify` checked `cited ⊆ relevant`, so `hallucination_rate` (0.0) and
`groundedness_rate` (1.0) were true *by construction* — no possible input could fail them, yet they are
gated in hermetic CI. A vacuous number reported as a measurement is a hallucination in the repo's own
voice. Fixed: every `QAFixture` now carries a **distractor-bearing corpus** (the relevant chunk plus
topically-adjacent distractors missing the answer's distinctive term), and `stubAnswer` **selects** its
citation by real term-overlap retrieval over that corpus instead of echoing ground truth. The stub still
scores 0.0 / 1.0 — but now as a MEASURED result: a distractor out-overlapping the relevant chunk cites an
ungrounded id and fails verification. Proven non-vacuous: a distractor-dominant fixture makes `stubVerify`
return false (impossible under the old identity), and mutation-reverting `stubAnswer` to the echo reddens
the new tests. Fail-closed: no overlap / empty corpus → no cite → unsupported (never a spurious pass).
All 20 bundled fixtures verified to ground correctly (relevant chunk strictly wins overlap). BENCHMARKS
Dim 1/1b annotated. Suite 1219 → 1222 (+3). STILL OPEN in 4.2: real independent judge, true-TTFT via
`chatStream`, temp>0 determinism split (real-model measurement concerns, deferred).

### Added — quickstart README + network-gated real-model smoke test (4.1, 2026-07-18)
`apps/quickstart` gains a real `README.md`: the true three steps (`pnpm install` → `pnpm quickstart`
zero-key → `ANTHROPIC_API_KEY=… pnpm quickstart`) and **real captured output** (not fabricated — produced
by running the built agent), plus an honest note that the offline `StubChatModel` always grounds its draft
in the top chunk and always judges `SUPPORTED`, so genuine abstention needs a real model (or the liar-model
test). Added a **network-gated real-model smoke test** to `index.test.ts` that runs the same
retrieve→draft→verify pipeline against a real Anthropic model and asserts a verified, cited (non-abstained)
answer. It is registered ONLY when `ANTHROPIC_API_KEY` is set, so the hermetic suite is unchanged (1219/92,
still all green) and its count does not drift; verified BOTH directions (absent with no key, registers +
attempts the real call with a key). Its real-model assertion is un-run in CI (no key) — flagged in code +
PLAN; only its gating + compilation are checked here. TRUST-CODE note: the item's "invalid default model id"
was stale — `main.ts` already defaults to the valid `claude-sonnet-4-6` (`TENET_MODEL` overridable).

### Added — `groundedOrAbstain` reference orchestrator wires `@tenet/refine` fail-closed (3.4, 2026-07-18)
`@tenet/refine` gains `groundedOrAbstain(input, opts)` — the canonical chain of its levers into one
fail-closed grounded-or-abstain turn: knowledge-boundary gate → draft → verify + bounded `repairDraft` →
answer or abstain. It returns a discriminated `GroundedDecision` (`answered` | `abstained` with a
`boundary` / `verify` / `error` stage), takes injected functions only (no provider, no `@tenet/verifier`
import — a caller backs `verify` with `verifyDraft`), and fails CLOSED at every edge: thin retrieval
abstains BEFORE drafting (no draft, no cost), an unsupported draft that repair cannot rescue abstains, and
any draft/verify/rewrite throw resolves to abstain — `status: 'answered'` is returned ONLY past a passing
verifier. This gives `repairDraft` its first in-repo consumer and satisfies the Phase-3 gate: an unsupported
"we do not offer X" scope claim ABSTAINS, never ships (absence of X in sources ≠ positive support for the
negative). 6 E2E tests with fakes (thin-retrieval, first-pass, repair-then-answer, scope-claim-abstain,
verify-throws-fail-closed, aborted-before-draft); 4 mutation probes non-vacuous (gut the emit-only-on-pass
guard, re-throw instead of abstain, drop the boundary/abort early-returns). Suite 1213 → 1219 (+6); no live
model needed (deterministic ChatResponse→decision mapping). refine README + llms.txt updated.

### Added — deterministic check for spelled-out fabricated amounts (3.3, 2026-07-18)
The numeric fabrication pre-check now catches numbers spelled out in words, not just digits: a claim asserting
a currency- or percent-marked spelled amount absent from the sources ("the fee is **five hundred dollars**"
when the price is "$299", "**twenty percent** uptime" when it is "99.9%") FAILS deterministically, closing the
paraphrase-to-words evasion of the digit check. The parser (`parseSpelledNumbers`) feeds the SAME
`extractNumericTokens` used for both claim and sources, so grounding stays symmetric — "five hundred dollars"
matches a source's "$500" and vice-versa, never a false-fail. Conservative by construction: a run needs a
spelled leaf word (a lone "hundred"/"million" is not a number), "and" is absorbed only between number words
("one hundred and fifty thousand"), and — like the digit path — only currency/percent-**marked** spelled
numbers fail by default; a bare spelled count ("five reasons") defers to the judge. Mutation-probed the "and"
absorption and marker detection are load-bearing. Suite 1205 → 1213 (+8); all prior verifier tests unchanged.

### Added — deterministic URL-fabrication check (3.2 partial, 2026-07-18)
`urlFabricationCheck()` joins the verifier's deterministic tier (`defaultPreChecks`): a claim that cites an
`http(s)://` URL appearing NOWHERE in the sources FAILS deterministically — an invented link is a classic,
dangerous hallucination, and it's caught without spending a judge. Enforces TENET's source-grounded-URL thesis.
Conservative by construction to avoid false-fails: only scheme-bearing URLs are checked (so `index.ts`,
`Node.js`, `package.json` are never mistaken for URLs), trailing sentence punctuation is stripped, and grounding
is a scheme/`www`-insensitive substring match (a parent/child path counts as grounded; lookalike-domain misses
defer to the judge rather than false-fail). A URL being present never PASSES a claim. Mutation-probed that the
scheme requirement is what prevents the non-URL false-fail. Suite 1198 → 1205 (+7); 127 prior verifier tests
unchanged (backward compatible). STILL open in 3.2: named-entity coverage + the negation/scope guard.

### Added — coverage gate that protects the actual coverage level (6.2, 2026-07-18)
`pnpm test:coverage` is now a CI step, and the `jest.config.cjs` `coverageThreshold` was raised from the loose
60/70/70/70 floor to **75 branches / 90 functions / 90 lines / 88 statements** — just below the actual
90.3/78.5/94.4/93.0 (small margin). The old floor silently allowed coverage to regress to 60%; the new gate
fails CI on a real drop. Verified: coverage passes at the new thresholds (exit 0); mutation-probed that it
ENFORCES (setting branches to 90 > actual 78.46 failed with "threshold for branches (90%) not met").

### Changed — replace competitor ✓/✗ grids with TENET-only capability tables (7.2, 2026-07-18)
Both README comparison tables ("Where TENET focuses" and "Quick comparison") asserted specific, unverified
capabilities about ~7 named competitors — including "maintenance" (implying AutoGen is abandoned), dated
release claims ("✅ (2026-04)"), and per-vendor pricing ("$0.99 / resolution") that cannot be sourced from
this repo. For an anti-hallucination framework that is the exact unsourced-claim class it exists to prevent.
Replaced both with TENET-ONLY tables that assert only this repo's own capabilities, each backed by a named
package verified to exist in the tree (`@tenet/governance`, `@tenet/verifier`, `@tenet/refine`,
`@tenet/durable`, `@tenet/a2a`, `@tenet/ag-ui`, `@tenet/harness`, `@tenet/judge-hhem`, `@tenet/telemetry`,
`@tenet/tools-mcp-gateway`, `@tenet/tools-wasm-sandbox`, `infra/helm/tenet`, …), with a clear note on WHY.
Also fixed the stale "Multi-surface (10)" / "10 shipped" → 9 surface adapters. No per-competitor grid remains.

### Added — mermaid architecture diagram of the fail-closed turn (7.3, 2026-07-18)
A "How a turn works" section in the README with a mermaid flowchart of `runAgent`'s graph: injection gate →
retrieve + knowledge boundary → cache re-verify → reason → (tool via governance | answer) → verify + citation
guard + leak gate → the single `emit` edge, with every non-emit edge resolving to abstain or handoff. Traced
against the actual `orchestrator.ts` + `criticLoop`; mermaid syntax structurally validated (bracket balance,
edge count). Renders natively on GitHub.

### Fixed — accurate site SEO meta + robots.txt (7.3, 2026-07-18)
`docs/_config.yml`'s `description` (the Google snippet + `og:description` that `jekyll-seo-tag` emits) was
stale/inaccurate: "10 surfaces" but listed 8, and the bare "0 high-severity CVEs" boast. Corrected to the
real "9 surface adapters (Discord, Slack, Telegram, Teams, web widget, REST, gRPC, Matrix, voice)", led with
the grounded-or-abstain guarantee, and replaced the CVE boast with "hardened by construction" (consistent
with the earlier index.md fix; the MEASURED Dim-6 posture stays in BENCHMARKS where it states its method).
Added `docs/FAQ.md` to the site include list so the answer-shaped FAQ is crawlable, and added `docs/robots.txt`
(allow all + a Jekyll-rendered `Sitemap:` pointing at the `jekyll-sitemap` output). YAML validated.

### Added — `docs/FAQ.md` answer-shaped FAQ for AEO/SEO (7.3, 2026-07-18)
A structured FAQ with answer-shaped questions (how TENET prevents hallucination, what grounded-or-abstain
means, is-it-a-LangChain-alternative, supported models/surfaces, how the verifier works, is-it-production-ready,
licensing, getting started). Every answer is measured — capabilities named are code in the tree (6 model
adapters, 9 surface adapters, 4 ticketing connectors, `infra/helm/tenet`), no unsourced competitor claims,
and the production-readiness answer is honest (pre-1.0; adapters transport-injected; in-repo numbers are the
hermetic stub). Linked from `llms.txt`; sets up the JSON-LD `FAQPage` (remaining 7.3).

### Added — `skillToolPolicyRule`: `allowed-tools` is now ENFORCED, not decorative (8.2, 2026-07-18)
`@tenet/skills` gains `skillToolPolicyRule(frontmatter)` → a `@tenet/governance` `PolicyRule` that allows
ONLY the tools a skill declared. Dropped into a `PolicyEvaluator`, a skill physically cannot call a tool it
did not declare (the agent's `runTools` gates every call before execution). FAIL-CLOSED: a skill that
declares no `allowed-tools` may call none. This turns the header's long-standing "governance-aware" promise
(and the package description's "@tenet/governance allowed-tools enforcement") into a shipped, tested helper —
`@tenet/skills` now actually depends on `@tenet/governance`. Tests prove allow-declared / deny-undeclared
(with reason) / deny-all-on-empty. Suite 1195 → 1198.

### Added — flagship `SKILL.md`: build a verification-first, grounded-or-abstain agent (8.1, 2026-07-18)
A repo-root `SKILL.md` (parseable by `@tenet/skills`' own `SkillRegistry`, frontmatter
`name: verification-first-agent`) distilling how to build an agent whose worst outcome is a human
handoff, never an ungrounded fact: the one rule, the fail-closed turn shape, 8 techniques (no default
answer, one emit edge, grounded-citation guard, fail-closed on infra failure, verify-against-sources,
gate-tools-before-run, knowledge-boundary + cache re-verify, required AbortSignal), the anti-patterns that
cause hallucination, a build checklist, and TENET as the reference implementation. Generic and zero
cross-project content. A regression test in `@tenet/skills` reads the shipped `SKILL.md` and asserts it
parses + registers, so the flagship skill can never silently become malformed. Suite 1193 → 1195.

### Added — `llms.txt` AEO index for AI agents / crawlers (7.3, 2026-07-18)
A repo-root `llms.txt` (llmstxt.org format): one-line guarantee, an honest-read context paragraph,
and linked sections (Documentation, Core concepts, What ships today) so an LLM or agent can navigate
TENET without scraping. Every fact is measured — the test count is the live-suite number, and `llms.txt`
was added to `scripts/check-counts.mjs`'s source-of-truth list so its "N tests across M suites" claim is
now gated by `pnpm counts:check` too (proven: a wrong count fails CI). No cross-project content, no
unsourced claims. Remaining 7.3: `llms-full.txt`, JSON-LD (SoftwareSourceCode + FAQPage), `docs/FAQ.md`,
OG image + `og:image`, `robots.txt`, Pages deploy workflow.

### Fixed — reconcile the ROADMAP phase tables to the as-built monorepo (7.2, 2026-07-18)
The ROADMAP's Phase 2/3 tables still said "not started" for surfaces, connectors, stores, the MCP
gateway, WASM sandbox, enterprise-support app, and the Helm chart — all of which actually ship in the
tree (verified this change: 9 surface adapters, `connectors/ticketing` with zendesk/intercom/freshdesk/
servicenow modules, `stores/vector/qdrant`, `@tenet/memory-adapters` with mem0/Letta/Zep providers,
`@tenet/tools-mcp-gateway`, `@tenet/tools-wasm-sandbox(-wasmtime)`, `apps/enterprise-support`,
`infra/helm/tenet`). A "not started" claim for shipped code is a stale-status hallucination in the repo's
own voice. Flipped the stale cells to ✓ with an as-built note (surfaces take an injected transport; the
current-state banner is canonical); kept the genuinely-open items honest (eval-set 1k growth, SOC2 prep).

### Changed — remove unsourced competitor security claims (measured, not marketed; 7.2, 2026-07-18)
An anti-hallucination framework must not ship unsourced attacks on named competitors — that is the
exact self-contradiction it exists to prevent. Generalized every named-competitor CVE/vulnerability
claim to threat-model framing that attributes nothing to any project:
- ARCHITECTURE §1 no longer says named frameworks "shipped CVE-class mistakes"; it describes the
  ecosystem's CVE-CLASS mistake *categories* we design out.
- SECURITY.md "LangChain-class vulnerabilities" → "known agent-framework vulnerability classes";
  BENCHMARKS Dim 6 "the LangChain CVE categories" → "known agent-framework CVE-class categories";
  RESEARCH-PASS-2's LangGraph "CVE history remains a concern" cell → no advisory attributed.
- docs/index.md meta description dropped the bare "0 CVEs" boast (unearned for a new, unaudited
  project) → "hardened by construction". TENET's own MEASURED Dim-6 posture (Trivy / npm audit /
  GitHub Advisories in CI) stays — it states its method. Self-claims about TENET's own hardening
  (no pickle, PathHandle, parameterized queries) are unchanged; those describe this repo's code.

### Added — `counts:check`: the live suite is the single source of truth for doc counts (2026-07-18)
`scripts/check-counts.mjs` (`pnpm counts:check`, now a CI step) runs the suite, reads the real
`numTotalTests`/`numTotalTestSuites`, and fails if any tracked doc's count-claim disagrees — so a
hard-coded "N tests across M suites" in a README can never silently fall behind the suite again (a
stale number is a hallucination in the repo's own voice). Fixed the current drift in the same change:
the README badge/status and several docs still said **1174**; the live suite is **1193 / 92**.

### Fixed — Reasoner abstains on `max_tokens` (truncation → never ship, 2026-07-18)
The decides-and-drafts Reasoner (`packages/agent/src/reasoner.ts`) handled `refusal` and
`aborted` stop reasons but fell through to envelope-parsing on `max_tokens`, so a truncated
response with a parseable-looking answer envelope could ship a cut-off draft. It now abstains
on `max_tokens` alongside `refusal`/`aborted` — a truncated turn cannot be trusted. Regression
test asserts a VALID answer envelope with `stopReason:'max_tokens'` → abstain. Suite 1189 → 1190.

### Added — verifier `failClosed` mode: close the infra fail-open (Phase 3.1, 2026-07-18)
Branch `upgrade/top-1pct`. Test suite: 1181 → 1189 tests across 92 suites, all green.
`VerifierConfig.failClosed?: boolean` (default `false`, preserving existing callers).
Closes a real ship hole: a broken/down JUDGE marked all claims `supported:true` →
`verifyDraft` returned `pass:true` WITH citations → the orchestrator's grounded-citation
guard emitted an unverified answer.
- `claimExtractor.ts`: on extractor error/timeout, throws `ClaimExtractionError` (not `[]`)
  when `failClosed` — so `verifyDraft` returns `pass:false` instead of mistaking a failed
  extraction for zero claims.
- `judge.ts`: a judge error/timeout OR a total-garbage (no-parse) response marks claims
  `supported:false` when `failClosed` (was the fail-open "all supported"). The permissive
  re-judge runs the same broken model, so it stays unsupported → `pass:false`.
- `claimExtractor.ts` (3.3 maxClaims-drop, 2026-07-18): when `failClosed` and the model
  over-produces past `maxClaims`, the extractor throws instead of silently `.slice`-ing off
  the extras → `verifyDraft` → `pass:false`. Previously the dropped claims were never
  verified, so a fabrication past the cap could ship. Suite 1190 → 1193.
- DELIBERATE: a genuinely claim-free draft (greeting; extractor returns `NONE`) still
  passes — it is vacuously grounded; emit policy (require a citation) is the orchestrator's
  job. `failClosed` hardens infra failures, not legitimate empties.
- Default (no `failClosed`) is byte-for-byte the old fail-open behavior (116 prior verifier
  tests unchanged). The reference orchestrator sets `failClosed:true` behind its Verifier port.

### Added — `@tenet/agent` orchestrator SHIPPED: the driven, fail-closed turn (2026-07-18)
Branch `upgrade/top-1pct`. Test suite: 1117 → 1174 tests across 85 → 92 suites, all green.
62 workspace packages. This completes Phase 2's agent turn — `AgentState` was a state machine
nothing drove; it is now driven end-to-end.

- **`runAgent`** (`packages/agent/src/orchestrator.ts`) executes `OrchestratorState` as a
  `@tenet/workflow` graph: `sequential(halting(withTimeout(injectionGate)), halting(withTimeout(
  retrieveNode)), halting(withTimeout(cacheNode)), halting(criticLoop))`, then `finalize`.
- **Pre-reasoning nodes** (`agent/src/nodes.ts`): `injectionGate` (blocked/throwing filter →
  security handoff), `retrieveNode` (thin evidence / retriever error → abstain; boundary gate keys
  on retrieval relevance, not `Source.confidence`), `cacheNode` (hit is a candidate, re-verified).
- **`criticLoop`** (`agent/src/criticLoop.ts`): reason → abstain | handoff | tool | answer; tools
  run through governance (`runTools`, `agent/src/tools.ts` — gate all before executing any;
  deny/`require_approval` → ops handoff), results fold back into history.
- **`verifyAndEmit`** (`agent/src/emit.ts`) is the single emit edge: verify (fail-closed) → require
  ≥1 grounded citation (non-blank `sourceId` + `quote`) → outbound leak gate → emit.
- **Fail-closed backstops:** terminals CARRIED in `state.halt` (never thrown); `finalize` abstains
  on an unset terminal; a top-level catch turns any `WorkflowError`/throw into an abstain.
- **Answer repair-retry** (`criticLoop`): on a `repair` verdict the draft is rewritten via `deps.rewrite`
  (a `RewriteFn`) and re-verified through the SAME emit edge, up to `maxRepairRounds`, then abstains. The
  rewritten draft is never trusted — it re-enters `verifyAndEmit`, so a bad rewrite cannot ship.
- Deferred (does not weaken the guarantee): real-model prompt validation (no model access in this env).

### Added — canonical `ChatModel` contract + `@tenet/agent` Phase 2 start (2026-07-18)
Branch `upgrade/top-1pct`. Test suite: 1051 → 1117 tests across 83 → 85 suites,
all green. 62 workspace packages.

**One canonical `ChatModel` (Phase 1 complete).**
- `@tenet/core` now defines a single `ChatModel.chat(req): Promise<ChatResponse>`
  over a MESSAGES ARRAY (`ModelMessage[]`, `packages/core/src/model.ts:31`), tool
  round-trips via a discriminated `ContentBlock` (`text | tool_use | tool_result`,
  model.ts:14), and a lossless `StopReason` union (`end_turn | max_tokens |
  stop_sequence | tool_use | refusal | aborted`, model.ts:38). It REPLACES the four
  duplicated single-string `chat({system, user}): Promise<string>` interfaces.
- `signal: AbortSignal` is REQUIRED on `ChatRequest`, not optional
  (`packages/core/src/model.ts:57`) — resolves PENDING B3 (un-abortable `chat` →
  zombie HTTP).
- All 6 model adapters (`models/{anthropic,bedrock,google,mistral,ollama,openai}`)
  migrated to the canonical contract; C7 (`models/bedrock` "not yet implemented")
  is DONE — all six adapters exist.
- Three real provider bugs fixed — each an abnormal stop that was being reported as
  a clean completion:
  - Anthropic streaming hardcoded `end_turn`; the real `stop_reason` from
    `message_delta` is now mapped (`models/anthropic/src/index.ts:66,295`).
  - Mistral `model_length` (context-window overflow, a truncation) → `max_tokens`,
    not the default `end_turn` (`models/mistral/src/index.ts:60`).
  - Google content-block finish reasons (`SAFETY`, `RECITATION`,
    `PROHIBITED_CONTENT`, `BLOCKLIST`, `SPII`, `IMAGE_SAFETY`) → `refusal`, not
    `end_turn` (`models/google/src/index.ts:71-76`).
- `@tenet/streaming` re-exports the canonical `StreamChunk` / `StreamingChatModel`
  from `@tenet/core` (its divergent local copy, which typed `stopReason` as a loose
  `string`, was removed — `packages/streaming/src/index.ts:24`); `@tenet/ag-ui`
  aligned its `StreamChunk` to the canonical one.
- `@tenet/verifier`, `apps/quickstart`, `apps/measure-real`, `apps/community-bot`,
  and `@tenet/router` all flipped onto the canonical contract.

### Fixed — canonical migration (2026-07-18)
- **`${role}: ${content}` turn-spoof killed.** community-bot history is now
  STRUCTURED `ModelMessage`s (`apps/community-bot/src/index.ts:114` builds each
  turn via `textMessage(role, content)`), so a member message containing
  `assistant:` can no longer forge a prior assistant turn — the forged text is
  preserved inside a user-role message, not promoted. Covered by a wire-level
  role-spoof regression test in the Anthropic adapter
  (`models/anthropic/src/index.test.ts:131`) and a community-bot test
  (`apps/community-bot/src/index.test.ts:187`).
- **Transitional migration bridges deleted.** `fromLegacyModel`, `asLegacyModel`,
  `LegacySingleStringModel`, and `LegacyChatArgs` are gone — every consumer speaks
  the canonical contract, no bridges remain (grep-clean across `packages/`,
  `models/`, `apps/`).
- The single-string `ChatModel` schism (the recon's "root of no conversation
  memory") is RESOLVED — one messages-array contract; role structure now reaches
  the model.
- PENDING B2 (`PathHandle` had no factory) RESOLVED — `openPath()` ships
  (`packages/core/src/path.ts:58`): allow-list root, with absolute-path and
  `..`-traversal rejection at construction time.

### Added — `@tenet/agent` (Phase 2, in progress, 2026-07-18)
- Orchestrator TYPE CONTRACT: `OrchestratorState extends AgentState`
  (`packages/agent/src/types.ts:45`) + a discriminated
  `ReasonerOutput = answer | tool | handoff | abstain` with NO default `answer`
  (types.ts:68).
- FAIL-CLOSED decides-and-drafts Reasoner (`modelReasoner` + `parseEnvelope`,
  `packages/agent/src/reasoner.ts`): grounded-or-abstain — an `answer` is discarded
  unless it carries at least one non-blank citation (reasoner.ts:99), and every
  ambiguity (envelope parse failure, unknown action, `tool_use` stop with no tool
  blocks, `refusal`, `aborted`, uncited answer) resolves to `abstain`. Proven by 33
  deterministic tests (`packages/agent/src/reasoner.test.ts`).

**Pending at the time of this entry (SINCE SHIPPED — see the top entry):**
- The `runAgent` workflow graph that DRIVES `AgentState` end-to-end. As of the entry
  above it is shipped (`packages/agent/src/orchestrator.ts`): nodes → Reasoner →
  governance-gated tools → verify → single emit edge, all fail-closed.
- The verifier's own fail-closed changes are a later phase (Phase 3). *(Since shipped as the
  `failClosed` mode — see the Phase 3.1 entry at the top.)*
- No real-model benchmark numbers exist yet (no model access in this environment);
  the hermetic stub remains the only measured plane.
- PENDING B1, B4, B5 remain OPEN — not touched by this upgrade.

### Added — Phase 16 (answer-quality engine, 2026-06-11)
Model-agnostic hallucination reduction + smarter/faster responses from
ANY ChatModel:
- **Deterministic pre-check tier in `@tenet/verifier`** — three-way
  `ClaimPreCheck` (pass/fail/judge) before the LLM judges:
  `numericFabricationCheck` fails claims with numbers absent from every
  source (the wrong-number hallucination LLM judges wave through —
  proven by the backwards-compat test), `quoteGroundingCheck` passes
  verbatim-quote claims without a judge call. Every settled claim saves
  1–2 judge calls. Opt-in via `claimPreChecks: defaultPreChecks()`.
- **`@tenet/refine`** — answer-quality orchestration:
  `knowledgeBoundaryGate` (abstain BEFORE drafting on weak retrieval
  coverage — cheapest point to stop wrong info), `repairDraft` (rewrite
  only the unsupported claims and re-verify, bounded rounds, full
  verifier still gates), `bestOfN` (parallel drafts ranked by
  supported-claim ratio — buys quality from small/local models),
  `selfConsistency` (claims that flip across samples = confabulation
  signal, SelfCheckGPT applied at claim level).

### Added — Phase 15 (top-0.01% market gaps, 2026-06-10)
A fresh A-to-Z repo audit (3 parallel reviewers) + live market research over the
June-2026 framework landscape (LangGraph 1.0, OpenAI Agents SDK 2026-04, Vercel
AI SDK 6 + WDK, Mastra 1.x, Pydantic-AI v1.107, MS Agent Framework 1.0, Google
ADK 2.x, A2A v1.0, AG-UI, MCP 2026-07-28 RC) identified the three TypeScript
open lanes. All three shipped, plus the audit's DX + truth findings:
- **`@tenet/durable`** — step-level durable execution: name-keyed journal
  memoization (Promise.all-safe), `interrupt()` human-in-the-loop that survives
  process restarts, durable `sleep()`, `NondeterminismError` replay-drift
  guard, `StateStoreJournal` over Redis/Postgres state stores. 16 tests.
- **`@tenet/a2a`** — Agent2Agent protocol v1 server (AgentCard, task
  lifecycle, tasks/cancel aborts in-flight handlers) + fetch-injected client
  (well-known card discovery, sendMessage/getTask/cancelTask). 15 tests.
- **`@tenet/ag-ui`** — AG-UI event protocol: typed event union,
  lifecycle-enforcing `AgUiRunEmitter`, `streamChunksToAgUi` bridge so all 6
  streaming model adapters drive AG-UI frontends, SSE encoder. 16 tests.
- **`@tenet/harness`** — long-horizon layer: token-budget `ContextCompactor`
  (pinned system prompts, verbatim recent window), `TodoLedger` with JSON
  round-trip, `spawnSubagents` bounded-concurrency fan-out with error
  isolation + `Handoff` descriptor. 15 tests.
- **`apps/quickstart`** — `pnpm quickstart`: full retrieve→draft→verify REPL
  with ZERO keys (deterministic stub routes on the verifier's own prompt
  contract) or `ANTHROPIC_API_KEY` for a real model. 4 tests.
- **`@tenet/stores-state-postgres`** — the dir existed empty; now a real
  package: single-table KV, lazy TTL, atomic one-round-trip `incr()` with
  Redis-compatible expiry semantics, table-name injection guard. 8 tests.
- **Bedrock streaming** — `chatStream()` via injected
  `InvokeModelWithResponseStream`; task #83 had claimed this shipped in P8 and
  it had not (caught by the audit, fixed under the truth-restoration rule).
  6 tests.

### Fixed — Phase 15
- Removed the empty `surfaces/webhook/` directory (ticketing connectors live
  in `connectors/ticketing`).
- README drift: "3 model adapters" → 6 (all streaming), the README's several
  inconsistent test counts reconciled to a single reported figure (the canonical
  total has since advanced to 1174 tests across 92 suites — see the 2026-07-18
  entry above), surface arithmetic corrected to
  9 surfaces + 4 ticketing connectors, stale competitor-table HITL marks
  updated against June-2026 reality (LangGraph interrupt(), Mastra
  suspend/resume, OpenAI harness approvals).

### Added — Phase 7 (competitor weakness exploit, 2026-06-04)
Web-verified competitor research (LangChain, LangGraph, AutoGen, CrewAI, LlamaIndex, Semantic Kernel, Mastra, Pydantic-AI, OpenAI Agents, mem0, Letta, Zep) surfaced specific weaknesses. We shipped fixes for the ones we can exploit.
- **`@tenet/governance`** — the unfilled OSS gap. 2026 research: *"None evaluates a tool call against a policy before it executes, none requires approval gates by default, none ships a structured audit trail without custom integration."* We ship all three: `PolicyEvaluator` with deny/allow/require_approval, `ApprovalGate` with idempotency cache, `AuditSink` with 6 typed event kinds, built-in rules (`allowListRule`, `tagRequiresApprovalRule`, `denyArgPatternRule`, `numericLimitRule`), stable approval keys (argument-order independent). 17 tests.
- **`@tenet/memory` consistency layer** — fixes the mem0 indexing-reliability + Zep post-ingestion-retrieval bug class. `mintToken` (deterministic idempotency), `WriteAck.readableAtMs`, `waitUntilReadable` with exponential backoff + abort, `resolveConflict` with explicit policies (last_write_wins / first_write_wins / merge). 13 tests.
- **`@tenet/models-anthropic.chatStream()`** — SSE-streamed Anthropic Messages API. Closes our last own gap. Honors `content_block_delta`, `message_delta` usage, `message_stop`. Emits `StreamChunk` shapes from `@tenet/streaming` so the verifier and `measureTtft` see one consistent shape across providers.

### Added — Phase 6 (close 3 OSS gaps, 2026-06-04)
- **`@tenet/streaming`** — non-breaking streaming ChatModel contract + SSE parser + incremental JSON parser (Pydantic-AI's structured-output pattern, generalised).
- **`@tenet/models-openai`** — direct OpenAI Chat Completions adapter, no SDK dep. Implements both `chat()` and `chatStream()`.
- **`@tenet/workflow`** — deterministic DAG primitives: sequential / parallel / branch / retry / withTimeout + per-step trace events.

### Added — Phase 5 (research-led residuals, 2026-06-04)
- `@tenet/distillation` — verified flagship trace capture + LoRA JSONL emitter.
- `@tenet/eval-mining` — assertion miner + cosine dedup + EvalCase emitter.
- `@tenet/rerank-cohere` — Cohere Rerank v2 API adapter, fetch-injected.
- `packages/judge-hhem-onnx/examples/transformers-pipeline.ts` — operator wiring for real HHEM-2.1.
- `.github/workflows/measure-real.yml` — secret-gated real-model harness on cron.
- `docs/RESEARCH-PASS-3.md` — operator-led research scaffold per source-hierarchy rules.

### Added — Phase 4 (BENCHMARKS gated in CI, 2026-06-04)
- `@tenet/eval-metrics` — Wilson-95 + quantile + per-dimension scorers.
- `@tenet/eval-measure` — hermetic measurement runner + CLI; 11/11 dimensions PASS on stub gate.
- `@tenet/judge-hhem` — Vectara HHEM-2.1 contract + reference token-overlap scorer.
- `@tenet/app-measure-real` — real-ChatModel runner + PUBLIC_SLICE (`tenet-public-slice-0.1.0`).
- `@tenet/tools-wasm-sandbox-wasmtime` — production wasmtime WasmRuntime adapter.
- `.github/workflows/ci.yml` benchmarks-gate job — fails any PR on FAIL/MISSING; uploads measured.json artifact.

### Added — Phase 1 MVP packages — all landed:
  - `@tenet/rate-limit` — `TokenBucket` + `CircuitBreaker` + `RateLimitScheduler` with 5 platform policies (Telegram, Discord, Slack, Teams, Zendesk).
  - `@tenet/guardrails` — `PiiRedactor` (7 kinds) + composable `Filter` chain (`lengthFilter`, `denylistFilter`, `runFilterChain`).
  - `@tenet/retrieval` — `Bm25Index` (Okapi BM25 with Lucene-style IDF smoothing) + `InMemoryVectorStore` + `reciprocalRankFusion` (Cormack 2009) + `HybridPipeline` with per-stage metrics.
  - `@tenet/router` — `AdaptiveRouter` (classifier-driven tier picking + flagship fallback) + `InMemorySemanticAnswerCache` (cosine LRU) + `SpeculativeAgent` (cheap + flagship in parallel, verifier-driven promotion).
  - `@tenet/memory` — `WorkingMemory` (ring buffer with token-budget cap) + `InMemoryEpisodicMemory` (per-conversation history) + `InMemorySemanticMemory` (cross-conversation facts with confidence-aware eviction).
  - `@tenet/models-bedrock` — `AnthropicOnBedrockChatModel`; no AWS SDK hard dep (injected invoker).
  - `@tenet/stores-vector-pgvector` — `PgVectorStore`; no pg SDK hard dep (injected query executor); all values parameter-bound; table name validated against `/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`.
  - `@tenet/stores-state-redis` — `StateStore` interface + `InMemoryStateStore` (TTL + LRU eviction) + `RedisStateStore` adapter.
  - `@tenet/surface-telegram` — `TelegramSurface` adapter with HTML escaping, citation rendering, optional rate-limit gate.
  - `@tenet/eval-harness` — `runEval` + 5 builtin assertions + `regressionGate` for eval-as-CI.
  - `@tenet/app-community-bot` — reference composition wiring all of the above.
- **Adversarial-review bug fixes (5):**
  - B1 — `SourcePicker` strategy replaces `buildCitations`' naive head-substring match.
  - B2 — `openPath()` factory shipped; `PathHandle` type is no longer vapor.
  - B3 — `ChatModel.chat` accepts `AbortSignal`; `withTimeoutAndSignal` aborts the controller on timer fire.
  - B4 — `OutcomeEmitter` re-entrancy guard (`MAX_EMIT_DEPTH=4`) + `SwallowedErrorReporter` callback.
  - B5 — `ClaimPreFilter` + `JudgePromptDecorator` interfaces; `urlAllowlistFilter` + `examplesDecorator` factories.
- Scaffolded the four MVP packages: `@tenet/core`, `@tenet/verifier`, `@tenet/policy`, `@tenet/telemetry`.
- `Secret<T>` opaque type that refuses `JSON.stringify`, blocking a secret-leak-via-serialization class of bug.
- `Filter<TKey>` + `validateFilterKey` that reject `--`, `..`, and any non-`[a-zA-Z0-9_.-]` characters in metadata filter keys — blocks a metadata-filter SQL-injection class of bug.
- `PathHandle` branded type for path-allowlisted file I/O (factory ships as `openPath()`, `packages/core/src/path.ts:58`).
- `TenetError` with stable error codes (`VERIFIER_FAILED`, `RETRIEVAL_FAILED`, `MODEL_FAILED`, `RATE_LIMITED`, `TIMEOUT`, `INVALID_INPUT`, `PERMISSION_DENIED`, `INTERNAL`).
- `OutcomeEvent` first-class telemetry primitive (`resolved` / `handed_off` / `disqualified` / `qualified` / `pending`).
- `OutcomeEmitter` with sink isolation — a broken sink can't kill the telemetry pipeline.
- `CostMeter` with per-model pricing; throws by default on unknown model to surface config typos.
- `PrincipleRegistry` for Constitutional-Principles composition + drift `fingerprint()`.
- Atomic-claim multi-judge verifier (strict pass + permissive re-judge of failures only).
- Index-based permissive merge that survives duplicate-claim strings (fix #10).
- 118 unit tests across 8 suites.
- ARCHITECTURE.md, BENCHMARKS.md, ROADMAP.md.
- CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, issue + PR templates.
- GitHub Actions CI: build / typecheck / lint / test / audit / Trivy / eval-regression.
- Apache-2.0 LICENSE, `.gitattributes`, `.editorconfig`, `.nvmrc`.

### Changed
- `isClaimAboutAllowedUrl` switched from case-insensitive substring match to URL-extraction + hostname normalization. Fixes the lookalike-domain bypass (`notexample.com` ⊁ `example.com`).
- `claimExtractor` list-marker strip narrowed from `/^[\s\-•*\d.)]+/` to recognised markers only (`1.`, `1)`, `(1)`, `-`, `*`, `•`). Bare leading digits in claims are preserved.
- `judge.ts` partial-parse fallback split: when SOME lines parsed, missing indices default to UNSUPPORTED (fail-closed). When ZERO lines parsed, missing default to supported (fail-open on judge total breakage). Stops silently shipping fabrications.
- `PrincipleRegistry.replace()` now runs the same `validate()` as `register()` — empty rules and version < 1 are rejected on replace.
- `CostMeter.record()` now throws on unknown model by default; opt-in `'skip'` policy preserves silent-skip for allowlist mode.
- Removed `composite: true` from base tsconfig + project references. Each package builds with plain `tsc` in pnpm-topological order.
- Removed `.github/dependabot.yml` to enforce a single-branch policy. Dep updates land as explicit commits on main.

### Security
- `SECURITY.md` routes vulnerability reports through GitHub Private Vulnerability Reporting; no mailbox.
- Trivy + pnpm audit run in CI (informational pre-1.0; gates tighten at v1.0).
