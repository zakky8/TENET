/**
 * Tool-call repair — recover from LLM output drift without throwing.
 *
 * Models drift. They emit:
 *   - JSON with trailing commas
 *   - Unquoted keys
 *   - Single-quoted strings
 *   - Truncated JSON at maxTokens
 *   - JSON embedded in prose ("Here's the tool call: { ... }")
 *   - Markdown code-fenced JSON (```json { ... } ```)
 *   - JSON with comments
 *   - Tool name typos vs declared registry
 *
 * Production reliability fix: repair before failing. Operators wire
 * the repair pipeline behind their MCP tool-runner — bad JSON becomes
 * good JSON instead of a 500 to the user.
 *
 * Pattern borrowed from OpenClaw audit (tool-call-repair package).
 *
 * No deps. Pure functions. Composable.
 */

// ── Grammar fixups ────────────────────────────────────────────────────

/**
 * Best-effort JSON repair — applies common LLM-drift fixups in order
 * and returns the first parse that succeeds. Returns null if every
 * attempt fails (caller falls back to a typed error).
 */
export function repairJson(input: string): unknown | null {
  // 1. Already valid?
  const direct = tryParse(input);
  if (direct !== undefined) return direct;

  // 2. Extract a balanced { ... } / [ ... ] substring (strip prose).
  const extracted = extractBalanced(input);
  if (extracted) {
    const v = tryParse(extracted);
    if (v !== undefined) return v;
    // 3. Apply grammar fixups to the extracted region.
    const fixed = applyGrammarFixups(extracted);
    const v2 = tryParse(fixed);
    if (v2 !== undefined) return v2;
  }

  // 4. Apply grammar fixups to the raw input.
  const fixed = applyGrammarFixups(input);
  const v3 = tryParse(fixed);
  if (v3 !== undefined) return v3;

  return null;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Extract the first balanced { } or [ ] block from a string. Survives
 * strings (with escapes) and ignores brackets inside them.
 */
export function extractBalanced(input: string): string | null {
  for (const open of ['{', '[']) {
    const start = input.indexOf(open);
    if (start === -1) continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < input.length; i++) {
      const c = input[i]!;
      if (escape) { escape = false; continue; }
      if (inString) {
        if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return input.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Apply known-safe drift fixes: strip code fences, strip line +
 * block comments, replace single-quoted strings with double-quoted
 * (when safe), unquote-trip trailing commas.
 *
 * Each fix is reversible — caller can pass a config to disable any
 * individual rule if it conflicts with their dataset.
 */
export interface GrammarFixupConfig {
  stripCodeFences?: boolean;
  stripComments?: boolean;
  stripTrailingCommas?: boolean;
  quoteUnquotedKeys?: boolean;
  singleToDoubleQuotes?: boolean;
}

const DEFAULT_CONFIG: Required<GrammarFixupConfig> = {
  stripCodeFences: true,
  stripComments: true,
  stripTrailingCommas: true,
  quoteUnquotedKeys: true,
  singleToDoubleQuotes: true,
};

export function applyGrammarFixups(input: string, config: GrammarFixupConfig = {}): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let s = input;
  if (cfg.stripCodeFences) s = stripCodeFences(s);
  if (cfg.stripComments) s = stripComments(s);
  if (cfg.singleToDoubleQuotes) s = singleToDoubleQuotes(s);
  if (cfg.quoteUnquotedKeys) s = quoteUnquotedKeys(s);
  if (cfg.stripTrailingCommas) s = stripTrailingCommas(s);
  return s.trim();
}

function stripCodeFences(s: string): string {
  // ```json\n...\n``` → ...
  return s.replace(/^\s*```(?:json|JSON)?\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
}

function stripComments(s: string): string {
  // // line comments + /* block comments */ — only outside strings.
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (escape) { escape = false; out += c; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      out += c;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    out += c;
  }
  return out;
}

function stripTrailingCommas(s: string): string {
  // Drop commas immediately before } or ] (outside strings).
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (escape) { escape = false; out += c; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      out += c;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === ',') {
      // Look ahead past whitespace for } or ].
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j]!)) j++;
      if (s[j] === '}' || s[j] === ']') continue; // skip the comma
    }
    out += c;
  }
  return out;
}

function quoteUnquotedKeys(s: string): string {
  // Insert double quotes around identifier-shaped keys followed by ':'.
  // Restricted to keys directly after { or , and only when the identifier
  // is letter-leading + alnum/_$. Avoids matching string content.
  let out = '';
  let inString = false;
  let escape = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (escape) { escape = false; out += c; i++; continue; }
    if (inString) {
      if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    if (c === '{' || c === ',') {
      // Find the next non-whitespace.
      out += c;
      i++;
      while (i < s.length && /\s/.test(s[i]!)) { out += s[i]; i++; }
      // Identifier-leading?
      const id = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(s.slice(i));
      if (id) {
        const len = id[1]!.length;
        out += '"' + s.slice(i, i + len) + '"';
        i += len;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function singleToDoubleQuotes(s: string): string {
  // Replace single-quoted strings with double-quoted; escape any
  // pre-existing double quotes inside. Only outside double-quoted strings.
  let out = '';
  let inDouble = false;
  let escape = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (escape) { escape = false; out += c; i++; continue; }
    if (inDouble) {
      if (c === '\\') escape = true;
      else if (c === '"') inDouble = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"') { inDouble = true; out += c; i++; continue; }
    if (c === "'") {
      // Find the closing single quote.
      let j = i + 1;
      let inner = '';
      while (j < s.length) {
        const cc = s[j]!;
        if (cc === '\\' && s[j + 1] !== undefined) {
          inner += cc + s[j + 1];
          j += 2;
          continue;
        }
        if (cc === "'") break;
        inner += cc;
        j++;
      }
      if (j < s.length) {
        // Escape unescaped double quotes inside the inner.
        const escaped = inner.replace(/\\?"/g, (m) => (m === '\\"' ? '\\"' : '\\"'));
        out += '"' + escaped + '"';
        i = j + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

// ── Stream normalizer — accumulate partial tool-call JSON ─────────────

export interface StreamNormalizer {
  /** Feed a streaming chunk; returns the latest *parseable* value or null. */
  feed(chunk: string): unknown | null;
  /** Final commit; throws on irrecoverable. */
  finish(): unknown;
  /** Inspect accumulated buffer (for debugging). */
  buffer(): string;
}

/**
 * Accumulates streaming tool-call JSON and attempts repair-on-feed.
 * As soon as a balanced + parseable JSON object is in the buffer,
 * `feed` returns the parsed value. Subsequent feeds keep extending
 * until `finish()`.
 */
export function streamNormalizer(): StreamNormalizer {
  let buf = '';
  let lastValid: unknown | null = null;
  return {
    feed(chunk: string): unknown | null {
      buf += chunk;
      const v = repairJson(buf);
      if (v !== null) lastValid = v;
      return lastValid;
    },
    finish(): unknown {
      const v = repairJson(buf);
      if (v !== null) return v;
      if (lastValid !== null) return lastValid;
      throw new ToolCallRepairError('unrecoverable', `cannot parse: ${buf.slice(0, 200)}`);
    },
    buffer(): string { return buf; },
  };
}

// ── Tool-name resolution — fuzz match against the declared registry ───

/**
 * Models occasionally typo a tool name ("send_message" vs "sendMessage",
 * "create-issue" vs "createIssue"). promoteToolName picks the closest
 * registered tool by Levenshtein-bounded normalization. Returns null
 * if no match within tolerance.
 */
export function promoteToolName(
  emitted: string,
  registered: ReadonlyArray<string>,
  opts: { maxDistance?: number } = {},
): string | null {
  if (registered.includes(emitted)) return emitted;
  // Normalize both sides: lowercase, strip - / _.
  const norm = (s: string): string => s.toLowerCase().replace(/[-_]/g, '');
  const target = norm(emitted);
  const candidates = registered.map((r) => ({ id: r, n: norm(r) }));
  const exact = candidates.find((c) => c.n === target);
  if (exact) return exact.id;
  const maxD = opts.maxDistance ?? 2;
  let best: { id: string; d: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(target, c.n);
    if (d <= maxD && (!best || d < best.d)) best = { id: c.id, d };
  }
  return best?.id ?? null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

// ── Errors ────────────────────────────────────────────────────────────

export class ToolCallRepairError extends Error {
  constructor(public readonly code: 'unrecoverable' | 'tool_not_resolved', message: string) {
    super(message);
    this.name = 'ToolCallRepairError';
  }
}

export const VERSION = '0.0.0';
