/**
 * Reference composition: enterprise-support.
 *
 * Wires multiple surfaces + connectors + agent runtime + outcome
 * telemetry into a single dispatcher. Production deployments use this
 * as a starting point and add their own intent classification, HITL
 * escalation, KB ingestion, etc.
 *
 * The dispatcher routes inbound events (from any surface or ticketing
 * connector) through:
 *   1. Surface/connector-specific normalize → NormalizedEvent
 *   2. Agent runtime → NormalizedReply
 *   3. Surface/connector-specific outbound (send / postReply)
 *   4. Outcome telemetry record
 */

import type {
  NormalizedEvent,
  NormalizedReply,
  Outcome,
} from '@tenet/core';

// ── Adapter shapes (structural, accept anything matching) ──────────────

export interface SurfaceAdapter {
  name: string;
  send: (args: {
    event: NormalizedEvent;
    reply: NormalizedReply;
    signal?: AbortSignal;
  }) => Promise<unknown>;
}

export interface TicketingConnectorAdapter {
  vendor: string;
  postReply: (args: {
    conversationId: string;
    text: string;
    signal?: AbortSignal;
  }) => Promise<void>;
}

export interface AgentRuntime {
  handle: (event: NormalizedEvent, signal?: AbortSignal) => Promise<NormalizedReply>;
}

export interface TelemetrySink {
  record: (e: {
    outcome: Outcome;
    conversationId: string;
    tenantId: string;
    durationMs: number;
    costUsd: number;
    verifierPassed: boolean | null;
    reason?: string;
  }) => void;
}

export interface EnterpriseSupportOptions {
  agent: AgentRuntime;
  surfaces: ReadonlyArray<SurfaceAdapter>;
  connectors: ReadonlyArray<TicketingConnectorAdapter>;
  telemetry?: TelemetrySink;
  /** Wall-clock now() — injectable for tests. */
  now?: () => number;
}

export class EnterpriseSupportApp {
  private readonly surfaces: Map<string, SurfaceAdapter>;
  private readonly connectors: Map<string, TicketingConnectorAdapter>;
  private readonly now: () => number;

  constructor(private readonly opts: EnterpriseSupportOptions) {
    if (!opts.agent) throw new Error('EnterpriseSupportApp: agent required');
    this.surfaces = new Map(opts.surfaces.map((s) => [s.name, s]));
    this.connectors = new Map(opts.connectors.map((c) => [c.vendor, c]));
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Dispatch an inbound event through the agent and out via the same
   * surface / connector it came from.
   *
   * Routing key: event.surface is matched against:
   *   1. Registered SurfaceAdapter.name (e.g. 'telegram', 'slack')
   *   2. 'ticketing:<vendor>' prefix → routes to the named
   *      TicketingConnectorAdapter
   */
  async dispatch(event: NormalizedEvent, signal?: AbortSignal): Promise<NormalizedReply> {
    const start = this.now();
    let reply: NormalizedReply;
    let outcome: Outcome = 'pending';
    let reason: string | undefined;
    let verifierPassed: boolean | null = null;

    try {
      reply = await this.opts.agent.handle(event, signal);
      verifierPassed = true;
      // Route outbound
      const surface = this.surfaces.get(event.surface);
      if (surface) {
        await surface.send({ event, reply, ...(signal !== undefined ? { signal } : {}) });
      } else if (event.surface.startsWith('ticketing:')) {
        const vendor = event.surface.slice('ticketing:'.length);
        const conn = this.connectors.get(vendor);
        if (!conn) throw new Error(`no connector registered for vendor ${vendor}`);
        await conn.postReply({
          conversationId: event.conversationId,
          text: reply.text,
          ...(signal !== undefined ? { signal } : {}),
        });
      } else {
        throw new Error(`no surface or connector registered for ${event.surface}`);
      }
      outcome = 'resolved';
    } catch (e) {
      outcome = 'disqualified';
      reason = `dispatch error: ${(e as Error).message}`;
      reply = { text: '', citations: [] };
    }

    if (this.opts.telemetry) {
      this.opts.telemetry.record({
        outcome,
        conversationId: event.conversationId,
        tenantId: event.tenantId,
        durationMs: this.now() - start,
        costUsd: 0,
        verifierPassed,
        ...(reason !== undefined ? { reason } : {}),
      });
    }

    return reply;
  }

  /** Inspect registered surfaces / connectors for diagnostics. */
  inventory(): {
    surfaces: ReadonlyArray<string>;
    connectors: ReadonlyArray<string>;
  } {
    return {
      surfaces: Array.from(this.surfaces.keys()),
      connectors: Array.from(this.connectors.keys()),
    };
  }
}

export const VERSION = '0.0.0';
