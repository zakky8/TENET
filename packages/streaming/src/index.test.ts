import {
  parseSseStream,
  jsonStreamParser,
  streamToString,
  measureTtft,
  type StreamChunk,
} from './index.js';

const enc = new TextEncoder();

async function* bytesFrom(...strings: string[]): AsyncIterable<Uint8Array> {
  for (const s of strings) yield enc.encode(s);
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe('parseSseStream', () => {
  it('parses a single event with data', async () => {
    const events = await collect(parseSseStream(bytesFrom('data: hello\n\n')));
    expect(events).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('parses named event + multi-line data', async () => {
    const events = await collect(parseSseStream(bytesFrom('event: tool\ndata: line1\ndata: line2\n\n')));
    expect(events).toEqual([{ event: 'tool', data: 'line1\nline2' }]);
  });

  it('survives split chunks (event spans two reads)', async () => {
    const events = await collect(parseSseStream(bytesFrom('data: hel', 'lo\n\n')));
    expect(events).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(parseSseStream(bytesFrom('data: hi\r\n\r\n')));
    expect(events).toEqual([{ event: 'message', data: 'hi' }]);
  });

  it('ignores comment lines starting with ":"', async () => {
    const events = await collect(parseSseStream(bytesFrom(':keepalive\ndata: ok\n\n')));
    expect(events).toEqual([{ event: 'message', data: 'ok' }]);
  });

  it('parses multiple events in one stream', async () => {
    const events = await collect(parseSseStream(bytesFrom('data: a\n\ndata: b\n\ndata: c\n\n')));
    expect(events.map((e) => e.data)).toEqual(['a', 'b', 'c']);
  });

  it('attaches id when present', async () => {
    const events = await collect(parseSseStream(bytesFrom('id: 42\ndata: x\n\n')));
    expect(events[0]!.id).toBe('42');
  });

  it('flushes final event when stream ends without trailing blank line', async () => {
    const events = await collect(parseSseStream(bytesFrom('data: end')));
    expect(events).toEqual([{ event: 'message', data: 'end' }]);
  });

  it('aborts on signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(collect(parseSseStream(bytesFrom('data: x\n\n'), ctrl.signal))).rejects.toThrow();
  });
});

describe('jsonStreamParser', () => {
  it('returns null until first complete object', () => {
    const p = jsonStreamParser<{ a: number }>();
    expect(p.feed('{"a"')).toBeNull();
    expect(p.feed(':1}')).toEqual({ a: 1 });
  });

  it('returns latest valid value at each call', () => {
    const p = jsonStreamParser<{ a?: number; b?: number }>();
    p.feed('{"a":1}');
    expect(p.feed('{"a":1,"b":2}')).toEqual({ a: 1, b: 2 });
  });

  it('tolerates escaped quotes inside strings', () => {
    const p = jsonStreamParser<{ q: string }>();
    expect(p.feed('{"q":"a\\"b"}')).toEqual({ q: 'a"b' });
  });

  it('handles nested objects + arrays', () => {
    const p = jsonStreamParser<{ x: { y: number[] } }>();
    expect(p.feed('{"x":{"y":[1,2,3]}}')).toEqual({ x: { y: [1, 2, 3] } });
  });

  it('finish() throws on incomplete object', () => {
    const p = jsonStreamParser();
    p.feed('{"a":');
    expect(() => p.finish()).toThrow(/incomplete JSON/);
  });

  it('finish() returns the value when buffer is complete', () => {
    const p = jsonStreamParser<{ n: number }>();
    p.feed('{"n":42}');
    expect(p.finish()).toEqual({ n: 42 });
  });
});

describe('streamToString', () => {
  it('joins text chunks; ignores non-text', async () => {
    const chunks: StreamChunk[] = [
      { kind: 'text', text: 'Hello' },
      { kind: 'usage', inputTokens: 10, outputTokens: 5 },
      { kind: 'text', text: ', world' },
      { kind: 'message_stop', stopReason: 'end_turn' },
    ];
    async function* gen() { for (const c of chunks) yield c; }
    expect(await streamToString(gen())).toBe('Hello, world');
  });
});

describe('measureTtft', () => {
  it('measures wall-clock until first text chunk', async () => {
    const chunks: StreamChunk[] = [
      { kind: 'usage', inputTokens: 10, outputTokens: 0 },
      { kind: 'text', text: 'Hi' },
      { kind: 'text', text: ' there' },
    ];
    let t = 100;
    const now = (): number => t;
    async function* gen() {
      for (const c of chunks) {
        t += 50;
        yield c;
      }
    }
    const { ttftMs, full } = await measureTtft(gen(), now);
    // start=100, first usage at t=150 (not text), first text at t=200 → ttft=100
    expect(ttftMs).toBe(100);
    expect(full).toBe('Hi there');
  });

  it('returns total when no text chunk', async () => {
    let t = 0;
    const now = (): number => t;
    async function* gen() {
      t = 100;
      yield { kind: 'message_stop', stopReason: 'end_turn' } as StreamChunk;
    }
    const { ttftMs } = await measureTtft(gen(), now);
    expect(ttftMs).toBe(100);
  });
});
