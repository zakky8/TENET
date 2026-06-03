import { PrincipleRegistry, composeBaseRules, fingerprint, type Principle } from './index.js';

function principle(id: string, rule: string, extras: Partial<Principle> = {}): Principle {
  return { id, rule, why: 'because', version: 1, ...extras };
}

describe('PrincipleRegistry — register()', () => {
  it('accepts a valid principle', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'TRUTHFULNESS — only state what sources contain'));
    expect(r.size()).toBe(1);
    expect(r.get('P1')!.rule).toContain('TRUTHFULNESS');
  });

  it('throws on duplicate id', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'a'));
    expect(() => r.register(principle('P1', 'b'))).toThrow(/already registered/);
  });

  it('rejects empty rule', () => {
    const r = new PrincipleRegistry();
    expect(() => r.register(principle('P1', ''))).toThrow(/may not be empty/);
  });

  it('rejects malformed id (lowercase / spaces / too long)', () => {
    const r = new PrincipleRegistry();
    expect(() => r.register(principle('p1', 'x'))).toThrow(/must be uppercase/);
    expect(() => r.register(principle('P 1', 'x'))).toThrow();
    expect(() => r.register(principle('1P', 'x'))).toThrow();
    expect(() => r.register(principle('A'.repeat(40), 'x'))).toThrow();
  });

  it('rejects version < 1', () => {
    const r = new PrincipleRegistry();
    expect(() => r.register(principle('P1', 'x', { version: 0 }))).toThrow(/version/);
  });

  it('accepts uppercase + underscore + digits in id', () => {
    const r = new PrincipleRegistry();
    expect(() => r.register(principle('OUTREACH_2', 'x'))).not.toThrow();
    expect(() => r.register(principle('P13', 'x'))).not.toThrow();
  });
});

describe('PrincipleRegistry — replace()', () => {
  it('updates an existing principle', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'original', { version: 1 }));
    r.replace(principle('P1', 'updated', { version: 2 }));
    expect(r.get('P1')!.rule).toBe('updated');
    expect(r.get('P1')!.version).toBe(2);
  });

  it('throws on non-existent id', () => {
    const r = new PrincipleRegistry();
    expect(() => r.replace(principle('P99', 'x'))).toThrow(/not registered/);
  });
});

describe('PrincipleRegistry — forIntent()', () => {
  it('returns always-on principles for any intent', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'always rule', { applies: 'always' }));
    r.register(principle('P2', 'undeclared rule')); // default = always
    expect(r.forIntent('any')).toHaveLength(2);
  });

  it('filters by intent for scoped principles', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'always rule'));
    r.register(principle('OUT', 'outreach only', { applies: { intents: ['outreach'] } }));
    r.register(principle('NODE', 'node only', { applies: { intents: ['nodes'] } }));

    const forOutreach = r.forIntent('outreach');
    expect(forOutreach.map((p) => p.id)).toEqual(['P1', 'OUT']);

    const forNodes = r.forIntent('nodes');
    expect(forNodes.map((p) => p.id)).toEqual(['P1', 'NODE']);

    const forUnknown = r.forIntent('weather');
    expect(forUnknown.map((p) => p.id)).toEqual(['P1']);
  });
});

describe('composeBaseRules', () => {
  it('returns empty string for empty registry', () => {
    const r = new PrincipleRegistry();
    expect(composeBaseRules(r, 'any')).toBe('');
  });

  it('formats principles as "id. rule" lines inside a header block', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'be truthful'));
    r.register(principle('P2', 'cite sources'));
    const out = composeBaseRules(r, 'general');
    expect(out).toContain('CONSTITUTIONAL PRINCIPLES');
    expect(out).toContain('P1. be truthful');
    expect(out).toContain('P2. cite sources');
  });

  it('preserves registration order in output', () => {
    const r = new PrincipleRegistry();
    r.register(principle('Z', 'last'));
    r.register(principle('A', 'first'));
    const out = composeBaseRules(r, 'g');
    expect(out.indexOf('Z. last')).toBeLessThan(out.indexOf('A. first'));
  });

  it('excludes principles that do not apply to the requested intent', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'always'));
    r.register(principle('OUT', 'outreach only', { applies: { intents: ['outreach'] } }));
    const out = composeBaseRules(r, 'general');
    expect(out).toContain('P1. always');
    expect(out).not.toContain('OUT.');
  });
});

describe('fingerprint', () => {
  it('produces a deterministic id:version|... string', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'a', { version: 1 }));
    r.register(principle('P2', 'b', { version: 3 }));
    expect(fingerprint(r)).toBe('P1:1|P2:3');
  });

  it('sorts ids — registration order does not affect output', () => {
    const a = new PrincipleRegistry();
    a.register(principle('Z', 'x', { version: 1 }));
    a.register(principle('A', 'x', { version: 2 }));
    const b = new PrincipleRegistry();
    b.register(principle('A', 'x', { version: 2 }));
    b.register(principle('Z', 'x', { version: 1 }));
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it('changes when a principle bumps version', () => {
    const r = new PrincipleRegistry();
    r.register(principle('P1', 'v1 text', { version: 1 }));
    const fp1 = fingerprint(r);
    r.replace(principle('P1', 'v2 text', { version: 2 }));
    const fp2 = fingerprint(r);
    expect(fp1).not.toBe(fp2);
  });

  it('is empty for empty registry', () => {
    const r = new PrincipleRegistry();
    expect(fingerprint(r)).toBe('');
  });
});
