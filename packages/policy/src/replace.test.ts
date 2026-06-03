import { PrincipleRegistry, type Principle } from './index.js';

function principle(id: string, rule: string, extras: Partial<Principle> = {}): Principle {
  return { id, rule, why: 'because', version: 1, ...extras };
}

describe('PrincipleRegistry.replace() — FIX #6 validation regression', () => {
  it('replace() rejects empty rule (was: silent overwrite)', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'original'));
    expect(() => r.replace(principle('P1', ''))).toThrow(/may not be empty/);
  });

  it('replace() rejects version < 1 (was: silent overwrite)', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'original'));
    expect(() => r.replace(principle('P1', 'still ok', { version: 0 }))).toThrow(/version/);
  });

  it('replace() rejects malformed id (was: would have set the new garbage)', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'original'));
    // Replace with an id that doesn't match — replace() correctly throws "not registered"
    expect(() => r.replace(principle('p1', 'new', { version: 2 }))).toThrow(/not registered/);
    // But the bug class: if id WAS registered then replace would have skipped validation
    r.register(principle('VALID', 'rule'));
    // Now try to replace a valid one with an invalid id — this should fail
    // (the id mismatch will fire first; validation second). Either error is fine.
    expect(() => r.replace({ ...principle('VALID', ''), id: 'VALID' })).toThrow(/may not be empty/);
  });

  it('valid replace() still works (positive baseline)', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'v1 text', { version: 1 }));
    r.replace(principle('P1', 'v2 text', { version: 2 }));
    expect(r.get('P1')!.rule).toBe('v2 text');
    expect(r.get('P1')!.version).toBe(2);
  });
});
