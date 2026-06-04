<!-- PR title: follow Conventional Commits — feat: / fix: / docs: / chore: / refactor: / test: / ci: -->

## Summary

<!-- One paragraph. What changed, why. Reference the issue # if applicable. -->

## How I verified

<!-- Be specific. -->
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` — N tests passing (no regression)
- [ ] Added regression test(s) covering the change (link line numbers)
- [ ] Ran the change end-to-end against a real model / surface — describe what

## Scope

- Packages touched:
- New dependencies (prod):
- New dependencies (dev):
- Public-API change? yes / no — if yes, link the docs update

## Risk + rollback

- Failure mode if this PR is wrong:
- Rollback plan:

## Alignment with project values

- [ ] Verification by default is preserved (no opt-in regression).
- [ ] Source-grounded output rule is preserved (no model-recall URLs introduced).
- [ ] No CVE-class risk introduced (no `pickle`-style deserialization, no Jinja2 default, no raw-path file I/O, no unparameterized queries).
- [ ] Not specific to one application (or, if it is, it lives under `apps/` not `packages/`).

## Reviewer checklist (the reviewer fills this)

- [ ] CI is green.
- [ ] Test coverage didn't drop materially.
- [ ] No drift between docs and code for changed surfaces.
- [ ] If a fix, a regression test pins the bug.
