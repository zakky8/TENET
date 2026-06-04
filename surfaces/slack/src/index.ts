/**
 * Slack Surface adapter.
 *
 * Design — no @slack/bolt hard dep: accepts an injected SlackClient
 * (production wraps around Bolt's `app.client.chat.postMessage` or a
 * Web API HTTP client).
 *
 * Two operational modes (verified in research pass 1):
 *   - 'marketplace': Slack-app-store-listed apps; full conversations.*
 *     history access allowed.
 *   - 'internal': non-Marketplace apps installed by customer; after
 *     2025-05-29 conversations.history capped at 15 msgs/req +
 *     1 req/min. Surface signals this mode so apps know to drip-feed.
 *
 * Citation rendering uses Block Kit "section" blocks with a small
 * "context" element listing sources. Falls back to mrkdwn text on
 * any older client.
 */

import type { Citation, NormalizedEvent, NormalizedReply } from '@tenet/core';

export type SlackOperationalMode = 'marketplace' | 'internal';

export interface SlackOutboundMessage {
  channel: string;
  /** Plain-text fallback for clients that don't render blocks. */
  text: string;
  /** Optional Block Kit array. */
  blocks?: ReadonlyArray<unknown>;
  threadTs?: string;
}

export interface SlackClient {
  postMessage(msg: SlackOutboundMessage, opts?: { signal?: AbortSignal }): Promise<{ ts: string }>;
}

export interface SlackEvent {
  /** Slack ts (string like '1700000000.001234'). */
  ts: string;
  channel: string;
  user: string;
  /** Team ID. */
  teamId: string;
  text: string;
  /** Thread parent ts if this is a reply. */
  threadTs?: string;
  /** Subtypes to ignore (bot_message, channel_join, etc.). */
  subtype?: string;
  /** Bot's own user id — needed to skip self-mentions. */
  botUserId?: string;
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

export interface SlackSurfaceOptions {
  client: SlackClient;
  rateLimit?: RateLimitGate;
  tenantId: string;
  /** Bot's own user id (Uxxxxx). */
  botUserId: string;
  /** Operational mode — affects history-backfill behavior. */
  mode?: SlackOperationalMode;
  /** When true, drop messages that don't @-mention the bot. Default false. */
  requireMention?: boolean;
}

export class SlackSurface {
  readonly name = 'slack';
  readonly mode: SlackOperationalMode;
  private readonly requireMention: boolean;

  constructor(private readonly opts: SlackSurfaceOptions) {
    if (!opts.tenantId) throw new Error('SlackSurface: tenantId required');
    if (!opts.botUserId) throw new Error('SlackSurface: botUserId required');
    this.mode = opts.mode ?? 'internal';
    this.requireMention = opts.requireMention ?? false;
  }

  normalize(ev: SlackEvent): NormalizedEvent | null {
    // Drop non-user-message subtypes
    if (ev.subtype !== undefined && ev.subtype !== '') return null;
    if (ev.user === this.opts.botUserId) return null;
    if (!ev.text || ev.text.trim().length === 0) return null;
    const cleaned = stripSlackMention(ev.text, this.opts.botUserId).trim();
    if (cleaned.length === 0) return null;
    if (this.requireMention && !ev.text.includes(`<@${this.opts.botUserId}>`)) {
      return null;
    }
    return {
      surface: this.name,
      tenantId: this.opts.tenantId,
      conversationId: ev.channel,
      userId: ev.user,
      text: cleaned,
      receivedAt: tsToMs(ev.ts),
      metadata: {
        teamId: ev.teamId,
        ...(ev.threadTs !== undefined ? { threadTs: ev.threadTs } : {}),
      },
    };
  }

  async send(args: {
    event: NormalizedEvent;
    reply: NormalizedReply;
    /** Reply in thread instead of channel root. */
    threadTs?: string;
    signal?: AbortSignal;
  }): Promise<{ ts: string }> {
    if (this.opts.rateLimit) {
      await this.opts.rateLimit.schedule({
        platform: 'slack',
        tenantId: args.event.tenantId,
        conversationId: args.event.conversationId,
        userId: args.event.userId,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
    }
    const blocks = renderBlocks(args.reply.text, args.reply.citations);
    const outbound: SlackOutboundMessage = {
      channel: args.event.conversationId,
      text: args.reply.text, // fallback for unblock-enabled clients
      blocks,
      ...(args.threadTs !== undefined ? { threadTs: args.threadTs } : {}),
    };
    return this.opts.client.postMessage(
      outbound,
      args.signal !== undefined ? { signal: args.signal } : undefined,
    );
  }
}

export function stripSlackMention(text: string, botUserId: string): string {
  // Slack mention format: <@Uxxxxx> or <@Uxxxxx|nickname>
  const re = new RegExp(`<@${escapeRegex(botUserId)}(?:\\|[^>]*)?>`, 'g');
  return text.replace(re, '').replace(/\s+/g, ' ').trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert Slack ts (e.g. "1700000000.001234") to wall-clock ms. */
export function tsToMs(ts: string): number {
  const secondsPart = ts.split('.')[0] ?? '0';
  const seconds = Number.parseInt(secondsPart, 10);
  if (Number.isNaN(seconds)) return 0;
  return seconds * 1000;
}

/** Render text + citations as Block Kit blocks. */
export function renderBlocks(
  text: string,
  citations: ReadonlyArray<Citation>,
): ReadonlyArray<unknown> {
  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text },
    },
  ];
  if (citations.length > 0) {
    const items = citations.map((c) => {
      const label = (c.quote ? c.quote.slice(0, 60) : c.sourceId).replace(/[<>]/g, '');
      // Slack mrkdwn link: <url|label>
      return `• <${c.sourceId}|${label}>`;
    });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Sources:*\n${items.join('\n')}` },
    });
  }
  return blocks;
}

export const VERSION = '0.0.0';
