import {
  parseIpv4,
  formatIpv4,
  parseCidr,
  ipInCidr,
  isPrivateIp,
  isPrivateIpString,
  classifyUrlHost,
  shouldAllowHttpFetch,
  redactSensitiveUrl,
  redactSensitiveUrlsDeep,
} from './index.js';

describe('parseIpv4 / formatIpv4', () => {
  it('round-trips a dotted-quad', () => {
    const n = parseIpv4('192.168.1.1')!;
    expect(formatIpv4(n)).toBe('192.168.1.1');
  });

  it('returns null on bad input', () => {
    expect(parseIpv4('256.0.0.0')).toBeNull();
    expect(parseIpv4('1.2.3')).toBeNull();
    expect(parseIpv4('abc.def.ghi.jkl')).toBeNull();
  });

  it('handles 0.0.0.0 and 255.255.255.255', () => {
    expect(parseIpv4('0.0.0.0')).toBe(0);
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffff);
  });
});

describe('parseCidr / ipInCidr', () => {
  it('parses standard CIDR', () => {
    const c = parseCidr('10.0.0.0/8')!;
    expect(formatIpv4(c.network)).toBe('10.0.0.0');
  });

  it('rejects malformed CIDR', () => {
    expect(parseCidr('not-a-cidr')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0/-1')).toBeNull();
  });

  it('matches IPs inside the CIDR', () => {
    const c = parseCidr('10.0.0.0/8')!;
    expect(ipInCidr(parseIpv4('10.5.5.5')!, c)).toBe(true);
    expect(ipInCidr(parseIpv4('11.0.0.1')!, c)).toBe(false);
  });

  it('0.0.0.0/0 matches everything', () => {
    const c = parseCidr('0.0.0.0/0')!;
    expect(ipInCidr(parseIpv4('1.2.3.4')!, c)).toBe(true);
  });

  it('192.168.0.0/16 boundary correct', () => {
    const c = parseCidr('192.168.0.0/16')!;
    expect(ipInCidr(parseIpv4('192.168.0.1')!, c)).toBe(true);
    expect(ipInCidr(parseIpv4('192.168.255.255')!, c)).toBe(true);
    expect(ipInCidr(parseIpv4('192.169.0.1')!, c)).toBe(false);
    expect(ipInCidr(parseIpv4('192.167.255.255')!, c)).toBe(false);
  });
});

describe('isPrivateIp / isPrivateIpString', () => {
  it('blocks RFC 1918 ranges', () => {
    expect(isPrivateIpString('10.0.0.1')).toBe(true);
    expect(isPrivateIpString('172.16.0.1')).toBe(true);
    expect(isPrivateIpString('192.168.1.1')).toBe(true);
  });

  it('blocks cloud-metadata 169.254.169.254 (SSRF target)', () => {
    expect(isPrivateIpString('169.254.169.254')).toBe(true);
  });

  it('blocks 127.0.0.0/8 loopback', () => {
    expect(isPrivateIpString('127.0.0.1')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isPrivateIpString('1.1.1.1')).toBe(false); // Cloudflare DNS
    expect(isPrivateIpString('8.8.8.8')).toBe(false); // Google DNS
  });

  it('blocks 0.0.0.0/8 "this network"', () => {
    expect(isPrivateIpString('0.0.0.0')).toBe(true);
    expect(isPrivateIpString('0.255.255.255')).toBe(true);
  });

  it('blocks multicast and broadcast', () => {
    expect(isPrivateIpString('224.0.0.1')).toBe(true);
    expect(isPrivateIpString('255.255.255.255')).toBe(true);
  });

  it('returns false on garbage', () => {
    expect(isPrivateIpString('not-an-ip')).toBe(false);
  });
});

describe('classifyUrlHost', () => {
  it('classifies private IPs', () => {
    expect(classifyUrlHost('http://10.0.0.1/x')).toBe('private_ip');
    expect(classifyUrlHost('https://169.254.169.254/latest/meta-data/')).toBe('private_ip');
  });

  it('classifies public IPs', () => {
    expect(classifyUrlHost('https://1.1.1.1')).toBe('public_ip');
  });

  it('classifies localhost', () => {
    expect(classifyUrlHost('http://localhost:3000')).toBe('localhost');
    expect(classifyUrlHost('http://app.localhost')).toBe('localhost');
  });

  it('classifies DNS names', () => {
    expect(classifyUrlHost('https://api.example.com/foo')).toBe('domain');
  });

  it('returns invalid on malformed URL', () => {
    expect(classifyUrlHost('not a url')).toBe('invalid');
  });
});

describe('shouldAllowHttpFetch', () => {
  it('denies private IPs (SSRF guard)', () => {
    expect(shouldAllowHttpFetch('http://169.254.169.254/')).toBe(false);
    expect(shouldAllowHttpFetch('http://10.0.0.1/')).toBe(false);
  });

  it('denies localhost', () => {
    expect(shouldAllowHttpFetch('http://localhost:8080')).toBe(false);
  });

  it('allows public IPs + domains (caller MUST re-resolve domains)', () => {
    expect(shouldAllowHttpFetch('https://1.1.1.1')).toBe(true);
    expect(shouldAllowHttpFetch('https://api.example.com/v1')).toBe(true);
  });
});

describe('redactSensitiveUrl', () => {
  it('strips user:password', () => {
    expect(redactSensitiveUrl('https://user:p%40ss@api.example.com/x'))
      .toBe('https://api.example.com/x');
  });

  it('strips user-only', () => {
    expect(redactSensitiveUrl('https://user@api.example.com/'))
      .toBe('https://api.example.com/');
  });

  it('preserves URL when no userinfo', () => {
    expect(redactSensitiveUrl('https://api.example.com/v1?q=1#frag'))
      .toBe('https://api.example.com/v1?q=1#frag');
  });

  it('returns input unchanged on parse failure (no throw)', () => {
    expect(redactSensitiveUrl('not a url')).toBe('not a url');
  });
});

describe('redactSensitiveUrlsDeep', () => {
  it('redacts string-shaped URLs inside an object', () => {
    const input = {
      callback: 'https://user:pass@api.example.com/cb',
      meta: { ref: 'https://x@example.org/' },
      list: ['https://a:b@c.com/', 'no url here'],
      n: 42,
    };
    const out = redactSensitiveUrlsDeep(input);
    expect(out.callback).toBe('https://api.example.com/cb');
    expect(out.meta.ref).toBe('https://example.org/');
    expect(out.list[0]).toBe('https://c.com/');
    expect(out.list[1]).toBe('no url here');
    expect(out.n).toBe(42);
  });

  it('does not mutate input', () => {
    const input = { url: 'https://u:p@e.com/' };
    const copy = JSON.parse(JSON.stringify(input));
    redactSensitiveUrlsDeep(input);
    expect(input).toEqual(copy);
  });

  it('survives null and undefined inside the tree', () => {
    const out = redactSensitiveUrlsDeep({ a: null, b: undefined, c: 'safe' });
    expect(out).toEqual({ a: null, b: undefined, c: 'safe' });
  });

  // SECURITY 2026-06-04 vuln-test #A2: prototype-pollution guard.
  it('drops __proto__ + constructor + prototype keys (no proto pollution)', () => {
    const before = ({} as { polluted?: boolean }).polluted;
    const input = JSON.parse('{"safe":"ok","__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}');
    const out = redactSensitiveUrlsDeep(input);
    expect(({} as { polluted?: boolean }).polluted).toBe(before);
    expect(out).toEqual({ safe: 'ok' });
  });
});

describe('SSRF leading-zero IPv4 octet (vuln-test #A12)', () => {
  it('rejects leading-zero octets in parseIpv4', () => {
    expect(parseIpv4('0177.0.0.1')).toBeNull();    // octal evaluator hits 127.0.0.1
    expect(parseIpv4('010.0.0.1')).toBeNull();
    expect(parseIpv4('00.0.0.0')).toBeNull();
    expect(parseIpv4('1.2.3.4')).not.toBeNull();   // canonical still works
  });

  it('shouldAllowHttpFetch denies octal-disguised loopback', () => {
    expect(shouldAllowHttpFetch('http://0177.0.0.1/')).toBe(false); // resolves loopback
  });
});
