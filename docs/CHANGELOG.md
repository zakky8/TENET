# Changelog

All notable changes to TENET are recorded here. Format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0 the API surface and behavior may change without major bumps. We will pin breaking changes by minor version (`0.X.Y`).

## [Unreleased]

### Added
- Scaffolded the four MVP packages: `@tenet/core`, `@tenet/verifier`, `@tenet/policy`, `@tenet/telemetry`.
- `Secret<T>` opaque type that refuses `JSON.stringify`, blocks the LangChain CVE-2025-68664-class secret-leak.
- `Filter<TKey>` + `validateFilterKey` that reject `--`, `..`, and any non-`[a-zA-Z0-9_.-]` characters in metadata filter keys — blocks the CVE-2025-67644-class SQL-injection path.
- `PathHandle` branded type for path-allowlisted file I/O (factory pending).
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
