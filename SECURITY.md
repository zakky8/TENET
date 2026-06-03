# Security Policy

## Reporting a vulnerability

Email: **security@tenet.dev** (TODO: confirm domain / use github.com/zakky8 contact until set up)

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

TENET is designed to avoid entire categories of LangChain-class vulnerabilities. These are policies, not aspirations — CI enforces them.

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

## Hall of fame

Researchers who responsibly disclose will be acknowledged here (with permission).
