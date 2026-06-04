import { PiiRedactor } from './piiRedactor.js';

describe('PiiRedactor — email', () => {
  it('redacts simple email', () => {
    const r = new PiiRedactor();
    const out = r.redact('Contact me at foo@example.com tomorrow.');
    expect(out.text).toBe('Contact me at [EMAIL] tomorrow.');
    expect(out.counts.email).toBe(1);
  });

  it('redacts multiple emails in one input', () => {
    const r = new PiiRedactor();
    const out = r.redact('Email a@b.co and c.d@example.org for support.');
    expect(out.text).toContain('[EMAIL] and [EMAIL]');
    expect(out.counts.email).toBe(2);
  });
});

describe('PiiRedactor — phone', () => {
  it('redacts +CC international format', () => {
    const r = new PiiRedactor();
    expect(r.redact('Call +1 415 555 1234 today.').text).toBe('Call [PHONE] today.');
  });

  it('redacts hyphenated US format', () => {
    const r = new PiiRedactor();
    const out = r.redact('Call 415-555-1234 today.');
    // some segment must be replaced
    expect(out.text).toContain('[PHONE]');
  });
});

describe('PiiRedactor — credit cards', () => {
  it('redacts a 16-digit number', () => {
    const r = new PiiRedactor();
    const out = r.redact('Card 4111 1111 1111 1111 expires soon');
    expect(out.text).toContain('[CREDIT_CARD]');
    expect(out.counts.creditcard).toBe(1);
  });
});

describe('PiiRedactor — SSN', () => {
  it('redacts 123-45-6789 form', () => {
    const r = new PiiRedactor();
    expect(r.redact('SSN: 123-45-6789').text).toBe('SSN: [SSN]');
  });
});

describe('PiiRedactor — IBAN', () => {
  it('redacts a German IBAN', () => {
    const r = new PiiRedactor();
    expect(r.redact('IBAN DE89370400440532013000 ok').text).toContain('[IBAN]');
  });
});

describe('PiiRedactor — IP addresses', () => {
  it('redacts IPv4', () => {
    const r = new PiiRedactor();
    expect(r.redact('Server at 192.168.0.1 down').text).toBe('Server at [IPV4] down');
  });

  it('rejects bogus IPv4 (256.0.0.1) — should NOT match', () => {
    const r = new PiiRedactor();
    expect(r.redact('Server at 256.0.0.1 down').text).toContain('256.0.0.1');
  });

  it('redacts a simple IPv6', () => {
    const r = new PiiRedactor();
    const out = r.redact('Box at 2001:db8::1 ok').text;
    expect(out).toContain('[IPV6]');
  });
});

describe('PiiRedactor — configuration', () => {
  it('honors custom labels', () => {
    const r = new PiiRedactor({ labels: { email: '<<REDACTED-EMAIL>>' } });
    expect(r.redact('email a@b.co').text).toContain('<<REDACTED-EMAIL>>');
  });

  it('honors disabled kinds', () => {
    const r = new PiiRedactor({ disable: ['ipv4'] });
    expect(r.redact('host 10.0.0.1 alive').text).toContain('10.0.0.1');
  });

  it('leaves clean text alone (no false positives on common prose)', () => {
    const r = new PiiRedactor();
    const out = r.redact('the quick brown fox jumps over the lazy dog');
    expect(out.text).toBe('the quick brown fox jumps over the lazy dog');
    expect(Object.keys(out.counts)).toHaveLength(0);
  });
});
