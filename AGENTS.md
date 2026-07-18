# AGENTS.md

**Operating rules for AI agents (Cursor, Aider, Claude Code, Codex, etc.) working in this repo.**

Telegraph style. Root rules only. Read scoped `AGENTS.md` before subtree work.

---

## Stack

- TypeScript strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, ES2024 target.
- Node 22 LTS minimum. pnpm workspaces.
- Jest with `NODE_OPTIONS=--experimental-vm-modules`.
- No SDK hard deps — every provider client is **injected**.

## Required reading order

1. This file (`AGENTS.md`) — the root operating rules for any agent working in this repo
2. `docs/ARCHITECTURE.md` — component map + altitude principles
3. `docs/BENCHMARKS.md` — measured gate, every PR re-runs
4. Subtree `AGENTS.md` if present in the package you're touching

## Discipline (binding)

1. **Adversarial review pattern.** New packages must pass security + correctness + altitude review (independent parallel reviewers) before merge — the review that catches a fail-open path is the one that matters.
2. **BENCHMARKS gate.** `pnpm benchmarks` must exit 0 before push. PRs that fail the hermetic gate do not merge.
3. **Altitude principle.** Framework types stay generic; app-specific concerns live under `apps/`. Closed unions over app-specific vocabulary are a B5-class bug.
4. **No SDK lock-in.** Every provider adapter is fetch-injected. If you're typing `import { Anthropic } from '@anthropic-ai/sdk'`, stop.
5. **Source-hierarchy rule.** A number not produced by automated CI in this repo is reported with its methodology + `accessed_at_utc` + archive URL. Never paraphrase a search-result snippet as a finding.
6. **`main` is the integration branch.** CI runs on pushes to `main` and pull requests targeting it (`.github/workflows/ci.yml`). Keep each change small and green.
7. **Fail closed.** Any infra failure — verifier/judge/model error, timeout, truncation, an unparseable result, an unknown branch — resolves to abstain or human-handoff. There is no default `answer`; the only path to member-facing text is *past* the verify gate. Shipping unverified text on an error path is a regression even if every test is green.

## Commands

```bash
pnpm install                # installs all workspace deps
pnpm typecheck              # tsc --noEmit per package (topological)
pnpm test                   # full Jest suite (node --experimental-vm-modules)
pnpm test:coverage          # suite + coverage gate — CI's test step (thresholds in jest.config.cjs)
pnpm counts:check           # doc test-count claims must equal the live suite (fails on drift)
pnpm readme:check           # README ts fences must compile against the real API
pnpm jsonld:check           # AEO JSON-LD blocks in docs parse + are well-formed
pnpm inventory:check        # docs' surface/model adapter counts must equal the filesystem
pnpm links:check            # every relative link in a tracked .md must resolve to a file
pnpm examples:check         # doc ts fences must not import a removed export or misuse a typed value
pnpm benchmarks             # hermetic BENCHMARKS gate (exits 1 on FAIL/MISSING)
pnpm benchmarks:json        # JSON report for CI artefacts
pnpm lint                   # per-package lint (currently a no-op stub in every package)

pre-commit install          # one-time — installs git-hook + auto-runs on commit
pre-commit run --all-files  # run hooks across the full tree
```

## PR rules

- **Conventional commit** subject lines (`feat(scope):`, `fix(scope):`, `chore(scope):`, `docs(scope):`).
- **Co-Authored-By footer** if an agent assisted.
- **Tests + types green** before push. No skipping pre-commit hooks (`--no-verify` is forbidden).
- **One concern per PR.** Combined refactor + feature → split.

## Code style

- `import type` for type-only imports; helps tree-shaking.
- `interface` for object shapes; `type` for unions / mapped / conditional types.
- Conditional spread `...(x !== undefined ? { x } : {})` when passing optional args under `exactOptionalPropertyTypes`.
- Prefer `toSorted` / `toReversed` / `with` over mutating methods (ES2023 standard).
- `AbortSignal` plumbing on every async I/O — verifier path depends on it.
- No `as any`. `as unknown as T` is allowed at the boundary where data crosses a runtime parse.

## Test patterns

- One `describe` per public symbol; one `it` per behaviour.
- Mock-client + capture-array for HTTP-adapter tests.
- Deterministic clocks — inject `now: () => number`, never call `Date.now()` in test fixtures.
- Property-based via direct loop is fine; we don't pull in fast-check unless a bug demands it.
- No network in unit tests. Integration tests under `integration/` are secret-gated.

## Security / release

- Never commit `.env` or anything under `secrets/`. Pre-commit's `detect-private-key` + `gitleaks` block it.
- `pnpm audit --prod` runs in CI informationally (pre-1.0: `--audit-level critical`, non-blocking) and as a pre-push hook (`--audit-level=high`).
- BENCHMARKS gate (`benchmarks-gate`) runs on every push + PR and blocks on any FAIL/MISSING.
- Trivy filesystem scan runs in CI (report-only pre-1.0; SARIF → the Security tab). `actionlint` + `zizmor` audit the workflow YAML via pre-commit.
- Version bumps follow SemVer post-1.0; pre-1.0 we pin breaking changes by minor.

## Architecture rules of thumb

- A new surface goes under `surfaces/`. A new model provider under `models/`. A new vector store under `stores/vector/`. A new state store under `stores/state/`. A new app composition under `apps/`.
- Packages with side effects are forbidden. Every package exports interfaces + pure factories + reference adapters; the app wires them.
- Cross-package imports go through `@tenet/*` (workspace specifier), not relative paths.

## What's already shipped (don't re-invent)

| Concept | Where |
|---|---|
| Verification (multi-judge + HHEM-2.1) | `@tenet/verifier`, `@tenet/judge-hhem`, `@tenet/judge-hhem-onnx` |
| Governance (policy + approval + audit) | `@tenet/governance` |
| Tools (MCP + OAuth gateway + WASM sandbox) | `@tenet/tools-mcp`, `@tenet/tools-mcp-gateway`, `@tenet/tools-wasm-sandbox`, `@tenet/tools-wasm-sandbox-wasmtime` |
| Workflow DAG | `@tenet/workflow` |
| Skills (SKILL.md format) | `@tenet/skills` |
| Streaming (SSE + structured) | `@tenet/streaming` |
| Voice | `@tenet/voice`, `@tenet/voice-openai-realtime`, `@tenet/surface-twilio` |
| Surfaces (9 adapters) + ticketing connectors | `surfaces/{discord, slack, telegram, teams, web-widget, rest, grpc, twilio, matrix}` (+ `surfaces/core`, shared infra), `connectors/ticketing` |
| Models (6) | `models/{anthropic, bedrock, openai, google, mistral, ollama}` |
| Eval + BENCHMARKS | `eval/{harness, metrics, measure, mining}`, `apps/measure-real` |
| Telemetry + OTLP | `@tenet/telemetry`, `@tenet/telemetry-otlp` |

## What we refuse to ship

- Multi-language runtime (Java/Go/Rust runtime). gRPC clients in those languages are fine; the framework stays TS.
- Hosted LLM. We wrap providers.
- Low-code UI. SDK + YAML config; UIs come after v1.0.
- Vendor-locked deploy configs (fly.toml / render.yaml). Helm chart only.
- App-specific concepts in `packages/`. Move to `apps/`.

---

When in doubt: read the test for the symbol you're touching. The test is the contract.
