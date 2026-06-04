/**
 * Telegram Surface adapter for TENET.
 *
 * Design — no grammY hard dep: accepts any client implementing
 * TelegramClient. Production deployments wire grammY's `Bot` or
 * `telegraf` behind that interface.
 *
 * Responsibilities:
 *   1. Normalize inbound updates → NormalizedEvent
 *   2. Format outbound NormalizedReply → TelegramOutboundMessage
 *   3. Telegram HTML escaping for &, <, >, "
 *   4. Citation rendering as <a href="...">label</a>
 *   5. Rate-limit policy auto-applied via injected scheduler
 */

import type { NormalizedEvent, NormalizedReply, Citation } from '@tenet/core';

// ── Minimal Telegram client contract ───────────────────────────────────

export interface TelegramOutboundMessage {
  chatId: number | string;
  text: string;
  /** HTML parse mode (only mode we use). */
  parseMode: 'HTML';
  /** Optional reply_to_message_id. */
  replyToMessageId?: number;
}

export interface TelegramClient {
  sendMessage(msg: TelegramOutboundMessage, opts?: { signal?: AbortSignal }): Promise<{ messageId: number }>;
}

/** Minimal Telegram update shape the adapter normalizes. */
export interface TelegramUpdate {
  updateId: number;
  message?: {
    messageId: number;
    date: number; // epoch seconds
    text?: string;
    chat: { id: number | string; type: string };
    from?: { id: number | string };
  };
}

// ── Rate-limit interface (matches @tenet/rate-limit RateLimitScheduler) ─

export interface RateLimitGate {
  schedule(args: {
    platform: string;
    tenantId: string;
    conversationId?: string;
    userId?: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

// ── Adapter ────────────────────────────────────────────────────────────

export interface TelegramSurfaceOptions {
  client: TelegramClient;
  /** RateLimitScheduler from @tenet/rate-limit. Optional but recommended. */
  rateLimit?: RateLimitGate;
  /** Stable tenant id for this bot. */
  tenantId: string;
}

export class TelegramSurface {
  readonly name = 'telegram';

  constructor(private readonly opts: TelegramSurfaceOptions) {
    if (!opts.tenantId) throw new Error('TelegramSurface: tenantId required');
  }

  /** Convert a Telegram update into the framework's NormalizedEvent. */
  normalize(update: TelegramUpdate): NormalizedEvent | null {
    const msg = update.message;
    if (!msg || !msg.text) return null;
    return {
      surface: this.name,
      tenantId: this.opts.tenantId,
      conversationId: String(msg.chat.id),
      userId: String(msg.from?.id ?? msg.chat.id),
      text: msg.text,
      receivedAt: msg.date * 1000,
    };
  }

  /** Send a NormalizedReply back to Telegram with rate-limit + HTML escaping. */
  async send(args: {
    event: NormalizedEvent;
    reply: NormalizedReply;
    replyToMessageId?: number;
    signal?: AbortSignal;
  }): Promise<{ messageId: number }> {
    if (this.opts.rateLimit) {
      await this.opts.rateLimit.schedule({
        platform: 'telegram',
        tenantId: args.event.tenantId,
        conversationId: args.event.conversationId,
        userId: args.event.userId,
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
      });
    }
    const text = renderHtml(args.reply.text, args.reply.citations);
    const outbound: TelegramOutboundMessage = {
      chatId: args.event.conversationId,
      text,
      parseMode: 'HTML',
      ...(args.replyToMessageId !== undefined ? { replyToMessageId: args.replyToMessageId } : {}),
    };
    return this.opts.client.sendMessage(outbound, args.signal !== undefined ? { signal: args.signal } : undefined);
  }
}

// ── HTML rendering ─────────────────────────────────────────────────────

/** Escape any Telegram-HTML-significant char. Always safe to interpolate. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the reply text + citations into Telegram-safe HTML.
 *
 * - Body text is escaped verbatim.
 * - Citations appended as a "Sources:" block of <a href> tags, each
 *   labeled with the source's quote (if present) or the URL itself.
 *   Quote labels are escaped before interpolation.
 *
 * Apps that want fancier formatting (Markdown, inline citations, etc.)
 * supply their own renderer.
 */
export function renderHtml(text: string, citations: ReadonlyArray<Citation>): string {
  const body = escapeHtml(text);
  if (citations.length === 0) return body;
  const lines = citations.map((c) => {
    const quote = c.quote ? c.quote.slice(0, 60) : c.sourceId;
    return `<a href="${escapeHtml(c.sourceId)}">${escapeHtml(quote)}</a>`;
  });
  return `${body}\n\n<b>Sources:</b>\n${lines.join('\n')}`;
}

export const VERSION = '0.0.0';
