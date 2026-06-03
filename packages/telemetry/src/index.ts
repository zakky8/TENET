/**
 * TENET telemetry.
 *
 * OpenTelemetry GenAI semconv spans + TENET-specific outcome events:
 *   - agent.outcome ∈ {resolved, handed_off, disqualified, qualified, pending}
 *   - agent.verifier.passed, agent.verifier.failures[]
 *   - agent.retrieval.recall_at_k.{bm25,dense,fused,reranked}
 *   - agent.surface, agent.tenant_id, agent.intent, agent.cost_usd
 *
 * Default exporter: OTLP gRPC. No vendor lock-in.
 *
 * See docs/ARCHITECTURE.md §11.
 */

export type Outcome = 'resolved' | 'handed_off' | 'disqualified' | 'qualified' | 'pending';

export const VERSION = '0.0.0';
