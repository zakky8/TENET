import { lengthFilter, denylistFilter, runFilterChain } from './filters.js';

describe('lengthFilter', () => {
  it('allows in-range text', () => {
    const f = lengthFilter(3, 10);
    expect(f.inspect('hello').kind).toBe('allow');
  });

  it('blocks too-short', () => {
    const f = lengthFilter(5, 100);
    const v = f.inspect('hi');
    expect(v.kind).toBe('block');
  });

  it('blocks too-long', () => {
    const f = lengthFilter(0, 5);
    const v = f.inspect('exceeds bounds');
    expect(v.kind).toBe('block');
  });

  it('rejects invalid bounds', () => {
    expect(() => lengthFilter(-1, 10)).toThrow();
    expect(() => lengthFilter(10, 5)).toThrow();
  });
});

describe('denylistFilter', () => {
  it('allows clean text', () => {
    const f = denylistFilter([/badword/i]);
    expect(f.inspect('this is fine').kind).toBe('allow');
  });

  it('blocks on any pattern match', () => {
    const f = denylistFilter([/foo/, /bar/]);
    expect(f.inspect('xx bar yy').kind).toBe('block');
  });

  it('case-insensitive when the pattern is /i', () => {
    const f = denylistFilter([/banned/i]);
    expect(f.inspect('Banned content').kind).toBe('block');
  });
});

describe('runFilterChain', () => {
  it('returns allow when every filter allows', () => {
    const r = runFilterChain('hello', [
      lengthFilter(3, 100),
      denylistFilter([/<script>/]),
    ]);
    expect(r.verdict.kind).toBe('allow');
  });

  it('returns the FIRST block', () => {
    const r = runFilterChain('hi', [
      lengthFilter(5, 100, 'len5'),
      denylistFilter([/everything/], 'dl'),
    ]);
    expect(r.verdict.kind).toBe('block');
    expect(r.filterId).toBe('len5');
  });

  it('reports the filter id in the chain result', () => {
    const r = runFilterChain('foo', [
      lengthFilter(0, 100, 'L'),
      denylistFilter([/foo/], 'D'),
    ]);
    expect(r.filterId).toBe('D');
  });

  it('empty chain → allow', () => {
    expect(runFilterChain('x', []).verdict.kind).toBe('allow');
  });
});
