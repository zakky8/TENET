import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDatasetFromGlob } from './datasetLoader.js';

describe('loadDatasetFromGlob', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tenet-eval-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loads cases from a single JSONL file', async () => {
    await writeFile(
      join(root, 'cases.jsonl'),
      '{"id":"a","input":"x"}\n{"id":"b","input":"y","labels":["smoke"]}\n',
    );
    const out = await loadDatasetFromGlob({
      rootDir: root,
      pattern: '*.jsonl',
      name: 'sample',
      version: '1',
    });
    expect(out.dataset.cases.map((c) => c.id)).toEqual(['a', 'b']);
    expect(out.dataset.cases[1]!.labels).toEqual(['smoke']);
    expect(out.issues).toEqual([]);
  });

  it('skips empty lines and comments starting with #', async () => {
    await writeFile(
      join(root, 'cases.jsonl'),
      '# this is a comment\n\n{"id":"a","input":"x"}\n  \n',
    );
    const out = await loadDatasetFromGlob({
      rootDir: root,
      pattern: '*.jsonl',
      name: 'x',
      version: '1',
    });
    expect(out.dataset.cases).toHaveLength(1);
    expect(out.issues).toEqual([]);
  });

  it('records issues for invalid JSON but keeps loading', async () => {
    await writeFile(
      join(root, 'cases.jsonl'),
      '{"id":"a","input":"x"}\n{ not valid json }\n{"id":"b","input":"y"}\n',
    );
    const out = await loadDatasetFromGlob({
      rootDir: root,
      pattern: '*.jsonl',
      name: 'x',
      version: '1',
    });
    expect(out.dataset.cases.map((c) => c.id)).toEqual(['a', 'b']);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]!.line).toBe(2);
  });

  it('records issues for missing required fields', async () => {
    await writeFile(
      join(root, 'cases.jsonl'),
      '{"input":"missing id"}\n{"id":"","input":"empty id"}\n{"id":"ok","input":"x"}\n',
    );
    const out = await loadDatasetFromGlob({
      rootDir: root,
      pattern: '*.jsonl',
      name: 'x',
      version: '1',
    });
    expect(out.dataset.cases.map((c) => c.id)).toEqual(['ok']);
    expect(out.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects patterns containing ".." (escape attempt)', async () => {
    await expect(
      loadDatasetFromGlob({
        rootDir: root,
        pattern: '../**/*.jsonl',
        name: 'x',
        version: '1',
      }),
    ).rejects.toThrow(/may not contain/);
  });

  it('matches multiple files via glob pattern across subdirs', async () => {
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(root, 'a.jsonl'), '{"id":"a","input":1}\n');
    await writeFile(join(root, 'sub', 'b.jsonl'), '{"id":"b","input":2}\n');
    const out = await loadDatasetFromGlob({
      rootDir: root,
      pattern: '**/*.jsonl',
      name: 'x',
      version: '1',
    });
    expect(out.dataset.cases.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });
});
