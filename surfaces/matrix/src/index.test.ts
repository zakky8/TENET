import { MatrixSurface, MatrixApiError, MatrixTokenExpiredError, type MatrixHttp } from './index.js';

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

  it('throws MatrixTokenExpiredError (distinct, actionable) on a 401', async () => {
    const { http } = makeHttp([{ status: 401, body: 'M_UNKNOWN_TOKEN' }]);
    const s = new MatrixSurface(http, { baseUrl: 'https://m.org', accessToken: 't' });
    const it = s.events(new AbortController().signal);
    const p = it.next();
    await expect(p).rejects.toBeInstanceOf(MatrixTokenExpiredError);
    await expect(p).rejects.toBeInstanceOf(MatrixApiError); // still a MatrixApiError subclass
  });

  it('throws MatrixApiError (fatal, NOT retried) on a non-401 4xx', async () => {
    const { http, calls } = makeHttp([{ status: 400, body: 'bad request' }]);
    let slept = 0;
    const s = new MatrixSurface(http, {
      baseUrl: 'https://m.org', accessToken: 't', sleep: async () => { slept++; },
    });
    const it = s.events(new AbortController().signal);
    await expect(it.next()).rejects.toBeInstanceOf(MatrixApiError);
    expect(calls).toHaveLength(1); // one fetch, then threw — no backoff/retry
    expect(slept).toBe(0);
  });

  it('backs off on a transient 5xx and RECOVERS — the loop never crashes', async () => {
    const sync = {
      next_batch: 's-1',
      rooms: { join: { '!r:m.org': { timeline: { events: [
        { type: 'm.room.message', event_id: '$e', sender: '@a:m.org', content: { msgtype: 'm.text', body: 'hi' } },
      ] } } } },
    };
    const delays: number[] = [];
    const { http, calls } = makeHttp([
      { status: 503, body: 'overloaded' },
      { status: 200, body: JSON.stringify(sync) },
    ]);
    const s = new MatrixSurface(http, {
      baseUrl: 'https://m.org', accessToken: 't',
      sleep: async (ms) => { delays.push(ms); }, random: () => 0, initialBackoffMs: 1000,
    });
    const ctrl = new AbortController();
    const out = [];
    for await (const ev of s.events(ctrl.signal)) { out.push(ev); ctrl.abort(); }
    expect(out).toHaveLength(1);          // recovered — the message came through
    expect(out[0]!.eventId).toBe('$e');
    expect(delays).toEqual([1000]);       // backed off once (attempt 0, random=0 → full base)
    expect(calls.length).toBeGreaterThanOrEqual(2); // it retried the sync
  });

  it('drops the bot own messages (self-filter) when userId is set', async () => {
    const sync = {
      next_batch: 's-1',
      rooms: { join: { '!r:m.org': { timeline: { events: [
        { type: 'm.room.message', event_id: '$self', sender: '@bot:m.org', content: { msgtype: 'm.text', body: 'from me' } },
        { type: 'm.room.message', event_id: '$other', sender: '@alice:m.org', content: { msgtype: 'm.text', body: 'from alice' } },
      ] } } } },
    };
    const { http } = makeHttp([{ status: 200, body: JSON.stringify(sync) }]);
    const s = new MatrixSurface(http, { baseUrl: 'https://m.org', accessToken: 't', userId: '@bot:m.org' });
    const ctrl = new AbortController();
    const out = [];
    for await (const ev of s.events(ctrl.signal)) { out.push(ev); ctrl.abort(); }
    expect(out.map((e) => e.senderId)).toEqual(['@alice:m.org']); // the bot's own message is dropped
    expect(out.map((e) => e.eventId)).not.toContain('$self');
  });
});
