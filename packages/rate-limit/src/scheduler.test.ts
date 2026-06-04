import { RateLimitScheduler } from './scheduler.js';
import { TELEGRAM_POLICY, DISCORD_POLICY } from './policies.js';
import { CircuitOpenError } from './circuitBreaker.js';

describe('RateLimitScheduler — schedule()', () => {
  it('schedules a Telegram call: per-chat + per-bot buckets both acquired', async () => {
    const sched = new RateLimitScheduler({ telegram: TELEGRAM_POLICY });
    await expect(
      sched.schedule({
        platform: 'telegram',
        tenantId: 'tenant-A',
        conversationId: 'chat-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('throws for unknown platform', async () => {
    const sched = new RateLimitScheduler({});
    await expect(
      sched.schedule({ platform: 'unknown', tenantId: 'x' }),
    ).rejects.toThrow(/No rate-limit policy/);
  });

  it('rejects with CircuitOpenError when breaker is open', async () => {
    const sched = new RateLimitScheduler({ discord: DISCORD_POLICY });
    for (let i = 0; i < 100; i++) sched.recordAuthFailure('discord', 'tenant-X');
    await expect(
      sched.schedule({ platform: 'discord', tenantId: 'tenant-X' }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
  });
});

describe('RateLimitScheduler — auth-failure + success bookkeeping', () => {
  it('recordSuccess resets failure count for a tenant', () => {
    const sched = new RateLimitScheduler({ discord: DISCORD_POLICY });
    sched.recordAuthFailure('discord', 'tenant-Y');
    sched.recordAuthFailure('discord', 'tenant-Y');
    sched.recordSuccess('discord', 'tenant-Y');
    const snap = sched.snapshot();
    const br = snap.breakers.find((b) => b.key === 'discord:tenant-Y');
    expect(br?.failures).toBe(0);
  });

  it('failures are isolated per (platform, tenant)', () => {
    const sched = new RateLimitScheduler({ discord: DISCORD_POLICY });
    sched.recordAuthFailure('discord', 'A');
    sched.recordAuthFailure('discord', 'A');
    sched.recordAuthFailure('discord', 'B');
    const snap = sched.snapshot();
    const a = snap.breakers.find((b) => b.key === 'discord:A');
    const b = snap.breakers.find((b) => b.key === 'discord:B');
    expect(a?.failures).toBe(2);
    expect(b?.failures).toBe(1);
  });
});

describe('RateLimitScheduler — snapshot for telemetry', () => {
  it('lists buckets and breakers after activity', async () => {
    const sched = new RateLimitScheduler({ telegram: TELEGRAM_POLICY });
    await sched.schedule({ platform: 'telegram', tenantId: 'T', conversationId: 'c1' });
    sched.recordAuthFailure('telegram', 'T');
    const snap = sched.snapshot();
    expect(snap.buckets.length).toBeGreaterThanOrEqual(2);
    expect(snap.breakers.find((b) => b.key === 'telegram:T')).toBeDefined();
  });
});
