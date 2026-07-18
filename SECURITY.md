# Security Policy

## Reporting a vulnerability

**Use GitHub Private Vulnerability Reporting**: https://github.com/zakky8/TENET/security/advisories/new

We don't currently operate a security mailing list. The GitHub private advisory channel is end-to-end private between you and the maintainers, gives us a private fix branch to work on, and assigns a CVE through GitHub when we publish.

Please include:
- Affected version(s) / commit SHA
- Reproduction steps or proof-of-concept
- Impact assessment (confidentiality / integrity / availability)
- Whether you have publicly disclosed any details

**Do not open a public GitHub issue for security vulnerabilities.**

## Disclosure timeline

| Day | Event |
|-----|-------|
| 0   | Report received, acknowledgement within 48h |
| ≤30 | Fix developed and tested |
| ≤60 | Coordinated release with patched version |
| 90  | Public disclosure (CVE assigned via GitHub) |

We honor longer embargoes if the issue is in a downstream dependency we cannot patch.

## Hardened-by-construction guarantees

TENET is designed to avoid entire categories of known agent-framework vulnerability classes. These are policies, not aspirations — CI enforces them.

| Risk | Policy | Enforcement |
|------|--------|-------------|
| Unsafe deserialization | No `pickle`-equivalent, no free-form `JSON.parse` of persisted state | All persisted state is Zod-schema-typed |
| Template injection | No Jinja2 or equivalent string-templated prompts | Tagged-template literals only; custom ESLint rule rejects string-built prompts |
| Path traversal | No raw filesystem paths in public APIs | `PathHandle` type opened against allow-list root |
| SQL injection | All store queries parameterized; metadata filter keys validated `/^[a-zA-Z0-9_.-]+$/` | Store-adapter type signatures take `Filter<T>`, not strings |
| Secret leakage | Secrets are an opaque `Secret<T>` type, never serialized | Custom `toJSON()` rejects |
| Supply chain | SBOM (CycloneDX) per release; Trivy + Dependabot + Snyk gates | GitHub Actions CI |

## Scope

- TENET core (`packages/*`), surfaces, connectors, models, stores: in scope.
- TENET reference deployments (`apps/community-bot`, `apps/enterprise-support`): in scope.
- User-provided custom packages / forks: out of scope.

## Threat model (v0.0.0)

What we explicitly defend against:

1. **Prompt injection from end users.** Surfaces (`@tenet/surface-telegram`, future Discord/Slack/Teams/web/REST) treat all inbound text as untrusted. Surface adapters MUST escape user content before interpolating into HTML / Markdown / system prompts. Verifier's `ClaimPreFilter` strategies can be wired to reject user-supplied claims that smuggle adversarial directives.
2. **Hallucinated URLs / facts.** `@tenet/verifier`'s URL-allowlist filter blocks any claim about a URL not in the operator's compiled allow-list. The default `SourcePicker` will not attach a citation unless the claim is substantively backed by a retrieved source.
3. **SQL injection in store adapters.** `@tenet/stores-vector-pgvector` uses parameter binding for every value. Filter keys validated via `@tenet/core`'s `validateFilterKey` (rejects `--`, `..`, anything outside `[a-zA-Z0-9_.-]`). Table name validated against `/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/`.
4. **Path traversal in file I/O.** `@tenet/core`'s `openPath()` factory is the only sanctioned path constructor. Rejects abs paths, `..` segments, and any path that resolves outside the per-process `configurePathRoot()`. The eval-harness dataset loader applies the same guard at glob entry.
5. **Secret leakage via serialization.** `@tenet/core`'s `Secret<T>` throws on `JSON.stringify`. Util.inspect / Pino-style structured logs are out of scope for this guarantee — apps must mark fields explicitly.
6. **Telemetry stack exhaustion.** `@tenet/telemetry`'s `OutcomeEmitter` has a `MAX_EMIT_DEPTH=4` re-entrancy cap. Sink errors don't disappear silently — they're forwarded to the `SwallowedErrorReporter` callback.
7. **Provider-side budget exhaustion.** `withTimeoutAndSignal` aborts the underlying HTTP request when the timer fires; no zombie inflight calls after timeout. Rate-limit scheduler's circuit breaker opens on 401/403 streaks (default 100) to avoid Discord-style IP bans.
8. **Supply-chain compromise.** SBOM (CycloneDX) per release. Trivy + pnpm audit + GitHub Dependabot Alerts run in CI. We do NOT bundle major SDKs (AWS, pg, grammY) as hard deps — apps inject their own.

What we explicitly do NOT defend against:

- **Operator misconfiguration.** If you set `confidenceFloor: 0` in `AdaptiveRouter`, every request hits the cheap tier. If you wire `urlAllowlistFilter(['*'])`, every claim auto-passes. The framework can't stop you.
- **Model-side prompt-injection bypass.** A model may comply with adversarial instructions inside retrieved sources. We mitigate via verifier + source-grounding but cannot guarantee a flawless responder.
- **Side-channel timing attacks** on rate-limit scheduler or store adapters.
- **Denial of service** at scales above what a single Node process can handle. We rate-limit outbound, not inbound; surfaces are responsible for their own inbound throttling.

## Hall of fame

Researchers who responsibly disclose will be acknowledged here (with permission).
