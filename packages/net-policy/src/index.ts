/**
 * Network policy primitives — closes two SSRF / credential-leak gaps
 * the rest of the framework relied on operators to handle.
 *
 * Borrowed from OpenClaw audit (net-policy package).
 *
 * Why this matters:
 *   1. SSRF — an LLM-tool that fetches a URL the model emits will
 *      hit 169.254.169.254 (cloud metadata) or 10.x.x.x (internal
 *      services) unless the URL is gated. We ship isPrivateIp() +
 *      a CIDR matcher.
 *   2. URL userinfo redaction — a URL like
 *      https://user:pass@api.example.com leaks `pass` if the URL
 *      shows up in logs, audit sinks, or error messages. We ship
 *      redactSensitiveUrl() — drops userinfo, keeps everything else.
 *
 * Pure functions, no deps. Operators compose into PolicyEvaluator
 * rules (@tenet/governance) for pre-tool-call enforcement.
 */

// ── IPv4 utilities ────────────────────────────────────────────────────

/**
 * Parse a dotted-quad IPv4 string into a 32-bit unsigned integer.
 *
 * SECURITY 2026-06-04 vuln-test #A12: reject leading-zero octets.
 * `0177.0.0.1` previously parsed as `177.0.0.1` (public) but Node's
 * resolver interprets `0177` as octal = 127, hitting loopback — an
 * SSRF bypass against `isPrivateIp`. Strict decimal-only digits.
 */
export function parseIpv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const raw = m.slice(1);
  for (const r of raw) {
    if (r.length > 1 && r.startsWith('0')) return null; // reject leading-zero octets
  }
  const parts = raw.map(Number);
  if (parts.some((p) => p < 0 || p > 255 || Number.isNaN(p))) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** Format a 32-bit unsigned integer back to dotted-quad. */
export function formatIpv4(n: number): string {
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/** Parse a "a.b.c.d/n" CIDR into {network, mask}. Null on parse fail. */
export function parseCidr(cidr: string): { network: number; mask: number } | null {
  const slash = cidr.indexOf('/');
  if (slash === -1) return null;
  const ip = parseIpv4(cidr.slice(0, slash));
  if (ip === null) return null;
  const bits = Number.parseInt(cidr.slice(slash + 1), 10);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { network: (ip & mask) >>> 0, mask };
}

/** True if `ip` is within `cidr`. Both as 32-bit ints / CIDR struct. */
export function ipInCidr(ip: number, cidr: { network: number; mask: number }): boolean {
  return ((ip & cidr.mask) >>> 0) === cidr.network;
}

// ── Private-range checker ─────────────────────────────────────────────

/**
 * RFC 1918 private + RFC 6890 special-use + cloud metadata ranges.
 * Caller blocking every IP in this list is SSRF-safe by default; an
 * operator wanting a specific cloud-metadata IP for legitimate use
 * filters at a higher layer.
 */
export const PRIVATE_CIDRS = [
  '10.0.0.0/8',          // RFC 1918
  '172.16.0.0/12',       // RFC 1918
  '192.168.0.0/16',      // RFC 1918
  '127.0.0.0/8',         // loopback
  '0.0.0.0/8',           // "this network"
  '169.254.0.0/16',      // link-local + cloud metadata (169.254.169.254)
  '100.64.0.0/10',       // RFC 6598 CGNAT
  '192.0.0.0/24',        // IETF protocol assignments
  '192.0.2.0/24',        // TEST-NET-1
  '198.18.0.0/15',       // benchmark testing
  '198.51.100.0/24',     // TEST-NET-2
  '203.0.113.0/24',      // TEST-NET-3
  '224.0.0.0/4',         // multicast
  '240.0.0.0/4',         // reserved
  '255.255.255.255/32',  // broadcast
] as const;

const PARSED_PRIVATE_CIDRS = PRIVATE_CIDRS.map((c) => {
  const parsed = parseCidr(c);
  if (!parsed) throw new Error(`net-policy: invalid built-in CIDR ${c}`);
  return parsed;
});

/** True iff `ip` falls inside any of PRIVATE_CIDRS. */
export function isPrivateIp(ip: number): boolean {
  for (const c of PARSED_PRIVATE_CIDRS) {
    if (ipInCidr(ip, c)) return true;
  }
  return false;
}

/** True iff a dotted-quad string is private (or unparseable). */
export function isPrivateIpString(s: string): boolean {
  const ip = parseIpv4(s);
  if (ip === null) return false;
  return isPrivateIp(ip);
}

// ── URL host classification ───────────────────────────────────────────

/**
 * Classify a URL host for SSRF policy:
 *   - 'private_ip'    — dotted-quad in a private range
 *   - 'localhost'     — literal localhost / *.localhost
 *   - 'public_ip'     — dotted-quad outside private ranges
 *   - 'domain'        — DNS name (caller MUST resolve + re-check)
 *   - 'invalid'       — bad URL
 */
export type HostClass = 'private_ip' | 'localhost' | 'public_ip' | 'domain' | 'invalid';

export function classifyUrlHost(input: string): HostClass {
  let u: URL;
  try { u = new URL(input); } catch { return 'invalid'; }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return 'localhost';
  const ip = parseIpv4(host);
  if (ip !== null) return isPrivateIp(ip) ? 'private_ip' : 'public_ip';
  return 'domain';
}

/**
 * Returns true when the URL's host should be allowed for outbound
 * fetches under a fail-closed SSRF policy. Domain names need DNS
 * resolution + re-check — this function returns true for domains
 * (the caller must resolve and re-classify the resolved IP).
 */
export function shouldAllowHttpFetch(input: string): boolean {
  const cls = classifyUrlHost(input);
  return cls === 'public_ip' || cls === 'domain';
}

// ── URL redaction — strip userinfo to prevent credential leak ─────────

/**
 * Redact userinfo (user:password@) from a URL while preserving
 * everything else. Used before emitting a URL into:
 *   - audit logs
 *   - error messages
 *   - tool-call traces
 *
 * Returns the original input on parse failure (best effort — never
 * throws so it's safe in error paths).
 */
export function redactSensitiveUrl(input: string): string {
  let u: URL;
  try { u = new URL(input); } catch { return input; }
  if (!u.username && !u.password) return u.toString();
  u.username = '';
  u.password = '';
  return u.toString();
}

/**
 * Recursively walk an object and redact any string value that parses
 * as a URL with userinfo. Operator pipes audit-event payloads
 * through this before emit.
 *
 * Returns a NEW object — does not mutate the input.
 */
// SECURITY 2026-06-04 vuln-test #A2: prototype-pollution guard for
// audit-payload deep walk. Audit payloads cross the untrusted boundary
// per the package docs ("operator pipes audit-event payloads through
// this before emit"); an attacker-controlled key `__proto__` /
// `constructor` / `prototype` would mutate Object.prototype across the
// runtime. Skip dangerous keys + use Object.create(null) so the output
// object has no inherited keys at all.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function redactSensitiveUrlsDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return redactSensitiveUrl(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitiveUrlsDeep(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      out[k] = redactSensitiveUrlsDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

// ── Errors ────────────────────────────────────────────────────────────

export class NetPolicyError extends Error {
  constructor(public readonly code: 'private_ip_blocked' | 'invalid_url' | 'host_unresolved', message: string) {
    super(message);
    this.name = 'NetPolicyError';
  }
}

export const VERSION = '0.0.0';
