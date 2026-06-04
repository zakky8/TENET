import {
  PrincipleRegistry,
  STANDARD_PRINCIPLES,
  registerStandardPrinciples,
  composeBaseRules,
} from './index.js';

describe('STANDARD_PRINCIPLES', () => {
  it('ships 13 principles', () => {
    expect(STANDARD_PRINCIPLES).toHaveLength(13);
  });

  it('every principle id is unique', () => {
    const ids = new Set(STANDARD_PRINCIPLES.map((p) => p.id));
    expect(ids.size).toBe(STANDARD_PRINCIPLES.length);
  });

  it('every principle has version >= 1', () => {
    for (const p of STANDARD_PRINCIPLES) expect(p.version).toBeGreaterThanOrEqual(1);
  });

  it('every principle has rule + why text', () => {
    for (const p of STANDARD_PRINCIPLES) {
      expect(p.rule.length).toBeGreaterThan(0);
      expect(p.why.length).toBeGreaterThan(0);
    }
  });

  it('contains the high-leverage anti-hallucination set (truthfulness, source-grounded, knowledge-boundary)', () => {
    const ids = STANDARD_PRINCIPLES.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['P1', 'P2', 'P4']));
  });
});

describe('registerStandardPrinciples', () => {
  it('registers all standard principles on a fresh registry', () => {
    const r = new PrincipleRegistry();
    registerStandardPrinciples(r);
    expect(r.size()).toBe(STANDARD_PRINCIPLES.length);
  });

  it('composeBaseRules emits a non-empty block after registration', () => {
    const r = new PrincipleRegistry();
    registerStandardPrinciples(r);
    const out = composeBaseRules(r, 'general');
    expect(out).toContain('CONSTITUTIONAL PRINCIPLES');
    expect(out).toContain('P1.');
    expect(out).toContain('P13.');
  });

  it('apps can replace() any principle after registration', () => {
    const r = new PrincipleRegistry();
    registerStandardPrinciples(r);
    r.replace({
      id: 'P1',
      rule: 'CUSTOM TRUTHFULNESS RULE',
      why: 'app-specific override',
      version: 2,
    });
    expect(r.get('P1')!.rule).toContain('CUSTOM');
  });
});
