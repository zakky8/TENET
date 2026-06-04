/**
 * MCP tool gateway — per-tenant tool allow-list + OAuth iss validation
 * + audit logging.
 *
 * Sits in front of @tenet/tools-mcp's MCPToolRegistry. The agent's
 * tool-use loop calls gateway.invoke({tenantId, toolName, args, oauth})
 * instead of directly invoking ToolDefinition.invoke().
 *
 * OAuth iss validation per the 2026-07-28 spec RC (SEP-2468):
 *   Clients must validate the iss parameter on authorization responses
 *   per RFC 9207. Mix-up attacks in MCP's single-client, many-server
 *   pattern are mitigated by requiring iss to be in the per-server
 *   trusted issuer list.
 *
 * Audit log: every call records (timestamp, tenantId, toolName,
 * outcome, durationMs) via an injectable AuditSink — apps wire to
 * their preferred sink (Datadog audit log, S3, etc.).
 */

import type { ToolDefinition } from '@tenet/tools-mcp';

export interface OauthAssertion {
  /** Issuer URL (RFC 9207). */
  iss: string;
  /** Subject. */
  sub?: string;
  /** Bearer token; opaque to gateway. */
  token: string;
}

export interface AuditRecord {
  timestampMs: number;
  tenantId: string;
  toolName: string;
  outcome: 'allow' | 'deny' | 'error';
  reason?: string;
  durationMs: number;
}

export interface AuditSink {
  record(r: AuditRecord): void;
}

export interface PerTenantPolicy {
  /** Tools the tenant is allowed to call. '*' means all registered tools. */
  allowedTools: ReadonlyArray<string>;
  /** OAuth issuers the tenant trusts (matched against assertion.iss). */
  trustedIssuers: ReadonlyArray<string>;
  /** Optional per-tool rate cap (calls per minute). 0 disables. */
  perToolRateLimit?: Record<string, number>;
}

export interface MCPGatewayOptions {
  /** Registered tool definitions (from @tenet/tools-mcp's MCPToolRegistry.toolDefinitions()). */
  tools: ReadonlyArray<ToolDefinition>;
  /** Per-tenant policy map. */
  policies: Readonly<Record<string, PerTenantPolicy>>;
  /** Audit sink. Optional but recommended. */
  audit?: AuditSink;
  /** Clock injection. Default Date.now. */
  now?: () => number;
}

export class MCPGatewayError extends Error {
  constructor(
    public readonly code: 'unknown_tool' | 'tenant_unregistered' | 'tool_not_allowed' | 'untrusted_issuer' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'MCPGatewayError';
  }
}

export class MCPGateway {
  private readonly toolMap: ReadonlyMap<string, ToolDefinition>;
  private readonly callBuckets = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly opts: MCPGatewayOptions) {
    this.toolMap = new Map(opts.tools.map((t) => [t.name, t]));
    this.now = opts.now ?? (() => Date.now());
  }

  async invoke(args: {
    tenantId: string;
    toolName: string;
    args: Record<string, unknown>;
    oauth: OauthAssertion;
    signal?: AbortSignal;
  }): Promise<string> {
    const start = this.now();
    try {
      this.check(args);
      const tool = this.toolMap.get(args.toolName)!;
      const result = await tool.invoke(args.args, args.signal);
      this.audit({
        timestampMs: start,
        tenantId: args.tenantId,
        toolName: args.toolName,
        outcome: 'allow',
        durationMs: this.now() - start,
      });
      return result;
    } catch (e) {
      const isGatewayErr = e instanceof MCPGatewayError;
      this.audit({
        timestampMs: start,
        tenantId: args.tenantId,
        toolName: args.toolName,
        outcome: isGatewayErr ? 'deny' : 'error',
        reason: (e as Error).message,
        durationMs: this.now() - start,
      });
      throw e;
    }
  }

  private check(args: {
    tenantId: string;
    toolName: string;
    oauth: OauthAssertion;
  }): void {
    const policy = this.opts.policies[args.tenantId];
    if (!policy) {
      throw new MCPGatewayError('tenant_unregistered', `no policy registered for tenant ${args.tenantId}`);
    }

    if (!this.toolMap.has(args.toolName)) {
      throw new MCPGatewayError('unknown_tool', `tool ${args.toolName} not registered`);
    }

    const allowed = policy.allowedTools.includes('*') || policy.allowedTools.includes(args.toolName);
    if (!allowed) {
      throw new MCPGatewayError('tool_not_allowed', `tool ${args.toolName} not in tenant allow-list`);
    }

    if (!policy.trustedIssuers.includes(args.oauth.iss)) {
      throw new MCPGatewayError('untrusted_issuer', `iss ${args.oauth.iss} not in tenant trusted-issuer list (RFC 9207)`);
    }

    const cap = policy.perToolRateLimit?.[args.toolName];
    if (cap && cap > 0) {
      const key = `${args.tenantId}::${args.toolName}`;
      const now = this.now();
      const bucket = (this.callBuckets.get(key) ?? []).filter((t) => now - t < 60_000);
      if (bucket.length >= cap) {
        throw new MCPGatewayError('rate_limited', `tool ${args.toolName} exceeded ${cap}/min for tenant ${args.tenantId}`);
      }
      bucket.push(now);
      this.callBuckets.set(key, bucket);
    }
  }

  private audit(r: AuditRecord): void {
    if (!this.opts.audit) return;
    try {
      this.opts.audit.record(r);
    } catch {
      // audit sink should never break the call
    }
  }
}

export const VERSION = '0.0.0';
