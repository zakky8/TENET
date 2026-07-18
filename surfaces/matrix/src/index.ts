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

import { isRetryable } from '@tenet/rate-limit';

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
  /**
   * The bot's OWN mxid (e.g. '@bot:matrix.org'). When set, the sync loop
   * drops events sent by this id — a bot must not react to its own messages
   * (the classic reply-loop). Absent → no self-filtering.
   */
  userId?: string;
  /** Base backoff before the FIRST retry of a transient /sync failure (ms). Default 1000. */
  initialBackoffMs?: number;
  /** Backoff cap (ms), before jitter. Default 30_000. */
  maxBackoffMs?: number;
  /** Jitter fraction in [0,1] on the backoff (full jitter by default). */
  backoffJitter?: number;
  /** Injected wait (for deterministic tests). Default an abort-aware timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected randomness in [0,1) (for deterministic tests). Default Math.random. */
  random?: () => number;
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

/**
 * Scrub the kind of secret patterns Synapse / Dendrite / Conduit error
 * bodies occasionally echo back. Same posture as @tenet/models-openai
 * OpenAiApiError after the P8 review.
 */
function scrubMatrixSecrets(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [redacted]')
    .replace(/syt_[A-Za-z0-9_-]+/g, 'syt_[redacted]')              // Synapse access tokens
    .replace(/(access_token=)[^&\s"]+/gi, '$1[redacted]')
    .replace(/(authorization\s*:\s*)[^\s,"]+/gi, '$1[redacted]');
}

export class MatrixApiError extends Error {
  /** Scrubbed + bounded body — no raw access tokens, length-capped. */
  public readonly body: string;
  constructor(public readonly status: number, body: string) {
    // SECURITY 2026-06-04 vuln-test #A7: bounded + secret-scrubbed body.
    const scrubbed = scrubMatrixSecrets(body).slice(0, 200);
    super(`Matrix ${status}: ${scrubbed}`);
    this.body = scrubbed;
    this.name = 'MatrixApiError';
  }
}

/**
 * A 401 from /sync means the access token is invalid or expired. The surface
 * cannot re-authenticate itself (it only holds a token), so it STOPS the loop
 * with this distinct, actionable error — the supervisor obtains a fresh token
 * and restarts. Retrying a dead token would only burn requests. Subclasses
 * MatrixApiError so existing `instanceof MatrixApiError` handling still catches it.
 */
export class MatrixTokenExpiredError extends MatrixApiError {
  constructor(body: string) {
    super(401, body);
    this.name = 'MatrixTokenExpiredError';
  }
}

/** Abort-aware timer — rejects if the signal fires. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      resolve(); // aborted → the loop's own `while (!aborted)` guard will exit
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class MatrixSurface {
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly userAgent: string;
  private readonly userId: string | undefined;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly backoffJitter: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private syncToken: string | undefined;
  private txnCounter = 0;

  constructor(private readonly http: MatrixHttp, opts: MatrixSurfaceOptions) {
    if (!opts.baseUrl) throw new Error('MatrixSurface: baseUrl required');
    if (!opts.accessToken) throw new Error('MatrixSurface: accessToken required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.accessToken = opts.accessToken;
    this.userAgent = opts.userAgent ?? '@tenet/surface-matrix';
    this.userId = opts.userId;
    this.initialBackoffMs = opts.initialBackoffMs ?? 1000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.backoffJitter = opts.backoffJitter ?? 1;
    if (this.backoffJitter < 0 || this.backoffJitter > 1) {
      throw new Error('MatrixSurface: backoffJitter must be in [0,1]');
    }
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
  }

  /** Jittered exponential backoff before the next /sync retry. */
  private async backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const base = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** attempt);
    const delayMs = base * (1 - this.backoffJitter * this.random());
    await this.sleep(delayMs, signal);
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
    let failures = 0;
    while (!signal?.aborted) {
      const since = this.syncToken !== undefined ? `&since=${encodeURIComponent(this.syncToken)}` : '';
      const url = `${this.baseUrl}/_matrix/client/r0/sync?timeout=30000${since}`;

      let res: { status: number; text(): Promise<string> };
      try {
        res = await this.http.fetch(url, {
          method: 'GET',
          headers: this.headers(),
          ...(signal !== undefined ? { signal } : {}),
        });
      } catch {
        // A cancelled turn stops; any other fetch failure is transient (the
        // homeserver may be briefly unreachable) → back off + retry, never crash.
        if (signal?.aborted === true) return;
        await this.backoff(failures++, signal);
        continue;
      }
      const text = await res.text();

      if (res.status === 401) {
        // Token invalid/expired — the surface cannot re-auth itself → STOP.
        throw new MatrixTokenExpiredError(text);
      }
      if (res.status < 200 || res.status >= 300) {
        // Transient (429 / 408 / 5xx) → back off + retry; any other 4xx → fatal.
        if (isRetryable({ status: res.status })) {
          await this.backoff(failures++, signal);
          continue;
        }
        throw new MatrixApiError(res.status, text);
      }

      failures = 0; // a good sync resets the backoff schedule
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { continue; }
      if (!parsed || typeof parsed !== 'object') continue;
      const nextBatch = (parsed as { next_batch?: unknown }).next_batch;
      if (typeof nextBatch === 'string') this.syncToken = nextBatch;
      for (const ev of extractMessages(parsed)) {
        // A bot must NOT react to its own messages (reply-loop). Drop self.
        if (this.userId !== undefined && ev.senderId === this.userId) continue;
        yield ev;
      }
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
