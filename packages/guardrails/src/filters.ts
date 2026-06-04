/**
 * Composable input/output filters.
 *
 * A Filter inspects the candidate text and returns either ALLOW or
 * BLOCK with a reason. Operators compose filter chains; the first
 * BLOCK short-circuits.
 */

export type FilterVerdict =
  | { kind: 'allow' }
  | { kind: 'block'; reason: string };

export interface Filter {
  /** Stable id used in telemetry. */
  id: string;
  inspect(text: string): FilterVerdict;
}

/** Build a length-bound filter that blocks inputs outside [min, max]. */
export function lengthFilter(min: number, max: number, id = 'length'): Filter {
  if (min < 0 || max < min) {
    throw new Error(`lengthFilter: invalid bounds min=${min} max=${max}`);
  }
  return {
    id,
    inspect(text) {
      if (text.length < min) {
        return { kind: 'block', reason: `input shorter than ${min} chars` };
      }
      if (text.length > max) {
        return { kind: 'block', reason: `input longer than ${max} chars` };
      }
      return { kind: 'allow' };
    },
  };
}

/** Build a regex-denylist filter. Any match → block. */
export function denylistFilter(patterns: ReadonlyArray<RegExp>, id = 'denylist'): Filter {
  return {
    id,
    inspect(text) {
      for (const p of patterns) {
        if (p.test(text)) {
          return { kind: 'block', reason: `matched denylist pattern ${p.source}` };
        }
      }
      return { kind: 'allow' };
    },
  };
}

/**
 * Run a chain of filters in order, returning the FIRST block verdict or
 * allow if every filter allows. The filter id is included in the
 * verdict so operators can wire it to telemetry.
 */
export interface ChainResult {
  verdict: FilterVerdict;
  /** id of the filter that produced the verdict (last allow or first block). */
  filterId: string;
}

export function runFilterChain(text: string, chain: ReadonlyArray<Filter>): ChainResult {
  if (chain.length === 0) {
    return { verdict: { kind: 'allow' }, filterId: '<empty>' };
  }
  let last: Filter | undefined;
  for (const f of chain) {
    last = f;
    const v = f.inspect(text);
    if (v.kind === 'block') {
      return { verdict: v, filterId: f.id };
    }
  }
  return { verdict: { kind: 'allow' }, filterId: last!.id };
}
