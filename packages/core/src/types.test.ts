import {
  Secret,
  validateFilterKey,
  TenetError,
} from './types.js';

describe('Secret<T>', () => {
  it('reveals the wrapped value via reveal()', () => {
    const s = new Secret('hunter2');
    expect(s.reveal()).toBe('hunter2');
  });

  it('returns "[Secret]" from toString — never the value', () => {
    const s = new Secret('hunter2');
    expect(`${s}`).toBe('[Secret]');
    expect(s.toString()).toBe('[Secret]');
  });

  it('throws when JSON.stringify tries to serialize it', () => {
    const s = new Secret('hunter2');
    expect(() => JSON.stringify(s)).toThrow(/cannot be serialized/);
    expect(() => JSON.stringify({ password: s })).toThrow(/cannot be serialized/);
  });

  it('throws when nested in an object that gets serialized', () => {
    const config = {
      apiKey: new Secret('sk-abc'),
      url: 'https://example.com',
    };
    expect(() => JSON.stringify(config)).toThrow(/cannot be serialized/);
  });

  it('works for non-string values', () => {
    const s = new Secret({ token: 'xyz', expiresAt: 1000 });
    expect(s.reveal().token).toBe('xyz');
    expect(() => JSON.stringify(s)).toThrow();
  });
});

describe('validateFilterKey', () => {
  it('accepts alphanumeric + underscore + dot + hyphen', () => {
    expect(() => validateFilterKey('foo')).not.toThrow();
    expect(() => validateFilterKey('foo_bar')).not.toThrow();
    expect(() => validateFilterKey('foo.bar')).not.toThrow();
    expect(() => validateFilterKey('foo-bar')).not.toThrow();
    expect(() => validateFilterKey('a1b2c3')).not.toThrow();
    expect(() => validateFilterKey('tenant_id')).not.toThrow();
  });

  it('rejects SQL-injection vectors (LangChain CVE-2025-67644 class)', () => {
    expect(() => validateFilterKey("'; DROP TABLE")).toThrow(/Invalid filter key/);
    expect(() => validateFilterKey('foo OR 1=1')).toThrow();
    expect(() => validateFilterKey('foo;DELETE')).toThrow();
    expect(() => validateFilterKey('foo--comment')).toThrow();
  });

  it('rejects whitespace, quotes, backticks', () => {
    expect(() => validateFilterKey('foo bar')).toThrow();
    expect(() => validateFilterKey('"foo"')).toThrow();
    expect(() => validateFilterKey('`foo`')).toThrow();
    expect(() => validateFilterKey("'foo'")).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateFilterKey('')).toThrow();
  });

  it('rejects path-traversal characters', () => {
    expect(() => validateFilterKey('../etc/passwd')).toThrow();
    expect(() => validateFilterKey('a/b')).toThrow();
    expect(() => validateFilterKey('a\\b')).toThrow();
  });

  it('rejects unicode and control chars', () => {
    expect(() => validateFilterKey('foo\x00bar')).toThrow();
    expect(() => validateFilterKey('foo\nbar')).toThrow();
    expect(() => validateFilterKey('foö')).toThrow();
  });

  it('truncates error message to 32 chars to avoid leaking long payloads to logs', () => {
    const longPayload = 'a'.repeat(1000) + "';";
    expect(() => validateFilterKey(longPayload)).toThrow(/Invalid filter key/);
    try {
      validateFilterKey(longPayload);
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(80);
    }
  });
});

describe('TenetError', () => {
  it('carries a stable code', () => {
    const e = new TenetError('VERIFIER_FAILED', 'claim X unsupported');
    expect(e.code).toBe('VERIFIER_FAILED');
    expect(e.message).toBe('claim X unsupported');
    expect(e.name).toBe('TenetError');
  });

  it('preserves the cause for chaining', () => {
    const root = new Error('upstream broken');
    const e = new TenetError('MODEL_FAILED', 'bedrock timeout', root);
    expect(e.cause).toBe(root);
  });

  it('is instanceof Error (for catch (e: Error) compatibility)', () => {
    const e = new TenetError('TIMEOUT', 'x');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(TenetError);
  });
});
