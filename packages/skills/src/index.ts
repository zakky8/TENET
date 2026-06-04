/**
 * SKILL.md format loader + registry.
 *
 * The skill-packaging convention used by Claude Code skills, OpenClaw,
 * and rising as the agent-skill standard. Bundle a capability as:
 *
 *     ---
 *     name: foo
 *     description: "Short trigger-critical phrase"
 *     allowed-tools: [tool.read, tool.write]
 *     user-invocable: true
 *     license: Apache-2.0
 *     ---
 *     # Body
 *     Lazy-loaded prose / instructions / examples.
 *
 * Why this matters:
 *   1. Token-efficient — only metadata enters the agent's prompt
 *      context; body loads on trigger.
 *   2. Standard — Claude Code's skill system uses the same format;
 *      operators can share skills across agents.
 *   3. Governance-aware — the `allowed-tools` field plugs straight
 *      into @tenet/governance's PolicyEvaluator (skill author
 *      declares; tenant policy enforces).
 *
 * Pure functions; no I/O. Body loading is delegated to an injected
 * BodyLoader — operator picks fs.readFile / fetch / GitHub raw / etc.
 */

// ── Frontmatter schema ────────────────────────────────────────────────

export interface SkillFrontmatter {
  /** Required — stable id used by the registry. */
  name: string;
  /** Required — short noun-phrase that decides when the skill triggers. */
  description: string;
  /** Optional — declared tool names this skill is permitted to call. */
  allowedTools?: ReadonlyArray<string>;
  /** Optional — true if a user can invoke this skill by command. */
  userInvocable?: boolean;
  /** Optional — SPDX license id of the skill content. */
  license?: string;
  /** Optional — reference URL for the canonical version. */
  homepage?: string;
  /** Optional — additional structured metadata the operator defines. */
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface SkillRecord {
  frontmatter: SkillFrontmatter;
  /** Path / id the BodyLoader uses to fetch the body. */
  source: string;
}

/** Caller-injected body loader. Operator picks fs / fetch / cache layer. */
export interface BodyLoader {
  load(source: string, signal?: AbortSignal): Promise<string>;
}

// ── Errors ────────────────────────────────────────────────────────────

export class SkillError extends Error {
  constructor(
    public readonly code:
      | 'malformed_frontmatter'
      | 'missing_required_field'
      | 'duplicate_skill'
      | 'unknown_skill'
      | 'body_load_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

// ── Minimal YAML frontmatter parser ───────────────────────────────────

/**
 * Intentionally restricted YAML subset — what SKILL.md files use:
 *   - key: scalar (string, number, boolean)
 *   - key: ["a", "b"] flow array
 *   - key: { a: 1, b: 2 } flow object
 * No anchors, no multi-line, no block style. Operators wanting full
 * YAML wire their own parser (js-yaml) through the same shape.
 *
 * Why hand-rolled: zero deps + crystal-clear failure modes. SKILL.md
 * frontmatter is short and structured; the full YAML grammar isn't
 * needed and adds risk.
 */
export function parseFrontmatter(text: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new SkillError('malformed_frontmatter', 'missing --- delimiters');
  }
  const [, yamlBlock, body] = match;
  const raw = parseYamlScalars(yamlBlock!);
  if (typeof raw['name'] !== 'string' || raw['name'].length === 0) {
    throw new SkillError('missing_required_field', 'name (string) required');
  }
  if (typeof raw['description'] !== 'string' || raw['description'].length === 0) {
    throw new SkillError('missing_required_field', 'description (string) required');
  }
  const front: SkillFrontmatter = {
    name: raw['name'],
    description: raw['description'],
  };
  if (Array.isArray(raw['allowed-tools'])) {
    front.allowedTools = raw['allowed-tools'].filter((t): t is string => typeof t === 'string');
  }
  if (typeof raw['user-invocable'] === 'boolean') front.userInvocable = raw['user-invocable'];
  if (typeof raw['license'] === 'string') front.license = raw['license'];
  if (typeof raw['homepage'] === 'string') front.homepage = raw['homepage'];
  if (raw['metadata'] && typeof raw['metadata'] === 'object' && !Array.isArray(raw['metadata'])) {
    const meta = Object.create(null) as Record<string, string | number | boolean>;
    for (const [k, v] of Object.entries(raw['metadata'] as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(k)) continue; // proto-pollution guard
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') meta[k] = v;
    }
    front.metadata = meta;
  }
  return { frontmatter: front, body: body ?? '' };
}

// SECURITY 2026-06-04 vuln-test #A1: reject __proto__ / constructor /
// prototype keys to prevent prototype-pollution via attacker-controlled
// SKILL.md frontmatter. Also use Object.create(null) so the bag has no
// inherited Object.prototype keys at all.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseYamlScalars(block: string): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/\s*#.*$/, ''); // strip end-of-line comments
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    if (colon === -1) throw new SkillError('malformed_frontmatter', `line missing ':' — ${rawLine.slice(0, 60)}`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === '') throw new SkillError('malformed_frontmatter', `empty key — ${rawLine.slice(0, 60)}`);
    if (DANGEROUS_KEYS.has(key)) {
      throw new SkillError('malformed_frontmatter', `forbidden key: ${key}`);
    }
    out[key] = parseYamlScalar(value);
  }
  return out;
}

function parseYamlScalar(s: string): unknown {
  if (s === '') return '';
  // Booleans + null
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  // Numbers (strict — no NaN/Infinity)
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  // Quoted strings
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  // Flow array
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevelCommas(inner).map(parseYamlScalar);
  }
  // Flow object
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return {};
    const obj: Record<string, unknown> = {};
    for (const part of splitTopLevelCommas(inner)) {
      const c = part.indexOf(':');
      if (c === -1) continue;
      obj[part.slice(0, c).trim()] = parseYamlScalar(part.slice(c + 1).trim());
    }
    return obj;
  }
  // Bare string
  return s;
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (c === inString && s[i - 1] !== '\\') inString = null;
    } else if (c === '"' || c === "'") {
      inString = c;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
    } else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

// ── Registry ──────────────────────────────────────────────────────────

export class SkillRegistry {
  private readonly skills = new Map<string, SkillRecord>();
  private readonly bodyCache = new Map<string, string>();
  // CORRECTNESS 2026-06-04 vuln-test #B8: dedupe concurrent loadBody
  // calls so a slow loader isn't invoked twice for the same source.
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly loader: BodyLoader) {}

  /** Register a SkillRecord. Throws on duplicate name. */
  register(record: SkillRecord): void {
    if (this.skills.has(record.frontmatter.name)) {
      throw new SkillError('duplicate_skill', `skill ${record.frontmatter.name} already registered`);
    }
    this.skills.set(record.frontmatter.name, record);
  }

  /** Parse SKILL.md text + register in one call. */
  registerFromText(source: string, text: string): SkillFrontmatter {
    const { frontmatter, body } = parseFrontmatter(text);
    this.register({ frontmatter, source });
    // Pre-cache body so a subsequent load() is hit-cache.
    this.bodyCache.set(source, body);
    return frontmatter;
  }

  /** All registered skills (metadata only — body NOT loaded). */
  list(): ReadonlyArray<SkillFrontmatter> {
    return Array.from(this.skills.values()).map((r) => r.frontmatter);
  }

  /** Get metadata for a skill. */
  get(name: string): SkillFrontmatter | undefined {
    return this.skills.get(name)?.frontmatter;
  }

  /**
   * Lazy-load the body. Cached on first call. Used when the agent
   * has decided to trigger the skill — saves prompt-context tokens
   * by deferring until the metadata-match has fired.
   */
  async loadBody(name: string, signal?: AbortSignal): Promise<string> {
    const record = this.skills.get(name);
    if (!record) throw new SkillError('unknown_skill', `skill ${name} not registered`);
    const cached = this.bodyCache.get(record.source);
    if (cached !== undefined) return cached;
    // Dedupe in-flight loads for the same source.
    const existing = this.inFlight.get(record.source);
    if (existing) return existing;
    const promise = (async (): Promise<string> => {
      try {
        const body = await this.loader.load(record.source, signal);
        this.bodyCache.set(record.source, body);
        return body;
      } catch (e) {
        throw new SkillError('body_load_failed', `${record.source}: ${(e as Error).message}`);
      } finally {
        this.inFlight.delete(record.source);
      }
    })();
    this.inFlight.set(record.source, promise);
    return promise;
  }

  /**
   * Filter skills by predicate — e.g. only user-invocable ones for
   * a slash-command list, or by description keyword match.
   */
  filter(predicate: (f: SkillFrontmatter) => boolean): ReadonlyArray<SkillFrontmatter> {
    return this.list().filter(predicate);
  }
}

// ── Governance bridge ─────────────────────────────────────────────────

/**
 * Build a tool allow-list for @tenet/governance from a skill's
 * declared allowedTools. Apps wire this into PolicyEvaluator so a
 * skill cannot call tools it didn't declare.
 *
 * Operator pattern:
 *   const policy = new PolicyEvaluator([
 *     allowListRule(skillAllowedTools(activeSkill)),
 *     ...tenantPolicy,
 *   ]);
 */
export function skillAllowedTools(skill: SkillFrontmatter): ReadonlyArray<string> {
  return skill.allowedTools ?? [];
}

/**
 * In-memory BodyLoader for tests and operators who pre-stuff content.
 * Map<source, body>.
 */
export class InMemoryBodyLoader implements BodyLoader {
  constructor(private readonly bodies: Readonly<Record<string, string>>) {}
  async load(source: string): Promise<string> {
    const body = this.bodies[source];
    if (body === undefined) throw new Error(`source ${source} not found`);
    return body;
  }
}

export const VERSION = '0.0.0';
