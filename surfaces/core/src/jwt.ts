/**
 * Shared HS256 JWT verifier for the surface layer — the SINGLE hardened
 * implementation both the REST and web-widget surfaces re-export, so the
 * two can never drift apart again (the web-widget copy had silently lost
 * its alg + nbf checks; de-forking to one impl removes that whole class of
 * bug).
 *
 * Hardened by construction:
 *   - the header's `alg` is asserted to equal HS256 BEFORE the signature is
 *     verified, closing the alg:none and RS256→HS256 confusion classes
 *     (never trust the header's alg — a token whose HMAC over header.payload
 *     happens to match is still rejected if its alg is not HS256);
 *   - `nbf` (not-before) is enforced — a not-yet-valid token is rejected,
 *     not only an expired one;
 *   - signature comparison is length-guarded + timing-safe.
 *
 * Apps with asymmetric keys plug their own JwtVerifier.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

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
      // rejected, not just an expired one.
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
