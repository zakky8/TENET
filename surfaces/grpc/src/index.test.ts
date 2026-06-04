import {
  GrpcSurface,
  PROTO_SOURCE,
  type ConverseRequest,
} from './index.js';

function makeSurface(extras: Partial<ConstructorParameters<typeof GrpcSurface>[0]> = {}): GrpcSurface {
  return new GrpcSurface({
    authenticate: async () => ({ sub: 'u-1', tnt: 't-1' }),
    handle: async (event) => ({ text: `echo:${event.text}`, citations: [] }),
    ...extras,
  });
}

describe('PROTO_SOURCE', () => {
  it('declares the TenetAgent service + both RPCs', () => {
    expect(PROTO_SOURCE).toContain('service TenetAgent');
    expect(PROTO_SOURCE).toContain('rpc Converse(');
    expect(PROTO_SOURCE).toContain('rpc ConverseStream(');
  });
});

describe('GrpcSurface — construction', () => {
  it('requires handle + authenticate', () => {
    expect(() => new GrpcSurface({ authenticate: async () => ({ sub: 'x', tnt: 'y' }) } as any)).toThrow();
    expect(() => new GrpcSurface({ handle: async () => ({ text: 'x', citations: [] }) } as any)).toThrow();
  });
});

const REQ: ConverseRequest = { sub: '', tnt: '', conversationId: '', text: 'hi' };

describe('GrpcSurface.converse', () => {
  it('happy path: authenticates, runs handler, returns reply + citations', async () => {
    const s = makeSurface();
    const out = await s.converse(REQ, {});
    expect(out.reply).toBe('echo:hi');
    expect(out.conversationId).toBe('u-1'); // defaulted to sub
  });

  it('rejects when authenticate-result sub mismatches non-empty req.sub', async () => {
    const s = makeSurface();
    await expect(
      s.converse({ ...REQ, sub: 'someone-else' }, {}),
    ).rejects.toThrow(/does not match/);
  });

  it('rejects when authenticate-result tnt mismatches non-empty req.tnt', async () => {
    const s = makeSurface();
    await expect(
      s.converse({ ...REQ, tnt: 'wrong-tenant' }, {}),
    ).rejects.toThrow(/does not match/);
  });

  it('throws on empty text', async () => {
    const s = makeSurface();
    await expect(s.converse({ ...REQ, text: '   ' }, {})).rejects.toThrow();
  });

  it('honors non-empty conversationId', async () => {
    const s = makeSurface();
    const out = await s.converse({ ...REQ, conversationId: 'custom-c' }, {});
    expect(out.conversationId).toBe('custom-c');
  });
});

describe('GrpcSurface.converseStream', () => {
  it('streams chunks then a done sentinel', async () => {
    const s = makeSurface({
      stream: async function* (event) {
        yield `hi `;
        yield event.text;
      },
    });
    const chunks = [];
    for await (const c of s.converseStream(REQ, {})) chunks.push(c);
    expect(chunks).toEqual([
      { kind: 'chunk', text: 'hi ' },
      { kind: 'chunk', text: 'hi' },
      { kind: 'done' },
    ]);
  });

  it('yields error sentinel when not configured', async () => {
    const s = makeSurface();
    const chunks = [];
    for await (const c of s.converseStream(REQ, {})) chunks.push(c);
    expect(chunks[0]).toEqual({ kind: 'error', message: 'streaming not configured' });
  });

  it('yields error sentinel when authenticate throws', async () => {
    const s = makeSurface({
      authenticate: async () => {
        throw new Error('bad creds');
      },
      stream: async function* () {
        yield 'x';
      },
    });
    const chunks = [];
    for await (const c of s.converseStream(REQ, {})) chunks.push(c);
    expect(chunks[0]).toEqual({ kind: 'error', message: 'bad creds' });
  });

  it('yields error sentinel on text empty', async () => {
    const s = makeSurface({
      stream: async function* () {
        yield 'should not happen';
      },
    });
    const chunks = [];
    for await (const c of s.converseStream({ ...REQ, text: '' }, {})) chunks.push(c);
    expect(chunks[0]).toEqual({ kind: 'error', message: 'text required' });
  });

  it('yields error sentinel when stream throws', async () => {
    const s = makeSurface({
      stream: async function* () {
        throw new Error('downstream broken');
      },
    });
    const chunks = [];
    for await (const c of s.converseStream(REQ, {})) chunks.push(c);
    expect(chunks[chunks.length - 1]).toEqual({ kind: 'error', message: 'downstream broken' });
  });
});
