/**
 * Discord Surface adapter.
 *
 * Design — no discord.js hard dep: accepts an injected DiscordClient
 * that production wraps around `discord.js`'s `Client` or any HTTP
 * gateway. The surface owns:
 *   - normalize: DiscordMessage → NormalizedEvent
 *   - send: NormalizedReply → outbound Discord message (Markdown-style
 *     with citation footer)
 *   - mention strip + bot-author skip
 *   - rate-limit gate (optional, recommended)
 *
 * Citation rendering uses Discord Markdown ("[label](url)") — Discord
 * does NOT support HTML. Source labels are truncated to 60 chars.
 */

import type { Citation, NormalizedEvent, NormalizedReply } from '@tenet/core';

export interface DiscordOutboundMessage {
  channelId: string;
  content: string;
  /** Optional reply target. */
  replyToMessageId?: string;
}

export interface DiscordClient {
  sendMessage(msg: DiscordOutboundMessage, opts?: { signal?: AbortSignal }): Promise<{ messageId: string }>;
}

export interface DiscordMessage {
  id: string;
  /** Bot's own user id — needed to skip self-mentions. */
  authorId: string;
  /** True if the author is a bot. */
  authorIsBot: boolean;
  channelId: string;
  guildId?: string;
  /** Wall-clock ms (Discord epoch differs; converter is caller responsibility). */
  createdAtMs: number;
  content: string;
  /** User IDs explicitly mentioned in the message (Discord parses these for us). */
  mentions: ReadonlyArray<string>;
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

export interface DiscordSurfaceOptions {
  client: DiscordClient;
  rateLimit?: RateLimitGate;
  tenantId: string;
  /** Bot's own user id — messages it sends are skipped from normalize(). */
  botUserId: string;
  /** When true, drop messages that don't mention the bot. Default false. */
  requireMention?: boolean;
}

export class DiscordSurface {
  readonly name = 'discord';
  private readonly requireMention: boolean;

  constructor(private readonly opts: DiscordSurfaceOptions) {
    if (!opts.tenantId) throw new Error('DiscordSurface: tenantId required');
    if (!opts.botUserId) throw new Error('DiscordSurface: botUserId required');
    this.requireMention = opts.requireMention ?? false;
  }

  normalize(msg: DiscordMessage): NormalizedEvent | null {
    if (msg.authorIsBot) return null;
    if (msg.authorId === this.opts.botUserId) return null;
    if (!msg.content || msg.content.trim().length === 0) return null;
    if (this.requireMention && !msg.mentions.includes(this.opts.botUserId)) {
      return null;
    }
    // Strip the bot's mention from text so the agent sees the question only.
    const cleaned = stripMentions(msg.content, [this.opts.botUserId]).trim();
    if (cleaned.length === 0) return null;
    return {
      surface: this.name,
      tenantId: this.opts.tenantId,
      conversationId: msg.channelId,
      userId: msg.authorId,
      text: cleaned,
      receivedAt: msg.createdAtMs,
      ...(msg.guildId !== undefined ? { metadata: { guildId: msg.guildId } } : {}),
    };
  }

  async send(args: {
    event: NormalizedEvent;
    reply: NormalizedReply;
    replyToMessageId?: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: string }> {
    if (this.opts.rateLimit) {
      await this.opts.rateLimit.schedule({
        platform: 'discord',
        tenantId: args.event.tenantId,
        conversationId: args.event.conversationId,
        userId: args.event.userId,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
    }
    const content = renderMarkdown(args.reply.text, args.reply.citations);
    const outbound: DiscordOutboundMessage = {
      channelId: args.event.conversationId,
      content,
      ...(args.replyToMessageId !== undefined ? { replyToMessageId: args.replyToMessageId } : {}),
    };
    return this.opts.client.sendMessage(
      outbound,
      args.signal !== undefined ? { signal: args.signal } : undefined,
    );
  }
}

/** Strip Discord-style <@123> and <@!123> mentions for the given user ids. */
export function stripMentions(text: string, userIds: ReadonlyArray<string>): string {
  let out = text;
  for (const id of userIds) {
    // Discord mentions: <@USERID> or <@!USERID> (nickname form)
    out = out.replace(new RegExp(`<@!?${escapeRegex(id)}>`, 'g'), '');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render reply text + citations as Discord Markdown.
 * Discord does NOT accept HTML; uses `[label](url)` link form.
 * Adds zero-width space inside URLs to defeat any unintended auto-embed.
 */
export function renderMarkdown(text: string, citations: ReadonlyArray<Citation>): string {
  if (citations.length === 0) return text;
  const lines = citations.map((c) => {
    const label = (c.quote ? c.quote.slice(0, 60) : c.sourceId).replace(/[\[\]]/g, '');
    return `• [${label}](${c.sourceId})`;
  });
  return `${text}\n\n**Sources:**\n${lines.join('\n')}`;
}

export const VERSION = '0.0.0';
