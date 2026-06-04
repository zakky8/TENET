import {
  parseFrontmatter,
  SkillRegistry,
  SkillError,
  InMemoryBodyLoader,
  skillAllowedTools,
} from './index.js';

const SAMPLE = `---
name: weather
description: "Look up the current weather for a city"
allowed-tools: ["http.get", "geocode.lookup"]
user-invocable: true
license: Apache-2.0
homepage: "https://example.com/skills/weather"
metadata: { version: 1, category: "utility" }
---

# Weather

Use http.get against api.example.com/weather?city=<city>.
`;

describe('parseFrontmatter', () => {
  it('parses a typical SKILL.md', () => {
    const { frontmatter, body } = parseFrontmatter(SAMPLE);
    expect(frontmatter.name).toBe('weather');
    expect(frontmatter.description).toBe('Look up the current weather for a city');
    expect(frontmatter.allowedTools).toEqual(['http.get', 'geocode.lookup']);
    expect(frontmatter.userInvocable).toBe(true);
    expect(frontmatter.license).toBe('Apache-2.0');
    expect(frontmatter.homepage).toBe('https://example.com/skills/weather');
    expect(frontmatter.metadata).toEqual({ version: 1, category: 'utility' });
    expect(body).toContain('# Weather');
  });

  it('throws on missing --- delimiters', () => {
    expect(() => parseFrontmatter('no frontmatter here')).toThrow(SkillError);
  });

  it('throws when required `name` missing', () => {
    expect(() => parseFrontmatter('---\ndescription: "x"\n---\nbody')).toThrow(SkillError);
  });

  it('throws when required `description` missing', () => {
    expect(() => parseFrontmatter('---\nname: x\n---\nbody')).toThrow(SkillError);
  });

  it('handles CRLF line endings', () => {
    const text = '---\r\nname: x\r\ndescription: "y"\r\n---\r\nbody';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.name).toBe('x');
  });

  it('strips end-of-line YAML comments', () => {
    const text = '---\nname: x  # this is a name\ndescription: "y"\n---\nbody';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.name).toBe('x');
  });

  it('coerces YAML booleans / numbers correctly', () => {
    const text = '---\nname: x\ndescription: "y"\nuser-invocable: false\n---\n';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.userInvocable).toBe(false);
  });

  it('rejects malformed flow arrays gracefully', () => {
    // Unclosed bracket → bare-string fallback, never crash
    const text = '---\nname: x\ndescription: "y"\nallowed-tools: [unclosed\n---\n';
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.allowedTools).toBeUndefined();
  });

  it('throws on line without colon', () => {
    expect(() => parseFrontmatter('---\nname: x\ndescription: "y"\nbroken-line\n---\n')).toThrow(SkillError);
  });
});

describe('SkillRegistry', () => {
  function makeRegistry() {
    return new SkillRegistry(new InMemoryBodyLoader({}));
  }

  it('registers + lists skills (metadata only)', () => {
    const r = makeRegistry();
    r.registerFromText('weather.md', SAMPLE);
    const list = r.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('weather');
  });

  it('rejects duplicate name', () => {
    const r = makeRegistry();
    r.registerFromText('weather.md', SAMPLE);
    expect(() => r.registerFromText('weather2.md', SAMPLE)).toThrow(SkillError);
  });

  it('get() returns metadata for known skill', () => {
    const r = makeRegistry();
    r.registerFromText('weather.md', SAMPLE);
    expect(r.get('weather')?.description).toMatch(/weather/);
    expect(r.get('absent')).toBeUndefined();
  });

  it('loadBody() pre-cached from registerFromText() is hit-cache', async () => {
    const r = makeRegistry();
    r.registerFromText('weather.md', SAMPLE);
    const body = await r.loadBody('weather');
    expect(body).toContain('# Weather');
  });

  it('loadBody() uses BodyLoader for non-pre-cached sources', async () => {
    const r = new SkillRegistry(new InMemoryBodyLoader({ 'external.md': 'extra body' }));
    r.register({
      frontmatter: { name: 'x', description: 'd' },
      source: 'external.md',
    });
    expect(await r.loadBody('x')).toBe('extra body');
  });

  it('loadBody() throws unknown_skill for unregistered name', async () => {
    const r = makeRegistry();
    await expect(r.loadBody('missing')).rejects.toMatchObject({ code: 'unknown_skill' });
  });

  it('loadBody() wraps BodyLoader errors as body_load_failed', async () => {
    const failing: { load: () => Promise<string> } = {
      load: async () => { throw new Error('disk error'); },
    };
    const r = new SkillRegistry(failing);
    r.register({ frontmatter: { name: 'x', description: 'd' }, source: 'p' });
    await expect(r.loadBody('x')).rejects.toMatchObject({ code: 'body_load_failed' });
  });

  it('filter() — only user-invocable skills', () => {
    const r = makeRegistry();
    r.registerFromText('a.md', SAMPLE); // user-invocable: true
    r.registerFromText('b.md', '---\nname: b\ndescription: "internal"\nuser-invocable: false\n---\n');
    const visible = r.filter((s) => s.userInvocable === true);
    expect(visible.map((s) => s.name)).toEqual(['weather']);
  });
});

describe('skillAllowedTools', () => {
  it('returns the declared allow-list', () => {
    const { frontmatter } = parseFrontmatter(SAMPLE);
    expect(skillAllowedTools(frontmatter)).toEqual(['http.get', 'geocode.lookup']);
  });

  it('returns [] when none declared', () => {
    const { frontmatter } = parseFrontmatter('---\nname: a\ndescription: b\n---\n');
    expect(skillAllowedTools(frontmatter)).toEqual([]);
  });
});
