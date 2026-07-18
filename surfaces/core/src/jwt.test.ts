import { createHmac } from 'node:crypto';
import { hs256Verifier, JwtError } from './jwt.js';

const SECRET = 'surface-core-test-secret-1234';
const NOW = 2_000_000_000; // ~2033

function b64UrlEncode(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sign(header: Record<string, unknown>, claims: Record<string, unknown>, secret = SECRET): string {
  const h = b64UrlEncode(JSON.stringify(header));
  const p = b64UrlEncode(JSON.stringify(claims));
  const sig = createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${h}.${p}.${sig}`;
}

const makeJwt = (claims: Record<string, unknown>, secret = SECRET): string =>
  sign({ alg: 'HS256', typ: 'JWT' }, claims, secret);

describe('hs256Verifier (shared)', () => {
  it('rejects a short secret at construction', () => {
    expect(() => hs256Verifier('short')).toThrow();
  });

  it('accepts a valid token and returns its claims', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW });
    const claims = await v.verify(makeJwt({ sub: 'u', tnt: 't', exp: NOW + 60 }));
    expect(claims.sub).toBe('u');
    expect(claims.tnt).toBe('t');
  });

  it('rejects a malformed token (parts != 3) with a JwtError', async () => {
    await expect(hs256Verifier(SECRET).verify('a.b')).rejects.toBeInstanceOf(JwtError);
  });

  it('rejects a bad signature', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW });
    await expect(v.verify(makeJwt({ sub: 'u', tnt: 't', exp: NOW + 60 }, 'a-different-secret-123'))).rejects.toThrow(/signature/);
  });

  it('rejects an expired token', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW });
    await expect(v.verify(makeJwt({ sub: 'u', tnt: 't', exp: NOW - 1 }))).rejects.toThrow(/expired/);
  });

  it('rejects a payload missing required claims', async () => {
    await expect(hs256Verifier(SECRET).verify(makeJwt({ sub: 'u' }))).rejects.toThrow(/sub\/tnt\/exp/);
  });

  // SECURITY: the header alg is attacker-controlled — a VALID HMAC over a
  // non-HS256 header must still be rejected (a sig-only check would accept it).
  it('rejects alg:none even when the HMAC signature is valid', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW });
    const tok = sign({ alg: 'none', typ: 'JWT' }, { sub: 'u', tnt: 't', exp: NOW + 60 });
    await expect(v.verify(tok)).rejects.toThrow(/alg must be HS256/);
  });

  it('rejects alg:RS256 even when the HMAC signature is valid', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW });
    const tok = sign({ alg: 'RS256', typ: 'JWT' }, { sub: 'u', tnt: 't', exp: NOW + 60 });
    await expect(v.verify(tok)).rejects.toThrow(/alg must be HS256/);
  });

  it('rejects a token whose nbf is in the future (not yet valid)', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW });
    await expect(v.verify(makeJwt({ sub: 'u', tnt: 't', exp: NOW + 60, nbf: NOW + 30 }))).rejects.toThrow(/not yet valid/);
  });

  it('accepts a token whose nbf is already past', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW });
    const claims = await v.verify(makeJwt({ sub: 'u', tnt: 't', exp: NOW + 60, nbf: NOW - 30 }));
    expect(claims.sub).toBe('u');
  });
});
