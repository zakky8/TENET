/**
 * Adds a per-package `keywords` array to every workspace package.json
 * for npm + Google search discoverability. Idempotent — re-running
 * overwrites the keywords array with the canonical set.
 *
 * Run: node scripts/add-keywords.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const SHARED = [
  'ai',
  'ai-agents',
  'agent-framework',
  'llm',
  'typescript',
  'tenet',
  'langchain-alternative',
];

// Per-package extra keywords. The package.json name (workspace folder)
// maps to a domain-specific keyword list. Anything not listed inherits
// only the shared set.
const PER_PACKAGE = {
  '@tenet/core': ['types', 'foundation'],
  '@tenet/verifier': ['hallucination-detection', 'multi-judge', 'verifier', 'cove', 'reflexion'],
  '@tenet/policy': ['constitutional-ai', 'principles', 'guardrails'],
  '@tenet/telemetry': ['opentelemetry', 'otel', 'gen-ai-semconv', 'outcome-events'],
  '@tenet/telemetry-otlp': ['opentelemetry', 'otlp', 'tracing', 'observability'],
  '@tenet/rate-limit': ['rate-limit', 'token-bucket', 'circuit-breaker'],
  '@tenet/retrieval': ['rag', 'bm25', 'hybrid-retrieval', 'rrf', 'vector-search'],
  '@tenet/router': ['adaptive-routing', 'speculative-execution', 'cost-optimization'],
  '@tenet/memory': ['agent-memory', 'episodic-memory', 'semantic-memory', 'idempotency'],
  '@tenet/memory-adapters': ['mem0', 'letta', 'zep', 'agent-memory'],
  '@tenet/guardrails': ['pii', 'prompt-injection', 'redaction', 'guardrails'],
  '@tenet/governance': ['governance', 'policy', 'approval-gates', 'audit', 'compliance', 'tool-call-policy'],
  '@tenet/workflow': ['workflow', 'dag', 'orchestration', 'state-machine'],
  '@tenet/streaming': ['streaming', 'sse', 'server-sent-events', 'structured-output'],
  '@tenet/distillation': ['fine-tuning', 'distillation', 'lora', 'training-data'],
  '@tenet/judge-hhem': ['hhem', 'vectara', 'hallucination-judge', 'nli'],
  '@tenet/judge-hhem-onnx': ['hhem', 'vectara', 'onnx', 'transformers-js'],
  '@tenet/rerank-cohere': ['cohere', 'rerank', 'reranker', 'cross-encoder'],
  '@tenet/tools-mcp': ['mcp', 'model-context-protocol', 'tool-use', 'json-rpc'],
  '@tenet/tools-mcp-gateway': ['mcp', 'oauth', 'rfc-9207', 'gateway', 'multi-tenant'],
  '@tenet/tools-wasm-sandbox': ['wasm', 'webassembly', 'sandbox', 'capability-tokens', 'security'],
  '@tenet/tools-wasm-sandbox-wasmtime': ['wasm', 'wasmtime', 'sandbox', 'fuel'],
  '@tenet/eval-harness': ['evaluation', 'eval', 'llm-as-judge', 'regression-gate'],
  '@tenet/eval-metrics': ['benchmarks', 'eval', 'metrics', 'wilson-ci', 'quantile'],
  '@tenet/eval-measure': ['benchmarks', 'eval', 'hermetic-ci', 'gate'],
  '@tenet/eval-mining': ['eval', 'assertion-mining', 'auto-grow-dataset'],
  '@tenet/models-anthropic': ['anthropic', 'claude', 'chat-model', 'streaming'],
  '@tenet/models-bedrock': ['aws-bedrock', 'anthropic', 'claude', 'chat-model'],
  '@tenet/models-openai': ['openai', 'gpt', 'chat-model', 'streaming'],
  '@tenet/models-google': ['google', 'gemini', 'chat-model', 'streaming'],
  '@tenet/models-mistral': ['mistral', 'chat-model', 'streaming'],
  '@tenet/models-ollama': ['ollama', 'self-host', 'on-prem', 'chat-model', 'streaming'],
  '@tenet/stores-vector-pgvector': ['pgvector', 'postgres', 'vector-database', 'rag'],
  '@tenet/stores-vector-qdrant': ['qdrant', 'vector-database', 'multi-tenant'],
  '@tenet/stores-state-redis': ['redis', 'state-store', 'session'],
  '@tenet/surface-telegram': ['telegram', 'telegram-bot', 'grammy', 'chatbot'],
  '@tenet/surface-discord': ['discord', 'discord-bot', 'chatbot'],
  '@tenet/surface-slack': ['slack', 'slack-bot', 'bolt', 'chatbot'],
  '@tenet/surface-teams': ['microsoft-teams', 'bot-framework', 'adaptive-cards', 'chatbot'],
  '@tenet/surface-web-widget': ['chat-widget', 'sse', 'jwt', 'web-chat'],
  '@tenet/surface-rest': ['rest', 'openapi', 'http-api', 'chat-completions'],
  '@tenet/surface-grpc': ['grpc', 'protobuf', 'rpc'],
  '@tenet/connectors-ticketing': ['zendesk', 'intercom', 'freshdesk', 'servicenow', 'ticketing', 'helpdesk'],
  '@tenet/app-community-bot': ['community-bot', 'reference-implementation'],
  '@tenet/app-enterprise-support': ['enterprise', 'customer-support', 'helpdesk'],
  '@tenet/app-measure-real': ['benchmarks', 'measurement', 'eval'],
};

let touched = 0;
let unchanged = 0;
for await (const file of glob('**/package.json', { cwd: ROOT, exclude: ['node_modules/**', '**/dist/**', 'package.json'] })) {
  const full = path.join(ROOT, file);
  const raw = await readFile(full, 'utf8');
  const pkg = JSON.parse(raw);
  if (!pkg.name?.startsWith('@tenet/')) continue;
  const specific = PER_PACKAGE[pkg.name] ?? [];
  const next = Array.from(new Set([...SHARED, ...specific])).toSorted();
  const prev = JSON.stringify(pkg.keywords ?? []);
  if (JSON.stringify(next) === prev) { unchanged++; continue; }
  pkg.keywords = next;
  // Preserve trailing newline + 2-space indent (workspace convention).
  await writeFile(full, JSON.stringify(pkg, null, 2) + '\n');
  touched++;
}
console.log(`keywords: ${touched} updated, ${unchanged} unchanged.`);
