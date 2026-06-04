import { MatrixSurface, MatrixApiError, type MatrixHttp } from './index.js';

function makeHttp(responses: Array<{ status: number; body: string }>): {
  http: MatrixHttp;
  calls: Array<{ url: string; method: string; headers: Readonly<Record<string, string>>; body?: string }>;
} {
  const calls: Array<{ url: string; method: string; headers: Readonly<Record<string, string>>; body?: string }> = [];
  let i = 0;
  return {
    http: {
      async fetch(url, init) {
        const args: { url: string; method: string; headers: Readonly<Record<string, string>>; body?: string } = {
          url, method: init.method, headers: init.headers,
        };
        if (init.body !== undefined) args.body = init.body;
        calls.push(args);
        const r = responses[Math.min(i++, responses.length - 1)]!;
        return { status: r.status, text: async () => r.body };
      },
    },
    calls,
  };
}

describe('MatrixSurface construction', () => {
  it('rejects missing baseUrl/accessToken', () => {
    const { http } = makeHttp([]);
    expect(() => new MatrixSurface(http, { baseUrl: '', accessToken: 't' })).toThrow();
    expect(() => new MatrixSurface(http, { baseUrl: 'x', accessToken: '' })).toThrow();
  });
});

describe('MatrixSurface.send', () => {
  it('PUTs to the rooms/{id}/send/m.room.message endpoint with Bearer auth', async () => {
    const { http, calls } = makeHttp([{ status: 200, body: '{"event_id":"$abc"}' }]);
    const s = new MatrixSurface(http, { baseUrl: 'https://matrix.org', accessToken: 'tok-1' });
    const id = await s.send('!room:matrix.org', 'hello');
    expect(id).toBe('$abc');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toContain('/_matrix/client/r0/rooms/!room%3Amatrix.org/send/m.room.message/');
    expect(calls[0]!.headers['authorization']).toBe('Bearer tok-1');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ msgtype: 'm.text', body: 'hello' });
  });

  it('throws MatrixApiError on non-2xx', async () => {
    const { http } = makeHttp([{ status: 403, body: 'forbidden' }]);
    const s = new MatrixSurface(http, { baseUrl: 'https://m.org', accessToken: 't' });
    await expect(s.send('!r:m.org', 'hi')).rejects.toBeInstanceOf(MatrixApiError);
  });

  it('generates unique transaction ids per send', async () => {
    const { http, calls } = makeHttp([
      { status: 200, body: '{"event_id":"$1"}' },
      { status: 200, body: '{"event_id":"$2"}' },
    ]);
    const s = new MatrixSurface(http, { baseUrl: 'https://m.org', accessToken: 't' });
    await s.send('!r:m.org', 'a');
    await s.send('!r:m.org', 'b');
    expect(calls[0]!.url).not.toBe(calls[1]!.url); // txn id differs
  });
});

describe('MatrixSurface.events', () => {
  it('yields m.room.message events from /sync', async () => {
    const sync = {
      next_batch: 's-100',
      rooms: {
        join: {
          '!room:matrix.org': {
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  event_id: '$evt-1',
                  sender: '@alice:matrix.org',
                  origin_server_ts: 1_700_000_000_000,
                  content: { msgtype: 'm.text', body: 'hello bot' },
                },
              ],
            },
          },
        },
      },
    };
    const { http } = makeHttp([
      { status: 200, body: JSON.stringify(sync) },
      { status: 200, body: '{"next_batch":"s-101","rooms":{"join":{}}}' },
    ]);
    const s = new MatrixSurface(http, { baseUrl: 'https://m.org', accessToken: 't' });
    const ctrl = new AbortController();
    const out = [];
    let i = 0;
    for await (const ev of s.events(ctrl.signal)) {
      out.push(ev);
      i++;
      if (i >= 1) ctrl.abort();
    }
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'message',
      roomId: '!room:matrix.org',
      senderId: '@alice:matrix.org',
      text: 'hello bot',
      eventId: '$evt-1',
    });
  });

  it('ignores non-m.text content + keeps text-only events', async () => {
    const sync = {
      next_batch: 's-1',
      rooms: {
        join: {
          '!r:m.org': {
            timeline: {
              events: [
                { type: 'm.room.message', event_id: '$img', sender: '@a:m.org', content: { msgtype: 'm.image', body: 'pic.jpg' } },
                { type: 'm.room.member', event_id: '$mem', sender: '@a:m.org', content: {} },
                { type: 'm.room.message', event_id: '$txt', sender: '@b:m.org', content: { msgtype: 'm.text', body: 'real msg' } },
              ],
            },
          },
        },
      },
    };
    const { http } = makeHttp([{ status: 200, body: JSON.stringify(sync) }]);
    const s = new MatrixSurface(http, { baseUrl: 'https://m.org', accessToken: 't' });
    const ctrl = new AbortController();
    const out = [];
    let i = 0;
    for await (const ev of s.events(ctrl.signal)) {
      out.push(ev);
      if (++i >= 1) ctrl.abort();
    }
    // image + member dropped, text kept
    expect(out).toHaveLength(1);
    expect(out[0]!.eventId).toBe('$txt');
  });

  it('throws MatrixApiError on non-2xx /sync response', async () => {
    const { http } = makeHttp([{ status: 401, body: 'expired' }]);
    const s = new MatrixSurface(http, { baseUrl: 'https://m.org', accessToken: 't' });
    const ctrl = new AbortController();
    const it = s.events(ctrl.signal);
    await expect(it.next()).rejects.toBeInstanceOf(MatrixApiError);
  });
});
