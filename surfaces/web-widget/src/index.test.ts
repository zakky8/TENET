import { createHmac } from 'node:crypto';
import {
  WebWidgetSurface,
  hs256Verifier,
  formatSse,
  JwtError,
  type WebWidgetRequest,
} from './index.js';

const SECRET = 'this-is-a-test-secret-1234';

function b64UrlEncode(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeJwt(claims: Record<string, unknown>, secret: string = SECRET): string {
  const header = b64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64UrlEncode(JSON.stringify(claims));
  const sig = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${payload}.${sig}`;
}

// Like makeJwt but with an attacker-chosen header — the signature is still a
// VALID HMAC over header.payload, so only an explicit alg check can reject it.
function makeJwtWithHeader(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  secret: string = SECRET,
): string {
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

async function consumeBody(it: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const c of it) out += c;
  return out;
}

const NOW_S = 2_000_000_000; // ~2033

describe('formatSse', () => {
  it('encodes event + data per spec', () => {
    expect(formatSse('chunk', 'hello')).toBe('event: chunk\ndata: hello\n\n');
  });
  it('splits multi-line data into multiple data: lines', () => {
    expect(formatSse('e', 'a\nb')).toBe('event: e\ndata: a\ndata: b\n\n');
  });
});

describe('hs256Verifier', () => {
  it('rejects short secret', () => {
    expect(() => hs256Verifier('short')).toThrow();
  });

  it('accepts a valid token', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW_S });
    const tok = makeJwt({ sub: 'u', tnt: 't', exp: NOW_S + 60 });
    const claims = await v.verify(tok);
    expect(claims.sub).toBe('u');
    expect(claims.tnt).toBe('t');
  });

  it('rejects malformed token (parts != 3)', async () => {
    const v = hs256Verifier(SECRET);
    await expect(v.verify('a.b')).rejects.toBeInstanceOf(JwtError);
  });

  it('rejects bad signature', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW_S });
    const tok = makeJwt({ sub: 'u', tnt: 't', exp: NOW_S + 60 }, 'different-secret-12345');
    await expect(v.verify(tok)).rejects.toThrow(/signature/);
  });

  it('rejects expired token', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW_S });
    const tok = makeJwt({ sub: 'u', tnt: 't', exp: NOW_S - 1 });
    await expect(v.verify(tok)).rejects.toThrow(/expired/);
  });

  it('rejects payload missing required claims', async () => {
    const v = hs256Verifier(SECRET);
    const tok = makeJwt({ sub: 'u' }); // missing tnt + exp
    await expect(v.verify(tok)).rejects.toThrow(/sub\/tnt\/exp/);
  });

  // SECURITY (alg-confusion): the header's alg is attacker-controlled. Even a
  // token whose HMAC signature is VALID must be rejected if its alg is not
  // HS256 — exactly the case a signature-only check would wave through.
  it('rejects alg:none even when the HMAC signature is valid', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW_S });
    const tok = makeJwtWithHeader({ alg: 'none', typ: 'JWT' }, { sub: 'u', tnt: 't', exp: NOW_S + 60 });
    await expect(v.verify(tok)).rejects.toThrow(/alg must be HS256/);
  });

  it('rejects alg:RS256 even when the HMAC signature is valid', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW_S });
    const tok = makeJwtWithHeader({ alg: 'RS256', typ: 'JWT' }, { sub: 'u', tnt: 't', exp: NOW_S + 60 });
    await expect(v.verify(tok)).rejects.toThrow(/alg must be HS256/);
  });

  it('rejects a token whose nbf is in the future (not yet valid)', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW_S });
    const tok = makeJwt({ sub: 'u', tnt: 't', exp: NOW_S + 60, nbf: NOW_S + 30 });
    await expect(v.verify(tok)).rejects.toThrow(/not yet valid/);
  });

  it('accepts a token whose nbf is already past', async () => {
    const v = hs256Verifier(SECRET, { now: () => NOW_S });
    const tok = makeJwt({ sub: 'u', tnt: 't', exp: NOW_S + 60, nbf: NOW_S - 30 });
    const claims = await v.verify(tok);
    expect(claims.sub).toBe('u');
  });
});

describe('WebWidgetSurface — request handling', () => {
  const validTok = () => makeJwt({ sub: 'u', tnt: 't', exp: NOW_S + 60 });
  function makeSurface(extras: Partial<ConstructorParameters<typeof WebWidgetSurface>[0]> = {}): WebWidgetSurface {
    return new WebWidgetSurface({
      jwt: hs256Verifier(SECRET, { now: () => NOW_S }),
      allowedOrigins: ['https://app.example.com'],
      stream: async function* (event) {
        yield `echo:${event.text}`;
      },
      ...extras,
    });
  }

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const s = makeSurface();
    const r = await s.handle({
      method: 'OPTIONS',
      headers: { Origin: 'https://app.example.com' },
    });
    expect(r.status).toBe(204);
    expect(r.headers['Access-Control-Allow-Methods']).toContain('POST');
  });

  it('non-POST returns 405', async () => {
    const s = makeSurface();
    const r = await s.handle({
      method: 'GET',
      headers: { Origin: 'https://app.example.com' },
    });
    expect(r.status).toBe(405);
  });

  it('rejects requests from a disallowed origin (403)', async () => {
    const s = makeSurface();
    const r = await s.handle({
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: { text: 'hi' },
    });
    expect(r.status).toBe(403);
  });

  it('rejects missing Bearer token (401)', async () => {
    const s = makeSurface();
    const r = await s.handle({
      method: 'POST',
      headers: { Origin: 'https://app.example.com' },
      body: { text: 'hi' },
    });
    expect(r.status).toBe(401);
  });

  it('rejects invalid JWT (401)', async () => {
    const s = makeSurface();
    const r = await s.handle({
      method: 'POST',
      headers: {
        Origin: 'https://app.example.com',
        Authorization: 'Bearer not.a.jwt',
      },
      body: { text: 'hi' },
    });
    expect(r.status).toBe(401);
  });

  it('rejects empty text (400)', async () => {
    const s = makeSurface();
    const r = await s.handle({
      method: 'POST',
      headers: { Origin: 'https://app.example.com', Authorization: `Bearer ${validTok()}` },
      body: { text: '   ' },
    });
    expect(r.status).toBe(400);
  });

  it('happy path: 200 + SSE stream containing chunks', async () => {
    const s = makeSurface();
    const r = await s.handle({
      method: 'POST',
      headers: { Origin: 'https://app.example.com', Authorization: `Bearer ${validTok()}` },
      body: { text: 'world' },
    });
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toContain('text/event-stream');
    const body = await consumeBody(r.body);
    expect(body).toContain('event: chunk');
    expect(body).toContain('data: echo:world');
    expect(body).toContain('event: done');
  });

  it('emits event: error when stream throws', async () => {
    const s = makeSurface({
      stream: async function* () {
        throw new Error('downstream broken');
      },
    });
    const r = await s.handle({
      method: 'POST',
      headers: { Origin: 'https://app.example.com', Authorization: `Bearer ${validTok()}` },
      body: { text: 'x' },
    });
    const body = await consumeBody(r.body);
    expect(body).toContain('event: error');
    expect(body).toContain('downstream broken');
  });

  it('* in allowedOrigins allows any origin', async () => {
    const s = makeSurface({ allowedOrigins: ['*'] });
    const r = await s.handle({
      method: 'POST',
      headers: { Origin: 'https://other.example', Authorization: `Bearer ${validTok()}` },
      body: { text: 'hi' },
    });
    expect(r.status).toBe(200);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('*');
  });
});
