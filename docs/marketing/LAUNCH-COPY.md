# Launch copy — HN, Reddit, X, LinkedIn (operator-ready)

Pick the channel, copy the block, post. Hit reply to your own post within 5 minutes with the "first comment" block — that's the spot where HN/Reddit algorithms decide the post's velocity.

Submission timing (US-East observed):
- **Hacker News**: Tuesday 8-10am EST (weekday early-Western-coast wake), avoid Mondays + Fridays
- **r/MachineLearning**: Tuesday-Thursday 9am-12pm EST
- **r/LocalLLaMA**: Wednesday-Saturday — they're more 24/7
- **r/programming**: Tuesday-Thursday morning

---

## 1. Hacker News — Show HN

**Title** (under 80 chars):

```
Show HN: TENET – TypeScript agent framework with BENCHMARKS gated in CI
```

**URL**: `https://github.com/zakky8/TENET`

**Text** (leave blank — Show HN posts auto-link; first comment carries the explainer)

**First comment** (post within 5 minutes):

```
Author here. After watching LangChain ship three high-sev CVEs in six months
(CVE-2026-34070 path traversal, CVE-2025-68664 deserialization leaking
env-secrets, CVE-2025-67644 SQLi in LangGraph) I wanted a framework where
the safety side was the default, not opt-in. Three things I'd point at:

1. BENCHMARKS gated in CI. `pnpm benchmarks` runs 11 measured dimensions
   (hallucination, cost, TTFT p95, e2e p95, tool-call success, prompt-
   injection block rate, PII block rate, retrieval recall @ K=10, router
   accuracy, determinism, groundedness). Every PR re-runs. Failing rows
   block merge. The stub-vs-real-SUT split is honest — stub measures the
   framework plane, real-model harness measures TENET + your model on a
   public-shape dataset (operator brings keys + dataset).

2. Pre-tool-call governance + approval gates + audit. 2026 research over
   LangChain / LlamaIndex / Semantic Kernel / AutoGen / CrewAI confirmed:
   "none evaluates a tool call against a policy before it executes, none
   requires approval gates by default, none ships a structured audit
   trail without custom integration." TENET ships all three with a
   redacting AuditSink default so secrets in tool args don't leak to
   S3/SIEM sinks.

3. The verification stack. Atomic-claim multi-judge verifier + a Vectara
   HHEM-2.1 adapter so the headline hallucination row isn't self-judging
   LLM-as-judge. WASM tool sandbox with capability tokens (wasmtime
   adapter for production). MCP OAuth gateway with RFC 9207 iss
   validation per the 2026-07-28 spec RC.

10 surfaces (Discord/Slack/Telegram/Teams/web/REST/gRPC/Zendesk/Intercom/
Freshdesk/ServiceNow), 6 model adapters (Anthropic, Bedrock, OpenAI,
Google, Mistral, Ollama). 766 tests across 67 suites. 0 high-severity
CVEs. Apache-2.0.

Things I cut from the headline that someone will ask about:
- It's a framework, not a model. It calls Claude/GPT/Gemini, it doesn't
  beat them. The claim is "makes whichever model you call more grounded,
  cheaper per resolution, harder to jailbreak". That claim is measurable.
- Voice surface: not shipped. Decagon/Sierra have it; no OSS competitor
  does either. Out of scope until someone asks for it.
- Self-distillation: trace capture + JSONL emit ship. The fine-tune side
  is compute infra (Modal/RunPod), not framework.

Happy to answer questions about the BENCHMARKS gate design or the
adversarial-review pattern that's caught 20 real bugs across two passes.
```

---

## 2. r/MachineLearning

**Title**:

```
[Project] TENET — open-source TypeScript agent framework with BENCHMARKS gated in CI on every PR
```

**Flair**: Project

**Body**:

```
GitHub: https://github.com/zakky/TENET

TL;DR — I shipped a TypeScript agent framework where every BENCHMARKS row
(hallucination rate, cost/resolution, TTFT p95, e2e p95, tool-call
success, prompt-injection block rate, retrieval recall, router accuracy,
determinism, groundedness, PII block) is measured + CI-gated on every PR.
The hermetic gate runs `pnpm benchmarks` against a deterministic stub
SUT + bundled fixtures (80 cases modeling TruthfulQA / JailbreakBench /
BeIR shapes); a separate real-model harness (`@tenet/app-measure-real`)
runs locally with operator keys against a checked-in public-shape slice
or any swap-in dataset.

What's measurably different from LangChain / Mastra / OpenAI Agents:
- Multi-judge atomic-claim verifier (only OSS framework that ships one)
- Vectara HHEM-2.1 hallucination judge adapter (no other OSS framework
  ships independent hallucination judging)
- Pre-tool-call governance + approval gates + structured audit trail
  (confirmed gap nobody else fills, per 2026 framework comparison)
- WASM tool sandbox with capability tokens + production wasmtime adapter
- MCP OAuth gateway with RFC 9207 iss validation
- 10 surfaces in one config (Discord/Slack/Telegram/Teams/web/REST/gRPC
  + Zendesk/Intercom/Freshdesk/ServiceNow ticketing)
- 0 high-severity CVEs (LangChain has 3 from the Mar-2026 disclosure)

Stack: TypeScript strict + exactOptionalPropertyTypes + ES2024 target,
Node 22 LTS, pnpm workspaces, Jest, no SDK lock-in (every provider
fetch-injected). 766 tests across 67 suites. Apache-2.0.

The repo also ships @tenet/distillation (verified flagship trace capture
→ LoRA JSONL emit), @tenet/eval-mining (assertion miner + cosine dedup
for auto-growing eval sets), @tenet/workflow (sequential/parallel/branch/
retry/timeout DAG primitives), @tenet/streaming (SSE parser + incremental
JSON parser for Pydantic-AI-style structured streaming).

Happy to answer questions on:
- The BENCHMARKS gate design (Wilson-95 CI on rates, linear-interp p95,
  regression-vs-baseline detection)
- The atomic-claim verifier internals (CoVe + Reflexion + multi-judge
  consensus + URL allow-list constrained generation)
- The adversarial-review pattern (3 parallel agents — security /
  correctness / altitude — caught 14 real bugs in Phase 4-7 packages
  this past week)
```

---

## 3. r/LocalLLaMA

**Title**:

```
TENET — TypeScript agent framework with Ollama-first on-prem story (and Anthropic/OpenAI/Gemini/Mistral/Bedrock when you want them)
```

**Body**:

```
For folks running self-host: `@tenet/models-ollama` ships chat + streaming
(NDJSON, not SSE) against any Ollama deployment. Drop-in `ChatModel`
contract — same shape as the Anthropic/OpenAI/Bedrock adapters, so the
verifier and the BENCHMARKS gate don't care which model is behind it.

Why this might matter for LocalLLaMA:
- 0 high-severity CVEs (vs LangChain's 3 in six months)
- WASM-sandboxed tool execution with capability tokens (operator declares
  networkAllowList / readPaths / envKeys per tool; runtime fails closed)
- Pre-tool-call governance + approval gates + structured audit (the OSS
  gap nobody else fills)
- Apache-2.0, Helm chart with security defaults (runAsNonRoot UID 10001,
  readOnlyRootFilesystem, NetworkPolicy)

The hermetic BENCHMARKS gate runs every PR. 11/11 dimensions PASS on the
stub SUT. Real-model harness for `tenet + <your model> on <your dataset>`
runs locally — operator brings the keys + the dataset.

https://github.com/zakky8/TENET
```

---

## 4. X / Twitter thread (5 tweets)

**Tweet 1**:
```
Shipping TENET — open-source TypeScript agent framework.

The one differentiator: every BENCHMARKS row (hallucination, cost, TTFT,
groundedness, prompt-injection, …) is measured + CI-gated on every PR.
11/11 dimensions PASS on the hermetic stub. Apache-2.0.

🧵
```

**Tweet 2**:
```
2/ Why this matters: LangChain shipped 3 high-sev CVEs in 6mo
(CVE-2026-34070 path traversal, CVE-2025-68664 secret leak,
CVE-2025-67644 SQLi). TENET is hardened-by-construction: 0 CVEs,
WASM-sandboxed tools, capability tokens, MCP OAuth gateway with iss
validation per RFC 9207.
```

**Tweet 3**:
```
3/ The OSS gap nobody else fills (verified by 2026 framework comparison):
none of LangChain/LlamaIndex/Semantic Kernel/AutoGen/CrewAI ships
pre-tool-call policy + approval gates + structured audit. TENET ships
all three. Default ArgsRedactor so secrets in tool args don't leak.
```

**Tweet 4**:
```
4/ Multi-judge atomic-claim hallucination verifier + Vectara HHEM-2.1
adapter — no self-judging LLM-as-judge bias on the headline row.

10 surfaces from one config: Discord, Slack, Telegram, Teams, web
widget, REST, gRPC, Zendesk, Intercom, Freshdesk, ServiceNow.
```

**Tweet 5**:
```
5/ 6 model adapters (Anthropic-direct, Bedrock, OpenAI, Google, Mistral,
Ollama). All fetch-injected, no SDK lock-in. Streaming on every one.
766 tests, 67 suites, all green. CI runs the BENCHMARKS gate every PR.

github.com/zakky8/TENET
```

---

## 5. LinkedIn (longer-form, neutral tone)

```
TENET — an open-source TypeScript AI agent framework with a property
I haven't seen elsewhere in the OSS space:

Every BENCHMARKS dimension is measured and CI-gated on every pull request.

The hermetic gate runs 11 scorers (hallucination rate, cost per
resolution, TTFT p95, end-to-end latency p95, tool-call success rate,
prompt-injection block rate, PII redaction rate, retrieval recall at
K=10, router decision accuracy, determinism, groundedness) against
bundled fixtures and a deterministic stub system-under-test. A separate
real-model harness runs locally with the operator's API keys against a
checked-in public-shape dataset slice — operator-owned dataset
acquisition and license compliance, per source-hierarchy discipline.

Beyond the gate, the differentiators that emerged from a competitive
sweep over LangChain, LlamaIndex, Semantic Kernel, AutoGen, CrewAI,
Mastra, Pydantic-AI, OpenAI Agents SDK, mem0, Letta, Zep, and the
closed enterprise players (Intercom Fin, Decagon, Sierra):

→ The unfilled OSS gap nobody else ships: pre-tool-call governance
+ approval gates + structured audit trail (with secret-redacting
default sink).

→ A multi-judge atomic-claim hallucination verifier, with a Vectara
HHEM-2.1 adapter so the headline hallucination row isn't self-judging
LLM-as-judge.

→ WASM-sandboxed tool execution with capability tokens, plus a
production wasmtime runtime adapter.

→ A Model Context Protocol OAuth gateway with RFC 9207 issuer
validation per the 2026-07-28 spec RC.

→ Ten channel surfaces (Discord, Slack, Telegram, Microsoft Teams,
web widget, REST, gRPC, plus four ticketing connectors: Zendesk,
Intercom, Freshdesk, ServiceNow) from one configuration.

→ Six model adapters, all injectable — Anthropic direct, AWS Bedrock,
OpenAI, Google Gemini, Mistral, Ollama. Streaming everywhere.

→ Zero high-severity CVEs across the 2025-2026 disclosure window
(LangChain shipped three in the same period).

Apache-2.0. 766 tests across 67 suites. CI green.

Repository: github.com/zakky8/TENET
```

---

## After-launch checklist

- [ ] Reply to every HN comment within first 4 hours (algorithm window)
- [ ] Star + watch your own repo (counts toward "active" signal)
- [ ] Add the launch link to a `RELEASES` section in the README
- [ ] Open a "What surface would you like next?" GitHub Discussion
- [ ] Submit to the awesome-lists per `docs/marketing/AWESOME-LIST-SUBMISSIONS.md`
- [ ] Wait one week, then re-check the repo's GitHub search rank for "agent framework typescript" and "langchain alternative"
