import { classifyError, isRetryable, type RetryClass } from './retryClass.js';

/** Build an error-like object with an arbitrary status. */
function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}
function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
function codeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

const cls = (e: unknown): RetryClass => classifyError(e).retryClass;

describe('classifyError — cancellation', () => {
  it('AbortError is FATAL — a cancelled request must stay cancelled', () => {
    expect(cls(abortError())).toBe('fatal');
    expect(classifyError(abortError()).reason).toMatch(/cancellation is intentional/);
    expect(isRetryable(abortError())).toBe(false);
  });
});

describe('classifyError — HTTP status', () => {
  it('429 and 408 are retryable (transient, with backoff)', () => {
    expect(cls(httpError(429))).toBe('retryable');
    expect(cls(httpError(408))).toBe('retryable');
  });

  it('5xx is retryable (server error)', () => {
    expect(cls(httpError(500))).toBe('retryable');
    expect(cls(httpError(503))).toBe('retryable');
    expect(cls(httpError(599))).toBe('retryable');
  });

  it('4xx (other than 408/429) is FATAL — a retry fails identically', () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(cls(httpError(s))).toBe('fatal');
    }
    // 401/403 especially: blind retry risks an egress-IP ban (CircuitBreaker).
    expect(classifyError(httpError(403)).reason).toMatch(/client error/);
  });

  it('a non-4xx/5xx status is FATAL (not a known-transient class)', () => {
    expect(cls(httpError(302))).toBe('fatal');
    expect(cls(httpError(200))).toBe('fatal');
  });
});

describe('classifyError — transient network codes', () => {
  it('known socket/DNS codes are retryable', () => {
    for (const c of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']) {
      expect(cls(codeError(c))).toBe('retryable');
    }
  });

  it('an unknown code is FATAL', () => {
    expect(cls(codeError('ESOMETHINGWEIRD'))).toBe('fatal');
  });
});

describe('classifyError — fail CLOSED on the unknown', () => {
  it('a plain Error, a string, null, and undefined are all FATAL (never blindly retried)', () => {
    expect(cls(new Error('boom'))).toBe('fatal');
    expect(cls('a string error')).toBe('fatal');
    expect(cls(null)).toBe('fatal');
    expect(cls(undefined)).toBe('fatal');
    expect(classifyError(new Error('boom')).reason).toMatch(/side-effect-safe/);
  });

  it('AbortError wins even if a retryable-looking status is also present', () => {
    // A cancelled request that also carries a 503 must NOT be retried.
    const e = Object.assign(abortError(), { status: 503 });
    expect(cls(e)).toBe('fatal');
  });
});
