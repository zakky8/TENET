/**
 * Microsoft Teams Surface adapter.
 *
 * Design — no botbuilder-core / botframework hard dep: accepts an
 * injected TeamsClient. Production wraps around the Bot Framework
 * SDK or a Teams Webhook listener.
 *
 * Per research pass 1 (verified docs.microsoft.com 2026-05-29):
 *   - 50 RPS per app per tenant global cap
 *   - 1800 send-to-conversation ops/hour/thread
 * The teamsPolicy in @tenet/rate-limit encodes these; surface wires
 * the gate.
 *
 * Reply rendering uses Adaptive Cards v1.5 — a single TextBlock for
 * the body and an optional ColumnSet of source links for citations.
 * Apps that need richer cards supply their own renderer.
 */

import type { Citation, NormalizedEvent, NormalizedReply } from '@tenet/core';

export interface TeamsOutboundActivity {
  /** Service URL Microsoft returns with the incoming activity. */
  serviceUrl: string;
  conversationId: string;
  /** Adaptive Card JSON for an attachment OR plain text fallback. */
  text: string;
  /** Adaptive Card attachments. */
  attachments?: ReadonlyArray<unknown>;
  /** Reply-to activity id. */
  replyToId?: string;
}

export interface TeamsClient {
  sendActivity(act: TeamsOutboundActivity, opts?: { signal?: AbortSignal }): Promise<{ activityId: string }>;
}

export interface TeamsActivity {
  /** Activity type — only 'message' is normalized; others ignored. */
  type: string;
  id: string;
  /** Teams sends ISO timestamp; convert to ms. */
  timestamp: string;
  serviceUrl: string;
  conversation: { id: string; tenantId?: string };
  from: { id: string };
  /** Recipient (bot) — needed for self-message check. */
  recipient: { id: string };
  text?: string;
  /** Adaptive Card response from a previous bot card (action.execute). */
  value?: Record<string, unknown>;
  /** Channel id for guild-style chats (vs personal). */
  channelData?: { teamId?: string; channel?: { id?: string } };
}

export interface RateLimitGate {
  schedule(args: {
    platform: string;
    tenantId: string;
    conversationId?: string;
    userId?: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export interface TeamsSurfaceOptions {
  client: TeamsClient;
  rateLimit?: RateLimitGate;
  /** Bot's own id — used to skip self-messages. */
  botUserId: string;
  /** Fallback tenant id when activity doesn't carry one. */
  defaultTenantId?: string;
}

export class TeamsSurface {
  readonly name = 'teams';

  constructor(private readonly opts: TeamsSurfaceOptions) {
    if (!opts.botUserId) throw new Error('TeamsSurface: botUserId required');
  }

  normalize(act: TeamsActivity): NormalizedEvent | null {
    if (act.type !== 'message') return null;
    if (act.from.id === this.opts.botUserId) return null;
    const text = act.text?.trim();
    if (!text || text.length === 0) return null;
    const tenantId = act.conversation.tenantId ?? this.opts.defaultTenantId;
    if (!tenantId) return null;
    const receivedAt = Date.parse(act.timestamp);
    return {
      surface: this.name,
      tenantId,
      conversationId: act.conversation.id,
      userId: act.from.id,
      text,
      receivedAt: Number.isNaN(receivedAt) ? 0 : receivedAt,
      metadata: {
        serviceUrl: act.serviceUrl,
        ...(act.channelData?.teamId !== undefined ? { teamId: act.channelData.teamId } : {}),
      },
    };
  }

  async send(args: {
    event: NormalizedEvent;
    reply: NormalizedReply;
    replyToId?: string;
    signal?: AbortSignal;
  }): Promise<{ activityId: string }> {
    if (this.opts.rateLimit) {
      await this.opts.rateLimit.schedule({
        platform: 'teams',
        tenantId: args.event.tenantId,
        conversationId: args.event.conversationId,
        userId: args.event.userId,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
    }
    const serviceUrl = String(args.event.metadata?.serviceUrl ?? '');
    if (!serviceUrl) throw new Error('TeamsSurface.send: event.metadata.serviceUrl required');
    const card = renderAdaptiveCard(args.reply.text, args.reply.citations);
    const outbound: TeamsOutboundActivity = {
      serviceUrl,
      conversationId: args.event.conversationId,
      text: args.reply.text, // fallback for non-card clients
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: card,
        },
      ],
      ...(args.replyToId !== undefined ? { replyToId: args.replyToId } : {}),
    };
    return this.opts.client.sendActivity(
      outbound,
      args.signal !== undefined ? { signal: args.signal } : undefined,
    );
  }
}

/** Build an Adaptive Card v1.5 with a body TextBlock + optional sources column. */
export function renderAdaptiveCard(text: string, citations: ReadonlyArray<Citation>): Record<string, unknown> {
  const body: unknown[] = [{ type: 'TextBlock', text, wrap: true }];
  if (citations.length > 0) {
    const items = citations.map((c) => {
      const label = (c.quote ? c.quote.slice(0, 60) : c.sourceId);
      return { type: 'TextBlock', text: `- [${label}](${c.sourceId})`, wrap: true, isSubtle: true };
    });
    body.push(
      { type: 'TextBlock', text: '**Sources:**', weight: 'Bolder', spacing: 'Medium' },
      ...items,
    );
  }
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body,
  };
}

export const VERSION = '0.0.0';
