/**
 * OTLP/HTTP exporter wiring — converts TENET OutcomeEvent + GenAI
 * semconv spans into OTLP-shape JSON the operator's collector
 * accepts (OpenTelemetry Collector, Langfuse, Phoenix, Tempo, etc.).
 *
 * No @opentelemetry/api / @opentelemetry/sdk-trace-base hard dep —
 * the spec wire format is plain JSON; we ship the converter + a
 * tiny batched POST exporter. Operators wanting the full OTel SDK
 * bridge can implement OtlpExporter against any collector.
 *
 * Spec refs:
 *   OTLP HTTP Protobuf or JSON: opentelemetry.io/docs/specs/otlp
 *   GenAI Semantic Conventions: opentelemetry.io/docs/specs/semconv/gen-ai
 */

import type { OutcomeEvent } from '@tenet/core';

// ── Span types (OTLP-JSON shape) ──────────────────────────────────────

export type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }   // OTLP-JSON: int64 as string
  | { doubleValue: number }
  | { boolValue: boolean };

export interface OtlpAttribute { key: string; value: OtlpAttributeValue }

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status?: { code: 0 | 1 | 2; message?: string }; // UNSET / OK / ERROR
}

export interface OtlpResourceSpans {
  resource: { attributes: OtlpAttribute[] };
  scopeSpans: ReadonlyArray<{
    scope: { name: string; version?: string };
    spans: ReadonlyArray<OtlpSpan>;
  }>;
}

export interface OtlpExportRequest {
  resourceSpans: ReadonlyArray<OtlpResourceSpans>;
}

// ── Conversion helpers ────────────────────────────────────────────────

function attr(key: string, value: unknown): OtlpAttribute | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: JSON.stringify(value) } };
}

function attrs(record: Readonly<Record<string, unknown>>): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [k, v] of Object.entries(record)) {
    const a = attr(k, v);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Convert an OutcomeEvent into an OTLP span. The kind becomes the
 * span name with prefix 'tenet.outcome.'. tenantId / conversationId /
 * outcome become semconv-friendly attributes (`tenet.tenant.id`, etc).
 */
export function outcomeEventToSpan(event: OutcomeEvent, traceId: string, spanId: string): OtlpSpan {
  const ev = event as unknown as Record<string, unknown>;
  const start = typeof ev['tMs'] === 'number' ? ev['tMs'] : 0;
  const kind = typeof ev['kind'] === 'string' ? ev['kind'] : 'unknown';
  const nano = (ms: number): string => String(BigInt(ms) * 1000000n);
  const a: Record<string, unknown> = { 'tenet.event.kind': kind };
  for (const [k, v] of Object.entries(ev)) {
    if (k === 'kind' || k === 'tMs') continue;
    a[`tenet.${k}`] = typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return {
    traceId,
    spanId,
    name: `tenet.outcome.${kind}`,
    startTimeUnixNano: nano(start),
    endTimeUnixNano: nano(start),
    attributes: attrs(a),
  };
}

// ── HTTP exporter ─────────────────────────────────────────────────────

export interface OtlpHttp {
  fetch(input: string, init: {
    method: 'POST';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string> }>;
}

export interface OtlpExporterOptions {
  /** Collector URL. Default 'http://localhost:4318/v1/traces'. */
  endpoint?: string;
  /** Service.name attribute on the Resource. */
  serviceName: string;
  /** Extra resource attributes. */
  resourceAttrs?: Readonly<Record<string, unknown>>;
  /** Header key/values for auth. */
  headers?: Readonly<Record<string, string>>;
  /** Scope name. Default '@tenet/telemetry-otlp'. */
  scopeName?: string;
}

export class OtlpExportError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`OTLP export ${status}: ${body.slice(0, 200)}`);
    this.name = 'OtlpExportError';
  }
}

export class OtlpHttpExporter {
  private readonly endpoint: string;
  private readonly resource: OtlpResourceSpans['resource'];
  private readonly headers: Readonly<Record<string, string>>;
  private readonly scopeName: string;

  constructor(private readonly http: OtlpHttp, opts: OtlpExporterOptions) {
    if (!opts.serviceName) throw new Error('OtlpHttpExporter: serviceName required');
    this.endpoint = opts.endpoint ?? 'http://localhost:4318/v1/traces';
    this.resource = {
      attributes: attrs({ 'service.name': opts.serviceName, ...(opts.resourceAttrs ?? {}) }),
    };
    this.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    this.scopeName = opts.scopeName ?? '@tenet/telemetry-otlp';
  }

  /** Export a batch of spans. Throws OtlpExportError on non-2xx. */
  async export(spans: ReadonlyArray<OtlpSpan>, signal?: AbortSignal): Promise<void> {
    if (spans.length === 0) return;
    const body: OtlpExportRequest = {
      resourceSpans: [{
        resource: this.resource,
        scopeSpans: [{ scope: { name: this.scopeName }, spans }],
      }],
    };
    const res = await this.http.fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new OtlpExportError(res.status, await res.text());
    }
  }
}

// ── Trace/span id helpers ─────────────────────────────────────────────

/** 32 hex chars (16 random bytes) — matches OTLP traceId requirement. */
export function makeTraceId(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error(`traceId needs 16 bytes, got ${bytes.length}`);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 16 hex chars (8 random bytes) — matches OTLP spanId requirement. */
export function makeSpanId(bytes: Uint8Array): string {
  if (bytes.length !== 8) throw new Error(`spanId needs 8 bytes, got ${bytes.length}`);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const VERSION = '0.0.0';
