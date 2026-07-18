/**
 * Web-widget Surface — SSE streamer for embeddable browser widgets.
 *
 * Design — no HTTP framework hard dep: returns a framework-agnostic
 * SseResponse {status, headers, body: AsyncIterable<string>} that
 * Express / Fastify / Hono / Cloudflare Workers wire to their native
 * Response shape. Each yielded string is one SSE line block ready to
 * write to the wire.
 *
 * Concerns owned by this surface:
 *   - JWT session validation (HMAC-SHA256 by default; verifier
 *     injectable for asymmetric keys)
 *   - CORS origin allow-list
 *   - SSE wire format (event-stream conformance)
 *   - AbortSignal honored for client-disconnect cancellation
 *   - Rate-limit gate (optional)
 *
 * The agent runtime itself is NOT here — the caller supplies a stream()
 * function that produces an AsyncIterable<string> of reply chunks.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NormalizedEvent } from '@tenet/core';

// ── JWT (HS256 minimal verifier) ───────────────────────────────────────

export interface JwtClaims {
  /** Subject — usually the end-user id. */
  sub: string;
  /** Tenant id. */
  tnt: string;
  /** Expiry epoch seconds. */
  exp: number;
  /** Not-before epoch seconds — token is invalid until this time. */
  nbf?: number;
  /** Issued-at epoch seconds. */
  iat?: number;
  /** Free-form custom claims. */
  [k: string]: unknown;
}

export interface JwtVerifier {
  verify(token: string): Promise<JwtClaims>;
}

/** HS256 verifier — apps with asymmetric keys plug their own. */
export function hs256Verifier(secret: string, opts: { now?: () => number } = {}): JwtVerifier {
  if (!secret || secret.length < 16) {
    throw new Error('hs256Verifier: secret must be >= 16 chars');
  }
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    async verify(token: string): Promise<JwtClaims> {
      const parts = token.split('.');
      if (parts.length !== 3) throw new JwtError('malformed JWT (parts != 3)');
      const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
      // SECURITY: assert alg=HS256 BEFORE verifying the signature. A token
      // whose header claims alg:none or RS256 must be rejected even if an
      // HMAC over header.payload happens to match — this closes the alg:none
      // and RS256→HS256 confusion classes. Never trust the header's alg.
      // Parity with the REST surface's hs256RestVerifier.
      let header: unknown;
      try {
        header = JSON.parse(Buffer.from(b64UrlDecode(headerB64), 'base64').toString('utf8'));
      } catch {
        throw new JwtError('malformed JWT header');
      }
      if (
        header === null ||
        typeof header !== 'object' ||
        (header as { alg?: unknown }).alg !== 'HS256'
      ) {
        throw new JwtError('JWT alg must be HS256');
      }
      const expectedSig = createHmac('sha256', secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest();
      let actualSig: Buffer;
      try {
        actualSig = Buffer.from(b64UrlDecode(sigB64), 'base64');
      } catch {
        throw new JwtError('signature decode failed');
      }
      if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
        throw new JwtError('signature mismatch');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(b64UrlDecode(payloadB64), 'base64').toString('utf8'));
      } catch {
        throw new JwtError('payload decode failed');
      }
      if (!isJwtClaims(payload)) throw new JwtError('claims missing sub/tnt/exp');
      // Optional nbf (not-before): a token that is not yet valid must be
      // rejected, not just an expired one. Parity with the REST surface.
      if (typeof payload.nbf === 'number' && payload.nbf > now()) {
        throw new JwtError('token not yet valid');
      }
      if (payload.exp < now()) throw new JwtError('token expired');
      return payload;
    },
  };
}

function b64UrlDecode(s: string): string {
  return s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
}

function isJwtClaims(v: unknown): v is JwtClaims {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.sub === 'string' && typeof o.tnt === 'string' && typeof o.exp === 'number';
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

// ── Surface ────────────────────────────────────────────────────────────

export interface WebWidgetRequest {
  method: string;
  headers: Readonly<Record<string, string | undefined>>;
  body?: { text?: string };
  signal?: AbortSignal;
}

export interface SseResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<string>;
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

export interface WebWidgetOptions {
  jwt: JwtVerifier;
  rateLimit?: RateLimitGate;
  /** Allowed CORS origins. '*' allows all. Empty array disables CORS. */
  allowedOrigins: ReadonlyArray<string>;
  /**
   * Stream agent reply chunks for a NormalizedEvent.
   * Apps inject this — yields plain text chunks; surface wraps in SSE.
   */
  stream: (event: NormalizedEvent, signal?: AbortSignal) => AsyncIterable<string>;
}

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export class WebWidgetSurface {
  readonly name = 'web-widget';

  constructor(private readonly opts: WebWidgetOptions) {
    if (!opts.jwt) throw new Error('WebWidgetSurface: jwt verifier required');
    if (!opts.stream) throw new Error('WebWidgetSurface: stream function required');
  }

  async handle(req: WebWidgetRequest): Promise<SseResponse> {
    // CORS origin check
    const origin = req.headers['origin'] ?? req.headers['Origin'];
    const corsAllowed = this.checkOrigin(origin);
    if (!corsAllowed.allowed) {
      return errorResponse(403, `CORS origin not allowed: ${origin ?? '(unset)'}`);
    }
    const corsHeaders = corsAllowed.headers;

    if (req.method.toUpperCase() === 'OPTIONS') {
      return {
        status: 204,
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
        body: emptyBody(),
      };
    }
    if (req.method.toUpperCase() !== 'POST') {
      return errorResponse(405, 'POST or OPTIONS only');
    }

    // JWT
    const authz = req.headers['authorization'] ?? req.headers['Authorization'];
    const token = authz?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return errorResponse(401, 'missing Bearer token');
    let claims: JwtClaims;
    try {
      claims = await this.opts.jwt.verify(token);
    } catch (e) {
      return errorResponse(401, `jwt: ${(e as Error).message}`);
    }

    const text = req.body?.text;
    if (!text || text.trim().length === 0) {
      return errorResponse(400, 'body.text required');
    }

    if (this.opts.rateLimit) {
      try {
        await this.opts.rateLimit.schedule({
          platform: 'web-widget',
          tenantId: claims.tnt,
          conversationId: claims.sub,
          userId: claims.sub,
          ...(req.signal !== undefined ? { signal: req.signal } : {}),
        });
      } catch (e) {
        return errorResponse(429, `rate-limited: ${(e as Error).message}`);
      }
    }

    const event: NormalizedEvent = {
      surface: this.name,
      tenantId: claims.tnt,
      conversationId: claims.sub,
      userId: claims.sub,
      text,
      receivedAt: Date.now(),
    };

    return {
      status: 200,
      headers: { ...SSE_HEADERS, ...corsHeaders },
      body: this.streamSse(event, req.signal),
    };
  }

  private async *streamSse(
    event: NormalizedEvent,
    signal?: AbortSignal,
  ): AsyncIterable<string> {
    try {
      for await (const chunk of this.opts.stream(event, signal)) {
        if (signal?.aborted) return;
        yield formatSse('chunk', chunk);
      }
      yield formatSse('done', '');
    } catch (e) {
      yield formatSse('error', (e as Error).message);
    }
  }

  private checkOrigin(origin: string | undefined): {
    allowed: boolean;
    headers: Record<string, string>;
  } {
    if (this.opts.allowedOrigins.length === 0) return { allowed: true, headers: {} };
    if (!origin) return { allowed: false, headers: {} };
    const allowed =
      this.opts.allowedOrigins.includes('*') || this.opts.allowedOrigins.includes(origin);
    if (!allowed) return { allowed: false, headers: {} };
    return {
      allowed: true,
      headers: {
        'Access-Control-Allow-Origin': this.opts.allowedOrigins.includes('*') ? '*' : origin,
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
      },
    };
  }
}

/** Format one SSE event block. */
export function formatSse(event: string, data: string): string {
  // Each newline in data must become its own data: line per SSE spec.
  const dataLines = data.split('\n').map((l) => `data: ${l}`).join('\n');
  return `event: ${event}\n${dataLines}\n\n`;
}

async function* emptyBody(): AsyncIterable<string> {
  // intentionally empty
}

function errorResponse(status: number, message: string): SseResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: (async function* () {
      yield JSON.stringify({ error: message });
    })(),
  };
}

export const VERSION = '0.0.0';
