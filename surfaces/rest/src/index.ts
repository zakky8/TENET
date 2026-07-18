/**
 * REST surface — OpenAPI 3.1 / JSON over HTTP.
 *
 * Framework-agnostic: returns a {status, headers, body} that Express,
 * Fastify, Hono, Cloudflare Workers wire to native Response. Two
 * endpoints:
 *   POST /v1/converse        — single-turn invocation, returns
 *                              {reply, citations, conversationId}
 *   POST /v1/converse/stream — same but SSE-streamed
 *
 * JWT session validation (shared shape from @tenet/surface-web-widget
 * would be reusable but we keep it standalone to avoid a cross-package
 * dep).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NormalizedEvent, NormalizedReply } from '@tenet/core';
import { groundedRenderGate } from '@tenet/surface-core';

// ── HTTP types ─────────────────────────────────────────────────────────

export interface RestRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  signal?: AbortSignal;
}

export interface RestResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: AsyncIterable<string> | string;
}

// ── JWT verifier (HS256 minimal — same surface as web-widget) ──────────

export interface RestJwtClaims {
  sub: string;
  tnt: string;
  exp: number;
}

export interface RestJwtVerifier {
  verify(token: string): Promise<RestJwtClaims>;
}

export function hs256RestVerifier(secret: string, opts: { now?: () => number } = {}): RestJwtVerifier {
  if (!secret || secret.length < 16) throw new Error('hs256RestVerifier: secret must be >= 16 chars');
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    async verify(token: string): Promise<RestJwtClaims> {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('malformed JWT');
      const [hdr, pld, sig] = parts as [string, string, string];
      // SECURITY 2026-06-04 vuln-test: assert alg=HS256 BEFORE verifying
      // — prevents the alg=none + alg-confusion (RS256→HS256-with-RSA-
      // public-key) classes. Standard JWT discipline.
      let header: unknown;
      try {
        header = JSON.parse(Buffer.from(b64UrlDecode(hdr), 'base64').toString('utf8'));
      } catch {
        throw new Error('malformed JWT header');
      }
      if (
        header === null ||
        typeof header !== 'object' ||
        (header as { alg?: unknown }).alg !== 'HS256'
      ) {
        throw new Error('JWT alg must be HS256');
      }
      const expected = createHmac('sha256', secret).update(`${hdr}.${pld}`).digest();
      const decoded = Buffer.from(b64UrlDecode(sig), 'base64');
      // SECURITY 2026-06-04 vuln-test: length-equalise before timingSafeEqual
      // so the same code path runs regardless of attacker-controlled sig
      // length (timing-uniformity). Mismatched length still fails the equal.
      const actual = decoded.length === expected.length
        ? decoded
        : Buffer.alloc(expected.length);
      if (!timingSafeEqual(actual, expected) || decoded.length !== expected.length) {
        throw new Error('signature mismatch');
      }
      const payload = JSON.parse(Buffer.from(b64UrlDecode(pld), 'base64').toString('utf8'));
      if (
        payload === null ||
        typeof payload !== 'object' ||
        typeof payload.sub !== 'string' ||
        typeof payload.tnt !== 'string' ||
        typeof payload.exp !== 'number'
      ) {
        throw new Error('claims missing sub/tnt/exp');
      }
      // Optional nbf (not-before) check when present.
      if (typeof payload.nbf === 'number' && payload.nbf > now()) {
        throw new Error('token not yet valid');
      }
      if (payload.exp < now()) throw new Error('token expired');
      return payload as RestJwtClaims;
    },
  };
}

function b64UrlDecode(s: string): string {
  return s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
}

// ── Surface ────────────────────────────────────────────────────────────

export interface RestRateLimitGate {
  schedule(args: {
    platform: string;
    tenantId: string;
    conversationId?: string;
    userId?: string;
    signal?: AbortSignal;
  }): Promise<void>;
}

export interface ReadinessCheck {
  /** True when the dependency is ready to serve. */
  ready(): Promise<boolean> | boolean;
  /** Stable id for the /readyz body. */
  name: string;
}

export interface RestSurfaceOptions {
  jwt: RestJwtVerifier;
  rateLimit?: RestRateLimitGate;
  /** Single-turn handler — returns the full reply for /converse. */
  handle: (event: NormalizedEvent, signal?: AbortSignal) => Promise<NormalizedReply>;
  /** Optional streaming handler — yields text chunks for /converse/stream. */
  stream?: (event: NormalizedEvent, signal?: AbortSignal) => AsyncIterable<string>;
  /**
   * When set, the surface REFUSES to render a non-stream reply that carries no
   * grounded citation: it returns this safe message instead of the (possibly
   * ungrounded) reply text, with citations zeroed. Defense in depth for
   * grounded-or-abstain AT THE WIRE — even a reply that reached here bypassing
   * the agent's emit edge cannot leak an ungrounded fact. Absent → the reply
   * text is rendered as-is. (Applies to /v1/converse; streaming is not gated —
   * see the note on the stream path.)
   */
  groundedFallback?: string;
  /**
   * Optional readiness probes. Each runs on /readyz; ALL must report ready
   * for /readyz to return 200. Empty/absent → always ready.
   */
  readinessProbes?: ReadonlyArray<ReadinessCheck>;
}

export class RestSurface {
  readonly name = 'rest';

  constructor(private readonly opts: RestSurfaceOptions) {
    if (!opts.jwt) throw new Error('RestSurface: jwt verifier required');
    if (!opts.handle) throw new Error('RestSurface: handle fn required');
  }

  async handle(req: RestRequest): Promise<RestResponse> {
    // Health endpoints — no JWT, no body, no method restriction beyond GET.
    // /healthz: liveness (process is up).
    // /readyz : readiness (dependencies wired and ready to serve).
    if (req.path === '/healthz') {
      return jsonResponse(200, { status: 'ok', uptime: process.uptime() });
    }
    if (req.path === '/readyz') {
      const ready = await this.checkReadiness();
      return jsonResponse(ready.ready ? 200 : 503, ready);
    }

    if (req.method.toUpperCase() !== 'POST') {
      return jsonResponse(405, { error: 'POST only' });
    }
    const isStream = req.path.endsWith('/stream');
    if (req.path !== '/v1/converse' && req.path !== '/v1/converse/stream') {
      return jsonResponse(404, { error: 'unknown path' });
    }
    if (isStream && !this.opts.stream) {
      return jsonResponse(404, { error: '/stream not configured' });
    }

    const authz = req.headers['authorization'] ?? req.headers['Authorization'];
    const token = authz?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return jsonResponse(401, { error: 'missing Bearer token' });

    let claims: RestJwtClaims;
    try {
      claims = await this.opts.jwt.verify(token);
    } catch (e) {
      return jsonResponse(401, { error: `jwt: ${(e as Error).message}` });
    }

    const body = (req.body ?? {}) as { text?: unknown; conversationId?: unknown };
    if (typeof body.text !== 'string' || body.text.trim().length === 0) {
      return jsonResponse(400, { error: 'body.text required (string)' });
    }
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : claims.sub;

    if (this.opts.rateLimit) {
      try {
        await this.opts.rateLimit.schedule({
          platform: 'rest',
          tenantId: claims.tnt,
          conversationId,
          userId: claims.sub,
          ...(req.signal !== undefined ? { signal: req.signal } : {}),
        });
      } catch (e) {
        return jsonResponse(429, { error: `rate-limited: ${(e as Error).message}` });
      }
    }

    const event: NormalizedEvent = {
      surface: this.name,
      tenantId: claims.tnt,
      conversationId,
      userId: claims.sub,
      text: body.text,
      receivedAt: Date.now(),
    };

    if (isStream) {
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
        body: this.streamSse(event, req.signal),
      };
    }

    try {
      const reply = await this.opts.handle(event, req.signal);
      const fallback = this.opts.groundedFallback;
      if (fallback !== undefined) {
        // Fail CLOSED at the wire: an uncited fact-bearing reply is refused —
        // the safe fallback is sent (with no citations), never the ungrounded text.
        const decision = groundedRenderGate(reply, { fallback });
        return jsonResponse(200, {
          reply: decision.text,
          citations: decision.grounded ? reply.citations : [],
          conversationId,
        });
      }
      return jsonResponse(200, {
        reply: reply.text,
        citations: reply.citations,
        conversationId,
      });
    } catch (e) {
      return jsonResponse(500, { error: `handler: ${(e as Error).message}` });
    }
  }

  /**
   * Check every readinessProbe in parallel. /readyz returns 200 iff
   * ALL probes report ready. Operators wire probes for: vector store,
   * Redis state store, model providers (Anthropic, Bedrock, OpenAI…).
   * On Kubernetes the result drives liveness vs readiness routing.
   */
  private async checkReadiness(): Promise<{ ready: boolean; probes: ReadonlyArray<{ name: string; ready: boolean }> }> {
    const probes = this.opts.readinessProbes ?? [];
    if (probes.length === 0) return { ready: true, probes: [] };
    const results = await Promise.all(
      probes.map(async (p) => {
        try { return { name: p.name, ready: !!(await p.ready()) }; }
        catch { return { name: p.name, ready: false }; }
      }),
    );
    return { ready: results.every((r) => r.ready), probes: results };
  }

  private async *streamSse(event: NormalizedEvent, signal?: AbortSignal): AsyncIterable<string> {
    try {
      for await (const chunk of this.opts.stream!(event, signal)) {
        if (signal?.aborted) return;
        yield `event: chunk\ndata: ${chunk.replace(/\n/g, '\ndata: ')}\n\n`;
      }
      yield 'event: done\ndata: \n\n';
    } catch (e) {
      yield `event: error\ndata: ${(e as Error).message}\n\n`;
    }
  }
}

function jsonResponse(status: number, body: unknown): RestResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Static OpenAPI 3.1 document for /v1/converse + /v1/converse/stream.
 * Apps embed or override per their needs.
 */
export const OPENAPI_SPEC: Record<string, unknown> = {
  openapi: '3.1.0',
  info: { title: 'TENET REST surface', version: '0.0.0' },
  paths: {
    '/v1/converse': {
      post: {
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['text'],
                properties: {
                  text: { type: 'string' },
                  conversationId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['reply', 'citations', 'conversationId'],
                  properties: {
                    reply: { type: 'string' },
                    conversationId: { type: 'string' },
                    citations: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['sourceId'],
                        properties: { sourceId: { type: 'string' }, quote: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'invalid body' },
          '401': { description: 'missing or bad JWT' },
          '429': { description: 'rate limited' },
          '500': { description: 'handler error' },
        },
      },
    },
    '/v1/converse/stream': {
      post: {
        security: [{ bearer: [] }],
        responses: {
          '200': {
            description: 'SSE stream of event:chunk / event:done / event:error',
            content: { 'text/event-stream': {} },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
  },
};

export const VERSION = '0.0.0';
