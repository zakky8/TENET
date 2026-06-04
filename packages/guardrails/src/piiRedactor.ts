/**
 * PII redactor — replaces well-known patterns with bracketed sentinels.
 *
 * Intentionally false-positive-tolerant: better to mask a string that
 * looked like a credit card and wasn't than to leak one that was. Apps
 * with stricter requirements (Luhn-validated CCs, country-specific
 * phones) supply their own redactor.
 *
 * Patterns: email, international phone, credit card, US SSN, IBAN,
 * IPv4, IPv6. Order matters because longer / more specific patterns
 * are matched before shorter / generic ones.
 */

export interface PiiRedactorOptions {
  /** Override the label used for each kind. */
  labels?: Partial<Record<PiiKind, string>>;
  /** Disable specific kinds (e.g. don't redact IPv4 for an SRE-facing app). */
  disable?: ReadonlyArray<PiiKind>;
}

export type PiiKind =
  | 'email'
  | 'phone'
  | 'creditcard'
  | 'ssn'
  | 'iban'
  | 'ipv4'
  | 'ipv6';

const DEFAULT_LABELS: Record<PiiKind, string> = {
  email: '[EMAIL]',
  phone: '[PHONE]',
  creditcard: '[CREDIT_CARD]',
  ssn: '[SSN]',
  iban: '[IBAN]',
  ipv4: '[IPV4]',
  ipv6: '[IPV6]',
};

interface PiiRule {
  kind: PiiKind;
  pattern: RegExp;
}

const RULES: PiiRule[] = [
  // Order is important — IBAN before phone (IBAN can start with digits that
  // a phone regex would also match); credit card before phone for the same
  // reason; IPv6 before IPv4 because IPv6 includes colons.
  { kind: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'iban', pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { kind: 'creditcard', pattern: /\b(?:\d[ -]?){13,19}\b/g },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  // IPv6: handles compressed (::) form. {0,4} allows the empty group
  // between consecutive colons. Requires at least 2 colons total so it
  // doesn't match generic hex:hex tokens.
  { kind: 'ipv6', pattern: /\b[A-Fa-f0-9]{0,4}(?::[A-Fa-f0-9]{0,4}){2,7}\b/g },
  { kind: 'ipv4', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  // Phone: +CC (1-3) then 7-14 digits with optional separators
  { kind: 'phone', pattern: /(?:\+|\b)\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}\b/g },
];

export interface RedactionResult {
  text: string;
  /** Per-kind counts of redactions performed. Useful for telemetry. */
  counts: Partial<Record<PiiKind, number>>;
}

export class PiiRedactor {
  private readonly labels: Record<PiiKind, string>;
  private readonly disabled: ReadonlySet<PiiKind>;

  constructor(opts: PiiRedactorOptions = {}) {
    this.labels = { ...DEFAULT_LABELS, ...opts.labels };
    this.disabled = new Set(opts.disable ?? []);
  }

  redact(input: string): RedactionResult {
    let text = input;
    const counts: Partial<Record<PiiKind, number>> = {};
    for (const rule of RULES) {
      if (this.disabled.has(rule.kind)) continue;
      const label = this.labels[rule.kind];
      let kindCount = 0;
      text = text.replace(rule.pattern, () => {
        kindCount++;
        return label;
      });
      if (kindCount > 0) counts[rule.kind] = kindCount;
    }
    return { text, counts };
  }
}
