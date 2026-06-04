import { STANDARD_ADVERSARIAL_EXAMPLES, examplesDecorator } from './index.js';

describe('STANDARD_ADVERSARIAL_EXAMPLES', () => {
  it('ships 12 worked examples', () => {
    const matches = STANDARD_ADVERSARIAL_EXAMPLES.match(/^Example \d+/gm) ?? [];
    expect(matches.length).toBe(12);
  });

  it('every example labels the trap class (no anonymous "wrong answer")', () => {
    const lines = STANDARD_ADVERSARIAL_EXAMPLES.split('\n').filter((l) => l.startsWith('Example'));
    for (const line of lines) {
      // 'Example N — <trap-class-name>'
      expect(line).toMatch(/—|--|–/);
    }
  });

  it('includes the high-frequency hallucination classes (URL, number, partner, authority)', () => {
    expect(STANDARD_ADVERSARIAL_EXAMPLES).toMatch(/URL/i);
    expect(STANDARD_ADVERSARIAL_EXAMPLES).toMatch(/number/i);
    expect(STANDARD_ADVERSARIAL_EXAMPLES).toMatch(/partner|entity/i);
    expect(STANDARD_ADVERSARIAL_EXAMPLES).toMatch(/authority|CEO/i);
  });

  it('every example resolves to either SUPPORTED or UNSUPPORTED verdict', () => {
    const verdicts = STANDARD_ADVERSARIAL_EXAMPLES.match(/VERDICT:.*$/gm) ?? [];
    expect(verdicts.length).toBeGreaterThanOrEqual(12);
    for (const v of verdicts) expect(v).toMatch(/SUPPORTED|UNSUPPORTED/);
  });

  it('feeds cleanly through examplesDecorator into a judge policy', () => {
    const decorated = examplesDecorator(STANDARD_ADVERSARIAL_EXAMPLES).appendToStrictPolicy(
      'STRICT BASELINE',
    );
    expect(decorated).toContain('STRICT BASELINE');
    expect(decorated).toContain('WORKED EXAMPLES');
    expect(decorated).toContain('Example 12');
  });
});
