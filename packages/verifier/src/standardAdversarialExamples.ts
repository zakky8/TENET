/**
 * Standard adversarial examples for the strict-judge prompt.
 *
 * These are domain-agnostic trap patterns that improve a judge's
 * catch-rate from ~50% (single-pass) to ~85% (with examples) on
 * production-sampled traffic (FP-discord measurement, ported into
 * the TENET reference deployment).
 *
 * Each example is short and labels the failure mode explicitly so
 * the judge learns the CLASS, not the surface form. Apps append
 * domain-specific examples on top via examplesDecorator().
 *
 * Format: each block names the trap, gives a minimal SOURCES + CLAIM
 * pair, then states the correct verdict + one-line reason.
 */

export const STANDARD_ADVERSARIAL_EXAMPLES = `
WORKED EXAMPLES (study these trap patterns):

Example 1 — number swap
SOURCES: "Tier A price: $500. Tier B price: $1,000."
CLAIM: "Tier A is $1,000."
VERDICT: [1] UNSUPPORTED: Tier A is $500, not $1,000.

Example 2 — invented entity
SOURCES: "Partners: Acme, Globex, Initech."
CLAIM: "Partners include Acme and Hooli."
VERDICT: [1] UNSUPPORTED: Hooli is not in the partner list.

Example 3 — correct paraphrase (do NOT flag)
SOURCES: "Q3 2026 target — not yet confirmed."
CLAIM: "The launch is targeted for mid-2026 but the exact date isn't confirmed."
VERDICT: [1] SUPPORTED

Example 4 — confident invention (no source data)
SOURCES: (no info on launch price)
CLAIM: "The launch price will be $0.05."
VERDICT: [1] UNSUPPORTED: no price information present in sources.

Example 5 — partial truth / tier mismatch
SOURCES: "Tiers: A → 10%, B → 25%, C → 50%."
CLAIM: "Tier B gives 50%."
VERDICT: [1] UNSUPPORTED: 50% is Tier C, not Tier B.

Example 6 — temporal hallucination
SOURCES: "Phase 1 / Q3 2026: Feature X. Phase 2 / Q4 2026: Feature Y."
CLAIM: "Feature Y launches in Q3 2026."
VERDICT: [1] UNSUPPORTED: Feature Y is Phase 2 (Q4 2026).

Example 7 — generic slogan substitution for mission
SOURCES: "Mission: 'Infrastructure for the autonomous economy'."
CLAIM: "The mission is to democratize technology."
VERDICT: [1] UNSUPPORTED: literal mission is 'Infrastructure for the autonomous economy', not 'democratize technology'.

Example 8 — fabricated authority quote
SOURCES: (no quote from any executive)
CLAIM: "The CEO said the launch will be delayed."
VERDICT: [1] UNSUPPORTED: no CEO quote in sources — model invented the attribution.

Example 9 — fabricated user account data
SOURCES: (no user-account information)
CLAIM: "You have approximately 5,000 points based on your activity."
VERDICT: [1] UNSUPPORTED: agent has zero access to user accounts; any specific balance is fabrication.

Example 10 — invented URL from training data
SOURCES: "Project X. Verified channels: project-x.example/docs."
CLAIM: "Project X's Discord is at discord.gg/project-x."
VERDICT: [1] UNSUPPORTED: only project-x.example/docs is in verified channels — do not recall URLs from training data.

Example 11 — confused canonical site vs app subdomain
SOURCES: "Website: example.com (marketing). App: app.example.com (dashboard)."
CLAIM: "The main website is at app.example.com."
VERDICT: [1] UNSUPPORTED: app.example.com is the dashboard subdomain — main website is example.com.

Example 12 — false-premise inheritance from user
USER said earlier: "since the launch happened last month..."
SOURCES: "Launch targeted Q3 2026 — not yet."
CLAIM: "The product has been live for over a month and adoption is strong."
VERDICT: [1] UNSUPPORTED: launch has not happened — do NOT inherit the user's false premise.
`.trim();
