/**
 * Per-platform rate-limit policies, anchored to the limits verified by
 * pass-1 research (see docs/BENCHMARKS.md and ARCHITECTURE.md §10).
 *
 * Each entry encodes the documented bucket(s) for the platform plus a
 * `verifiedAt` ISO date — re-verify these whenever the platform docs
 * change. The numbers below are policy, not physics.
 */

import type { TokenBucketOptions } from './tokenBucket.js';

export interface PlatformBucketSpec {
  /** Stable identifier for the scope (e.g. "telegram:perChat:dm:123"). */
  scopeKey: string;
  bucket: TokenBucketOptions;
}

export interface PlatformPolicy {
  platform: string;
  verifiedAt: string;
  source: string;
  /** Build the bucket spec(s) given the call context. */
  buckets(ctx: {
    tenantId: string;
    conversationId?: string;
    userId?: string;
  }): PlatformBucketSpec[];
}

// ── Telegram ──────────────────────────────────────────────────────────
// FAQ: 1 msg/sec/chat, 20 msg/min/group, ~30 msg/sec broadcast.
export const TELEGRAM_POLICY: PlatformPolicy = {
  platform: 'telegram',
  verifiedAt: '2026-06-03',
  source: 'https://core.telegram.org/bots/faq',
  buckets({ tenantId, conversationId }) {
    const out: PlatformBucketSpec[] = [];
    if (conversationId) {
      out.push({
        scopeKey: `telegram:perChat:${tenantId}:${conversationId}`,
        bucket: { capacity: 1, refillTokensPerSec: 1 },
      });
    }
    out.push({
      scopeKey: `telegram:perBot:${tenantId}:broadcast`,
      bucket: { capacity: 30, refillTokensPerSec: 30 },
    });
    return out;
  },
};

// ── Discord ───────────────────────────────────────────────────────────
// 50 invalid-request budget is a CIRCUIT-BREAKER concern, not a token
// bucket. Discord's per-route limits are response-header-driven; this
// policy emits a safe outbound cap that's well below typical guild
// rate limits.
export const DISCORD_POLICY: PlatformPolicy = {
  platform: 'discord',
  verifiedAt: '2026-06-03',
  source: 'https://docs.discord.com/developers/topics/rate-limits',
  buckets({ tenantId }) {
    return [
      {
        scopeKey: `discord:perBot:${tenantId}`,
        bucket: { capacity: 50, refillTokensPerSec: 10 },
      },
    ];
  },
};

// ── Slack ─────────────────────────────────────────────────────────────
// chat.postMessage: 1/sec/channel; tier 3 method: ~50+/min.
export const SLACK_POLICY: PlatformPolicy = {
  platform: 'slack',
  verifiedAt: '2026-06-03',
  source: 'https://docs.slack.dev/apis/web-api/rate-limits',
  buckets({ tenantId, conversationId }) {
    const out: PlatformBucketSpec[] = [];
    if (conversationId) {
      out.push({
        scopeKey: `slack:perChannel:${tenantId}:${conversationId}`,
        bucket: { capacity: 1, refillTokensPerSec: 1 },
      });
    }
    out.push({
      scopeKey: `slack:perApp:${tenantId}:tier3`,
      bucket: { capacity: 50, refillTokensPerSec: 50 / 60 },
    });
    return out;
  },
};

// ── Microsoft Teams ───────────────────────────────────────────────────
// 50 RPS per app per tenant; 1800 send-to-conversation ops / hour / thread.
export const TEAMS_POLICY: PlatformPolicy = {
  platform: 'teams',
  verifiedAt: '2026-06-03',
  source: 'https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit',
  buckets({ tenantId, conversationId }) {
    const out: PlatformBucketSpec[] = [];
    out.push({
      scopeKey: `teams:perTenant:${tenantId}`,
      bucket: { capacity: 50, refillTokensPerSec: 50 },
    });
    if (conversationId) {
      out.push({
        scopeKey: `teams:perThread:${tenantId}:${conversationId}`,
        bucket: { capacity: 1800, refillTokensPerSec: 1800 / 3600 },
      });
    }
    return out;
  },
};

// ── Zendesk ───────────────────────────────────────────────────────────
// Conservative defaults; operators override via plan + endpoint sub-cap.
export const ZENDESK_POLICY: PlatformPolicy = {
  platform: 'zendesk',
  verifiedAt: '2026-06-03',
  source: 'https://developer.zendesk.com/api-reference/introduction/rate-limits/',
  buckets({ tenantId }) {
    return [
      {
        scopeKey: `zendesk:perAccount:${tenantId}`,
        bucket: { capacity: 200, refillTokensPerSec: 200 / 60 },
      },
    ];
  },
};

export const ALL_POLICIES: Record<string, PlatformPolicy> = {
  telegram: TELEGRAM_POLICY,
  discord: DISCORD_POLICY,
  slack: SLACK_POLICY,
  teams: TEAMS_POLICY,
  zendesk: ZENDESK_POLICY,
};
