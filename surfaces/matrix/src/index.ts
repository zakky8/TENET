/**
 * Matrix protocol surface — federation-friendly, vendor-independent.
 *
 * Matrix is the open-protocol alternative to Slack/Discord — anyone
 * can run their own homeserver (Synapse, Dendrite, Conduit), and bots
 * federate across them. This adapter targets the Client-Server API
 * (r0.6+), the stable surface for bot accounts.
 *
 * Why this matters: Slack/Discord/Telegram all depend on a vendor's
 * uptime and ToS. Matrix doesn't. Customers running their own
 * homeserver (privacy-focused enterprises, government, EU sovereign
 * cloud) need a Matrix-native agent.
 *
 * No `matrix-js-sdk` hard dep — injectable fetch. We don't ship
 * end-to-end encryption (E2EE) here; operators wanting Olm/Megolm
 * key handling wire matrix-js-sdk through the same shape.
 *
 * API ref:
 *   POST /_matrix/client/r0/login
 *   GET  /_matrix/client/r0/sync
 *   PUT  /_matrix/client/r0/rooms/{roomId}/send/m.room.message/{txnId}
 */

export interface MatrixHttp {
  fetch(input: string, init: {
    method: 'GET' | 'POST' | 'PUT';
    headers: Readonly<Record<string, string>>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{ status: number; text(): Promise<string> }>;
}

export interface MatrixSurfaceOptions {
  /** Homeserver URL e.g. 'https://matrix.org' or self-hosted. */
  baseUrl: string;
  /** Access token. Obtain via /login or admin-panel application service token. */
  accessToken: string;
  /** Optional user-agent — operator-supplied for identification. */
  userAgent?: string;
}

export interface MatrixMessageEvent {
  kind: 'message';
  roomId: string;
  /** Sender mxid e.g. '@alice:matrix.org'. */
  senderId: string;
  /** Plain-text body (Matrix m.room.message.body). */
  text: string;
  /** Matrix event id — used to react / reply. */
  eventId: string;
  /** Server-stamped origin time in ms. */
  originServerTs: number;
}

export class MatrixApiError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Matrix ${status}: ${body.slice(0, 200)}`);
    this.name = 'MatrixApiError';
  }
}

export class MatrixSurface {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly userAgent: string;
  private syncToken: string | undefined;
  private txnCounter = 0;

  constructor(private readonly http: MatrixHttp, opts: MatrixSurfaceOptions) {
    if (!opts.baseUrl) throw new Error('MatrixSurface: baseUrl required');
    if (!opts.accessToken) throw new Error('MatrixSurface: accessToken required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.accessToken = opts.accessToken;
    this.userAgent = opts.userAgent ?? '@tenet/surface-matrix';
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.accessToken}`,
      'user-agent': this.userAgent,
    };
  }

  /**
   * Long-poll the /sync endpoint, yielding new message events.
   * Maintains the since-token between calls so each batch only emits
   * events not seen before. Caller breaks on AbortSignal.
   */
  async *events(signal?: AbortSignal): AsyncIterable<MatrixMessageEvent> {
    while (!signal?.aborted) {
      const since = this.syncToken !== undefined ? `&since=${encodeURIComponent(this.syncToken)}` : '';
      const url = `${this.baseUrl}/_matrix/client/r0/sync?timeout=30000${since}`;
      const res = await this.http.fetch(url, {
        method: 'GET',
        headers: this.headers(),
        ...(signal !== undefined ? { signal } : {}),
      });
      const text = await res.text();
      if (res.status < 200 || res.status >= 300) {
        throw new MatrixApiError(res.status, text);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      const nextBatch = (parsed as { next_batch?: unknown }).next_batch;
      if (typeof nextBatch === 'string') this.syncToken = nextBatch;
      yield* extractMessages(parsed);
    }
  }

  /** Send a plaintext message into a room. Returns the event id. */
  async send(roomId: string, text: string, signal?: AbortSignal): Promise<string> {
    const txnId = `tenet-${Date.now()}-${this.txnCounter++}`;
    const url = `${this.baseUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`;
    const res = await this.http.fetch(url, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ msgtype: 'm.text', body: text }),
      ...(signal !== undefined ? { signal } : {}),
    });
    const body = await res.text();
    if (res.status < 200 || res.status >= 300) throw new MatrixApiError(res.status, body);
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return ''; }
    const eventId = (parsed as { event_id?: unknown }).event_id;
    return typeof eventId === 'string' ? eventId : '';
  }
}

/** Extract m.room.message events from a /sync response. */
function extractMessages(syncBody: unknown): MatrixMessageEvent[] {
  const out: MatrixMessageEvent[] = [];
  if (!syncBody || typeof syncBody !== 'object') return out;
  const rooms = (syncBody as { rooms?: { join?: Record<string, unknown> } }).rooms;
  const join = rooms?.join;
  if (!join || typeof join !== 'object') return out;
  for (const [roomId, room] of Object.entries(join)) {
    if (!room || typeof room !== 'object') continue;
    const timeline = (room as { timeline?: { events?: unknown } }).timeline;
    const events = timeline?.events;
    if (!Array.isArray(events)) continue;
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      const type = (ev as { type?: unknown }).type;
      if (type !== 'm.room.message') continue;
      const content = (ev as { content?: { msgtype?: unknown; body?: unknown } }).content;
      if (content?.msgtype !== 'm.text' || typeof content.body !== 'string') continue;
      const sender = (ev as { sender?: unknown }).sender;
      const eventId = (ev as { event_id?: unknown }).event_id;
      const ts = (ev as { origin_server_ts?: unknown }).origin_server_ts;
      if (typeof sender !== 'string' || typeof eventId !== 'string') continue;
      out.push({
        kind: 'message',
        roomId,
        senderId: sender,
        text: content.body,
        eventId,
        originServerTs: typeof ts === 'number' ? ts : Date.now(),
      });
    }
  }
  return out;
}

export const VERSION = '0.0.0';
