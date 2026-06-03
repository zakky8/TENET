/**
 * TENET policy — generic Constitutional Principles framework.
 *
 * The framework provides the registry + composer. Applications register
 * their own principles (e.g. the Astarter app keeps P1-P13 from TENET v1).
 * Principles are versioned so the framework can detect drift between
 * registered set and tested set.
 *
 * See @tenet/core for AgentState. Verifier in @tenet/verifier consumes
 * the composed principles as part of its prompt.
 */

export interface Principle {
  /** Unique short id, e.g. "P1", "OUTREACH". */
  id: string;
  /** Imperative one-line directive (becomes the prompt line). */
  rule: string;
  /** Reason for the rule — never sent to the model, used for docs/audit. */
  why: string;
  /** When this rule fires (always | on-intent | on-condition). */
  applies?: 'always' | { intents: ReadonlyArray<string> };
  /** Bumped when the rule text changes — eval suite watches this. */
  version: number;
}

export class PrincipleRegistry {
  private readonly principles = new Map<string, Principle>();

  /** Register a principle. Throws if id already exists. */
  register(p: Principle): void {
    if (this.principles.has(p.id)) {
      throw new Error(`Principle ${p.id} already registered — use replace() to override`);
    }
    if (!/^[A-Z][A-Z0-9_]{0,30}$/.test(p.id)) {
      throw new Error(`Principle id must be uppercase alphanumeric+_, got ${JSON.stringify(p.id)}`);
    }
    if (!p.rule || p.rule.length === 0) {
      throw new Error(`Principle ${p.id}: rule may not be empty`);
    }
    if (p.version < 1) {
      throw new Error(`Principle ${p.id}: version must be >= 1`);
    }
    this.principles.set(p.id, p);
  }

  /** Replace an existing principle. Throws if id doesn't exist. */
  replace(p: Principle): void {
    if (!this.principles.has(p.id)) {
      throw new Error(`Principle ${p.id} not registered — use register()`);
    }
    this.principles.set(p.id, p);
  }

  /** Get a principle by id, or undefined. */
  get(id: string): Principle | undefined {
    return this.principles.get(id);
  }

  /** All registered principles, in registration order. */
  list(): ReadonlyArray<Principle> {
    return Array.from(this.principles.values());
  }

  /** Principles that apply to a given intent (always-on + intent-matched). */
  forIntent(intent: string): ReadonlyArray<Principle> {
    return this.list().filter((p) => {
      if (!p.applies || p.applies === 'always') return true;
      return p.applies.intents.includes(intent);
    });
  }

  /** Number of registered principles. */
  size(): number {
    return this.principles.size;
  }
}

/** Compose principles into a prompt block. */
export function composeBaseRules(
  registry: PrincipleRegistry,
  intent: string,
): string {
  const applicable = registry.forIntent(intent);
  if (applicable.length === 0) return '';
  const lines = applicable.map((p) => `${p.id}. ${p.rule}`);
  return `═══ CONSTITUTIONAL PRINCIPLES ═══\n${lines.join('\n')}\n═════════════════════════════════`;
}

/**
 * Compute a registry fingerprint — concatenated id:version pairs, sorted.
 * Eval suite compares this to a checked-in baseline; any drift fails CI.
 */
export function fingerprint(registry: PrincipleRegistry): string {
  return registry
    .list()
    .map((p) => `${p.id}:${p.version}`)
    .sort()
    .join('|');
}

export const VERSION = '0.0.0';
