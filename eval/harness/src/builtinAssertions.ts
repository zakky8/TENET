import type { Assertion, AssertionResult } from './types.js';

/** Output (as string) equals expected. */
export function eqAssertion(id: string, expected: string): Assertion {
  return {
    id,
    async check({ output }): Promise<AssertionResult> {
      const out = String(output);
      return out === expected
        ? { kind: 'pass' }
        : { kind: 'fail', reason: `expected ${JSON.stringify(expected)} got ${JSON.stringify(out.slice(0, 80))}` };
    },
  };
}

/** Output (as string) contains the given substring (case-sensitive). */
export function containsAssertion(id: string, needle: string): Assertion {
  return {
    id,
    async check({ output }): Promise<AssertionResult> {
      return String(output).includes(needle)
        ? { kind: 'pass' }
        : { kind: 'fail', reason: `missing substring ${JSON.stringify(needle)}` };
    },
  };
}

/** Output matches the regex. */
export function matchesAssertion(id: string, re: RegExp): Assertion {
  return {
    id,
    async check({ output }): Promise<AssertionResult> {
      return re.test(String(output))
        ? { kind: 'pass' }
        : { kind: 'fail', reason: `did not match ${re.source}` };
    },
  };
}

/** Output (as string) does NOT contain the given substring. */
export function doesNotContainAssertion(id: string, needle: string): Assertion {
  return {
    id,
    async check({ output }): Promise<AssertionResult> {
      return !String(output).includes(needle)
        ? { kind: 'pass' }
        : { kind: 'fail', reason: `forbidden substring present: ${JSON.stringify(needle)}` };
    },
  };
}

/** Run an arbitrary predicate over the output. */
export function predicateAssertion(
  id: string,
  predicate: (output: unknown) => boolean | Promise<boolean>,
  failMessage = 'predicate returned false',
): Assertion {
  return {
    id,
    async check({ output }): Promise<AssertionResult> {
      return (await predicate(output)) ? { kind: 'pass' } : { kind: 'fail', reason: failMessage };
    },
  };
}
