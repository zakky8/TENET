import { CircuitBreaker } from './circuitBreaker.js';

describe('CircuitBreaker — closed state', () => {
  it('starts closed and allows calls', () => {
    const b = new CircuitBreaker();
    expect(b.currentState()).toBe('closed');
    expect(b.allow()).toBe(true);
  });

  it('counts consecutive failures', () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    b.recordAuthFailure();
    b.recordAuthFailure();
    expect(b.failureCount()).toBe(2);
    expect(b.allow()).toBe(true);
  });

  it('a single success resets the failure streak', () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    b.recordAuthFailure();
    b.recordAuthFailure();
    b.recordSuccess();
    expect(b.failureCount()).toBe(0);
  });
});

describe('CircuitBreaker — open transition', () => {
  it('opens after threshold consecutive failures', () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) b.recordAuthFailure();
    expect(b.currentState()).toBe('open');
    expect(b.allow()).toBe(false);
  });

  it('rejects validation of non-positive threshold + cooldown', () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0 })).toThrow();
    expect(() => new CircuitBreaker({ cooldownMs: 0 })).toThrow();
  });
});

describe('CircuitBreaker — open → half_open cooldown', () => {
  it('transitions open → half_open after cooldownMs elapses', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => t });
    b.recordAuthFailure();
    b.recordAuthFailure();
    expect(b.currentState()).toBe('open');
    t += 500;
    expect(b.currentState()).toBe('open');
    t += 600;
    expect(b.currentState()).toBe('half_open');
    expect(b.allow()).toBe(true);
  });

  it('a success while half_open closes the breaker', () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100, now: () => t });
    b.recordAuthFailure();
    t += 200;
    expect(b.currentState()).toBe('half_open');
    b.recordSuccess();
    expect(b.currentState()).toBe('closed');
  });
});
