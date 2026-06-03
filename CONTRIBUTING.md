# Contributing to TENET

Thanks for your interest. TENET is open source under Apache-2.0 and we welcome contributions — code, docs, eval cases, security disclosures.

## Before you start

- **Architecture:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **Targets we hold ourselves to:** [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
- **Security:** [SECURITY.md](SECURITY.md) (do NOT open public issues for vulnerabilities)

## Project values

1. **Verification by default.** Every output passes the verifier — not opt-in.
2. **Source-grounded only.** URLs in output are bounded by a compiled allow-list. No model-recall URLs.
3. **CVE-class mistakes prevented by construction.** No `pickle`, no Jinja2, parameterized queries, path allow-lists.
4. **Measured, not marketed.** Every claim ties to a metric the operator can read out of OpenTelemetry.

If a contribution conflicts with these values, expect pushback — even if the code is correct.

## Development setup

```bash
git clone https://github.com/zakky8/TENET.git
cd TENET
pnpm install
pnpm test       # 118 tests, ~4s
pnpm typecheck
```

Node 22+ required. Use `nvm use` if you have nvm.

## Branching + commits

- Branch off `main`. Branch names: `feat/<scope>`, `fix/<scope>`, `docs/<scope>`, `chore/<scope>`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/). One logical change per commit. Tight subject (under 70 chars), explanatory body.
- Sign commits if you have signing set up (we'll add a CI gate later).

## Pull requests

- Fork → branch → push → PR against `main`.
- PR title: same Conventional-Commits style.
- PR body: what changed, why, how you verified, any open questions.
- CI must be green: typecheck, lint, test, audit, Trivy scan.
- Eval suite must not regress (`pnpm eval` once it lands).

## Adding a test case

We grow the eval suite from real production failures. If you spot a hallucination, miscategorization, or output bug:

1. Distill it into a minimal reproducer.
2. Add the case to the appropriate `*.test.ts` file or `eval/datasets/`.
3. Cite the source (issue link, conversation transcript with PII redacted, or "saw this on YYYY-MM-DD").
4. The test should fail at first if it's a real bug. Then fix it.

## Code style

- TypeScript strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.
- Functional where it fits, classes where state is real.
- No `any`. Use `unknown` and narrow.
- Comments only where the WHY is non-obvious. The code says WHAT.
- Prefer editing existing files to creating new ones.

## Security disclosure

See [SECURITY.md](SECURITY.md). 90-day disclosure, hall of fame, no public issues for vulns.

## License

By contributing, you agree your work will be licensed under Apache-2.0.
