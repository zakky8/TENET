import { CircuitBreaker, CircuitOpenError } from './circuitBreaker.js';
import { TokenBucket } from './tokenBucket.js';
import type { PlatformPolicy } from './policies.js';

/**
 * Scheduler — composes policy buckets + a circuit breaker per (platform,
 * tenant) and exposes a single schedule() entry point.
 *
 * Bucket lookups are lazy: the first call for a (platform, scope) pair
 * allocates the TokenBucket. State persists for the scheduler's
 * lifetime. Operators run one scheduler per process; multi-process
 * deployments coordinate via the persistent bucket store (not in MVP).
 */
export class RateLimitScheduler {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly policies: Record<string, PlatformPolicy>) {}

  /**
   * Acquire all tokens required for a single call. Throws CircuitOpenError
   * if the breaker for this platform+tenant is open. Otherwise returns
   * once buckets have granted.
   */
  async schedule(args: {
    platform: string;
    tenantId: string;
    conversationId?: string;
    userId?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const policy = this.policies[args.platform];
    if (!policy) {
      throw new Error(`No rate-limit policy registered for platform ${JSON.stringify(args.platform)}`);
    }

    const breaker = this.getBreaker(args.platform, args.tenantId);
    if (!breaker.allow()) {
      throw new CircuitOpenError(
        `circuit open for platform=${args.platform} tenant=${args.tenantId}`,
      );
    }

    const specs = policy.buckets({
      tenantId: args.tenantId,
      conversationId: args.conversationId,
      userId: args.userId,
    });

    for (const spec of specs) {
      const bucket = this.getBucket(spec.scopeKey, spec.bucket);
      await bucket.acquire(1, args.signal);
    }
  }

  /** Record an auth failure (401/403) for this platform+tenant. */
  recordAuthFailure(platform: string, tenantId: string): void {
    this.getBreaker(platform, tenantId).recordAuthFailure();
  }

  /** Record a successful response — closes any half-open breaker. */
  recordSuccess(platform: string, tenantId: string): void {
    this.getBreaker(platform, tenantId).recordSuccess();
  }

  /** Snapshot for telemetry / diagnostics. */
  snapshot(): {
    buckets: Array<{ scope: string; available: number }>;
    breakers: Array<{ key: string; state: string; failures: number }>;
  } {
    return {
      buckets: Array.from(this.buckets.entries()).map(([scope, b]) => ({
        scope,
        available: b.available(),
      })),
      breakers: Array.from(this.breakers.entries()).map(([key, br]) => ({
        key,
        state: br.currentState(),
        failures: br.failureCount(),
      })),
    };
  }

  private getBucket(scopeKey: string, opts: ConstructorParameters<typeof TokenBucket>[0]): TokenBucket {
    let b = this.buckets.get(scopeKey);
    if (!b) {
      b = new TokenBucket(opts);
      this.buckets.set(scopeKey, b);
    }
    return b;
  }

  private getBreaker(platform: string, tenantId: string): CircuitBreaker {
    const key = `${platform}:${tenantId}`;
    let br = this.breakers.get(key);
    if (!br) {
      br = new CircuitBreaker();
      this.breakers.set(key, br);
    }
    return br;
  }
}
