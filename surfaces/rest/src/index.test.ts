import { createHmac } from 'node:crypto';
import { RestSurface, hs256RestVerifier, OPENAPI_SPEC } from './index.js';

const SECRET = 'rest-test-secret-1234567890';
const NOW = 2_000_000_000;

function b64UrlEncode(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeJwt(claims: Record<string, unknown>): string {
  const header = b64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64UrlEncode(JSON.stringify(claims));
  const sig = createHmac('sha256', SECRET)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${payload}.${sig}`;
}

async function readBody(body: string | AsyncIterable<string>): Promise<string> {
  if (typeof body === 'string') return body;
  let out = '';
  for await (const c of body) out += c;
  return out;
}

function makeSurface(extras: Partial<ConstructorParameters<typeof RestSurface>[0]> = {}): RestSurface {
  return new RestSurface({
    jwt: hs256RestVerifier(SECRET, { now: () => NOW }),
    handle: async (event) => ({
      text: `echo:${event.text}`,
      citations: [],
    }),
    ...extras,
  });
}

describe('OPENAPI_SPEC', () => {
  it('is a valid 3.1 doc with the two declared paths', () => {
    expect(OPENAPI_SPEC.openapi).toBe('3.1.0');
    const paths = OPENAPI_SPEC.paths as Record<string, unknown>;
    expect(paths['/v1/converse']).toBeDefined();
    expect(paths['/v1/converse/stream']).toBeDefined();
  });
});

describe('RestSurface — health endpoints', () => {
  it('/healthz returns 200 with status + uptime, no auth needed', async () => {
    const r = await makeSurface().handle({ method: 'GET', path: '/healthz', headers: {} });
    expect(r.status).toBe(200);
    const body = JSON.parse(await readBody(r.body));
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });

  it('/readyz returns 200 when no probes configured', async () => {
    const r = await makeSurface().handle({ method: 'GET', path: '/readyz', headers: {} });
    expect(r.status).toBe(200);
    const body = JSON.parse(await readBody(r.body));
    expect(body.ready).toBe(true);
    expect(body.probes).toEqual([]);
  });

  it('/readyz returns 200 when ALL probes pass', async () => {
    const r = await makeSurface({
      readinessProbes: [
        { name: 'redis', ready: () => true },
        { name: 'pgvector', ready: async () => true },
      ],
    }).handle({ method: 'GET', path: '/readyz', headers: {} });
    expect(r.status).toBe(200);
    const body = JSON.parse(await readBody(r.body));
    expect(body.ready).toBe(true);
    expect(body.probes).toHaveLength(2);
  });

  it('/readyz returns 503 when any probe fails', async () => {
    const r = await makeSurface({
      readinessProbes: [
        { name: 'redis', ready: () => true },
        { name: 'pgvector', ready: () => false },
      ],
    }).handle({ method: 'GET', path: '/readyz', headers: {} });
    expect(r.status).toBe(503);
    const body = JSON.parse(await readBody(r.body));
    expect(body.ready).toBe(false);
    expect(body.probes.find((p: { name: string }) => p.name === 'pgvector').ready).toBe(false);
  });

  it('/readyz treats probe throw as not-ready (no crash)', async () => {
    const r = await makeSurface({
      readinessProbes: [{ name: 'broken', ready: () => { throw new Error('boom'); } }],
    }).handle({ method: 'GET', path: '/readyz', headers: {} });
    expect(r.status).toBe(503);
  });
});

describe('RestSurface — routing', () => {
  it('rejects non-POST with 405', async () => {
    const r = await makeSurface().handle({ method: 'GET', path: '/v1/converse', headers: {} });
    expect(r.status).toBe(405);
  });

  it('returns 404 for unknown path', async () => {
    const r = await makeSurface().handle({ method: 'POST', path: '/unknown', headers: {} });
    expect(r.status).toBe(404);
  });

  it('/stream returns 404 when stream handler not configured', async () => {
    const r = await makeSurface().handle({ method: 'POST', path: '/v1/converse/stream', headers: {} });
    expect(r.status).toBe(404);
  });
});

describe('RestSurface — auth + validation', () => {
  it('401 when no Bearer token', async () => {
    const r = await makeSurface().handle({ method: 'POST', path: '/v1/converse', headers: {} });
    expect(r.status).toBe(401);
  });

  it('401 on bad JWT', async () => {
    const r = await makeSurface().handle({
      method: 'POST',
      path: '/v1/converse',
      headers: { Authorization: 'Bearer not.a.jwt' },
    });
    expect(r.status).toBe(401);
  });

  it('400 on missing body.text', async () => {
    const tok = makeJwt({ sub: 'u', tnt: 't', exp: NOW + 60 });
    const r = await makeSurface().handle({
      method: 'POST',
      path: '/v1/converse',
      headers: { Authorization: `Bearer ${tok}` },
      body: {},
    });
    expect(r.status).toBe(400);
  });
});

describe('RestSurface — happy path /v1/converse', () => {
  it('returns 200 + reply + citations', async () => {
    const tok = makeJwt({ sub: 'u-1', tnt: 't-1', exp: NOW + 60 });
    const r = await makeSurface().handle({
      method: 'POST',
      path: '/v1/converse',
      headers: { Authorization: `Bearer ${tok}` },
      body: { text: 'hi' },
    });
    expect(r.status).toBe(200);
    const parsed = JSON.parse(await readBody(r.body));
    expect(parsed.reply).toBe('echo:hi');
    expect(parsed.conversationId).toBe('u-1');
    expect(parsed.citations).toEqual([]);
  });

  it('honors body.conversationId when provided', async () => {
    const tok = makeJwt({ sub: 'u-1', tnt: 't-1', exp: NOW + 60 });
    const r = await makeSurface().handle({
      method: 'POST',
      path: '/v1/converse',
      headers: { Authorization: `Bearer ${tok}` },
      body: { text: 'hi', conversationId: 'custom-conv' },
    });
    const parsed = JSON.parse(await readBody(r.body));
    expect(parsed.conversationId).toBe('custom-conv');
  });

  it('returns 500 when handler throws', async () => {
    const s = makeSurface({
      handle: async () => {
        throw new Error('downstream broken');
      },
    });
    const tok = makeJwt({ sub: 'u', tnt: 't', exp: NOW + 60 });
    const r = await s.handle({
      method: 'POST',
      path: '/v1/converse',
      headers: { Authorization: `Bearer ${tok}` },
      body: { text: 'x' },
    });
    expect(r.status).toBe(500);
  });
});

describe('RestSurface — streaming', () => {
  it('streams chunks then a done event', async () => {
    const s = new RestSurface({
      jwt: hs256RestVerifier(SECRET, { now: () => NOW }),
      handle: async () => ({ text: 'n/a', citations: [] }),
      stream: async function* (event) {
        yield `hi `;
        yield event.text;
      },
    });
    const tok = makeJwt({ sub: 'u', tnt: 't', exp: NOW + 60 });
    const r = await s.handle({
      method: 'POST',
      path: '/v1/converse/stream',
      headers: { Authorization: `Bearer ${tok}` },
      body: { text: 'world' },
    });
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toContain('text/event-stream');
    const body = await readBody(r.body);
    expect(body).toContain('event: chunk');
    expect(body).toContain('data: hi ');
    expect(body).toContain('data: world');
    expect(body).toContain('event: done');
  });
});
