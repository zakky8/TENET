import {
  repairJson,
  extractBalanced,
  applyGrammarFixups,
  streamNormalizer,
  promoteToolName,
  ToolCallRepairError,
} from './index.js';

describe('repairJson — happy paths', () => {
  it('parses valid JSON unchanged', () => {
    expect(repairJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('extracts JSON from surrounding prose', () => {
    expect(repairJson('Here you go: {"a":1} thanks!')).toEqual({ a: 1 });
  });

  it('strips Markdown code fences', () => {
    expect(repairJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(repairJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('handles trailing commas', () => {
    expect(repairJson('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
    expect(repairJson('[1,2,3,]')).toEqual([1, 2, 3]);
  });

  it('strips // and /* */ comments', () => {
    expect(repairJson('{"a":1 /* inline */ , "b": 2 // tail\n}')).toEqual({ a: 1, b: 2 });
  });

  it('quotes unquoted keys', () => {
    expect(repairJson('{a:1, b:"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('converts single-quoted strings to double', () => {
    expect(repairJson("{'a':'hello'}")).toEqual({ a: 'hello' });
  });

  it('handles arrays', () => {
    expect(repairJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('returns null on unrecoverable garbage', () => {
    expect(repairJson('totally not json')).toBeNull();
  });

  it('does not break strings containing brackets or commas', () => {
    expect(repairJson('{"text": "hello, {world}"}')).toEqual({ text: 'hello, {world}' });
  });
});

describe('extractBalanced', () => {
  it('finds the first complete {}', () => {
    expect(extractBalanced('prefix {a:1} suffix {b:2}')).toBe('{a:1}');
  });

  it('finds the first complete []', () => {
    expect(extractBalanced('prefix [1,2] suffix')).toBe('[1,2]');
  });

  it('handles nested braces', () => {
    expect(extractBalanced('x{a:{b:1}}y')).toBe('{a:{b:1}}');
  });

  it('ignores brackets inside strings', () => {
    expect(extractBalanced('{"k":"v}"}')).toBe('{"k":"v}"}');
  });

  it('returns null when unbalanced', () => {
    expect(extractBalanced('{a:1')).toBeNull();
  });
});

describe('applyGrammarFixups — toggles', () => {
  it('stripCodeFences off keeps the fences', () => {
    expect(applyGrammarFixups('```json\nfoo\n```', { stripCodeFences: false })).toContain('```');
  });

  it('stripTrailingCommas off keeps the comma', () => {
    expect(applyGrammarFixups('{a:1,}', { stripTrailingCommas: false })).toContain('1,');
  });

  it('does not touch strings containing trailing-comma-like patterns', () => {
    const out = applyGrammarFixups('{"text": "1, 2, 3,"}', {});
    expect(out).toContain('1, 2, 3,');
  });
});

describe('streamNormalizer', () => {
  it('returns null until first parseable shape', () => {
    const n = streamNormalizer();
    expect(n.feed('{"a"')).toBeNull();
    expect(n.feed(':1}')).toEqual({ a: 1 });
  });

  it('returns latest valid as the model streams a growing object', () => {
    // Model emits the JSON in chunks (the realistic streaming case):
    //   chunk 1: '{"a":1'        — not balanced yet, lastValid stays null
    //   chunk 2: ',"b":2}'       — buffer balances, returns {a:1,b:2}
    const n = streamNormalizer();
    expect(n.feed('{"a":1')).toBeNull();
    expect(n.feed(',"b":2}')).toEqual({ a: 1, b: 2 });
  });

  it('handles prose-then-object (extracts the JSON span)', () => {
    const n = streamNormalizer();
    expect(n.feed('Here is the tool call: ')).toBeNull();
    expect(n.feed('{"a":1}')).toEqual({ a: 1 });
  });

  it('finish() returns the parsed value', () => {
    const n = streamNormalizer();
    n.feed('{"a":1}');
    expect(n.finish()).toEqual({ a: 1 });
  });

  it('finish() throws on unrecoverable', () => {
    const n = streamNormalizer();
    n.feed('garbage');
    expect(() => n.finish()).toThrow(ToolCallRepairError);
  });

  it('buffer() returns accumulated input for debugging', () => {
    const n = streamNormalizer();
    n.feed('part1');
    n.feed('part2');
    expect(n.buffer()).toBe('part1part2');
  });
});

describe('promoteToolName', () => {
  const REG = ['createIssue', 'sendMessage', 'lookup_user', 'http.get'];

  it('exact match passes through', () => {
    expect(promoteToolName('sendMessage', REG)).toBe('sendMessage');
  });

  it('case/separator drift resolves', () => {
    expect(promoteToolName('send-message', REG)).toBe('sendMessage');
    expect(promoteToolName('send_message', REG)).toBe('sendMessage');
    expect(promoteToolName('SendMessage', REG)).toBe('sendMessage');
  });

  it('one-edit typo within tolerance resolves', () => {
    expect(promoteToolName('createIsue', REG)).toBe('createIssue'); // missing 's'
  });

  it('far-off names return null', () => {
    expect(promoteToolName('totally_unrelated', REG)).toBeNull();
  });

  it('respects custom maxDistance', () => {
    // 'lookupuser' vs 'lookupuser' (normalized) → 0
    expect(promoteToolName('LookupUser', REG)).toBe('lookup_user');
    expect(promoteToolName('xyz', REG, { maxDistance: 0 })).toBeNull();
  });
});
