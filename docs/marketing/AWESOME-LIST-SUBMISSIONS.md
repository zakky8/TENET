# Awesome-list submissions (operator-ready PR text)

Each entry below is a ready-to-paste PR description + the exact line to add to the target list. Backlinks from these lists are what move GitHub repo rank past the page-one search threshold.

---

## 1. awesome-ai-agents (`https://github.com/e2b-dev/awesome-ai-agents`)

**Line to add (under "AI Agent Frameworks" section, keep alphabetical):**

```markdown
- [TENET](https://github.com/zakky8/TENET) — TypeScript verification-first agent framework. Multi-judge hallucination verifier + Vectara HHEM-2.1, pre-tool-call governance + approval gates + audit trail, WASM-sandboxed tools, MCP OAuth gateway, 10 surfaces (Discord/Slack/Telegram/Teams/web/REST/gRPC/ticketing), BENCHMARKS gated in CI on every PR (hermetic stub plane). Apache-2.0.
```

**PR title:** `Add TENET — verification-first TypeScript agent framework`

**PR body:**
```
Adds TENET to the AI Agent Frameworks section.

TENET is a TypeScript agent framework focused on:
- Multi-judge atomic-claim hallucination verifier (only OSS framework with this)
- Vectara HHEM-2.1 hallucination judge adapter
- Pre-tool-call governance + approval gates + structured audit trail (the gap 2026 research surfaced: "None evaluates a tool call against a policy before it executes, none requires approval gates by default, none ships a structured audit trail without custom integration")
- WASM tool sandbox with capability tokens + production wasmtime adapter
- MCP OAuth gateway (RFC 9207, 2026-07-28 spec RC)
- 10 surfaces in one config
- BENCHMARKS measured + gated in CI on every PR (11/11 dimensions PASS against the hermetic stub SUT; real-model numbers are operator-run — see docs/BENCHMARKS.md)
- 1230 tests across 92 suites, all green
- Apache-2.0
```

---

## 2. awesome-typescript (`https://github.com/dzharii/awesome-typescript`)

**Line to add (under "AI / Machine Learning" section):**

```markdown
- [TENET](https://github.com/zakky8/TENET) — Verification-first AI agent framework with multi-judge hallucination verifier, governance + approval gates, WASM tool sandbox, MCP OAuth gateway, 10 channel surfaces, and BENCHMARKS gated in CI. Apache-2.0.
```

---

## 3. awesome-chatops / awesome-chatbots

**Lines:**
```markdown
- [TENET](https://github.com/zakky8/TENET) — TypeScript bot framework that powers Discord / Slack / Telegram / Teams / web widget / REST / gRPC / Zendesk / Intercom / Freshdesk / ServiceNow from one config. Multi-judge hallucination verifier + pre-tool-call governance + WASM-sandboxed tools.
```

---

## 4. awesome-langchain-alternatives (search GitHub for current list)

**Line:**
```markdown
- [TENET](https://github.com/zakky8/TENET) — TypeScript-native alternative. File I/O is only reachable through a validated `openPath()` allow-list root that rejects absolute paths and `..` traversal (packages/core/src/path.ts). Multi-judge verifier + Vectara HHEM-2.1 + governance/approval/audit + WASM sandbox + MCP OAuth gateway. BENCHMARKS gated in CI (hermetic stub plane).
```

---

## 5. awesome-rag

**Line:**
```markdown
- [TENET](https://github.com/zakky8/TENET) — TypeScript RAG + agent framework. Hybrid BM25 + dense retrieval with Reciprocal Rank Fusion (Cormack 2009). Cohere Rerank v2 API adapter. Atomic-claim verifier requires every claim to cite a retrieved source. Anthropic Contextual Retrieval recipe-compatible.
```

---

## 6. awesome-mcp (`https://github.com/punkpeye/awesome-mcp-servers`)

**Line (under "MCP Clients" or "Tooling"):**
```markdown
- [TENET](https://github.com/zakky8/TENET) — TypeScript MCP client + OAuth gateway. RFC 9207 `iss` validation per the 2026-07-28 spec RC. Per-tenant policy with allowedTools wildcard + trustedIssuers + per-tool rate-limit + structured audit sink. WASM-sandboxed tool execution.
```

---

## Posting checklist

1. Star each awesome-list before submitting (signals contributor good-faith)
2. Read the contribution guidelines per list (some require alphabetical ordering, some require a logo, some forbid "alternative" framing)
3. Submit one PR per list — don't batch (mergers want focused PRs)
4. Wait 7 days between PRs to the same maintainer's repos (avoid spam flag)
5. After merge, add the list back-link to the TENET README's "Acknowledgements" section (reciprocal credit aids ongoing rank)
