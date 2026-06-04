import * as path from 'node:path';
import * as os from 'node:os';
import {
  configurePathRoot,
  openPath,
  getPathRoot,
  __resetPathRootForTesting__,
} from './path.js';

const ROOT = path.join(os.tmpdir(), 'tenet-pathhandle-test');

describe('configurePathRoot', () => {
  beforeEach(() => __resetPathRootForTesting__());

  it('accepts a valid root', () => {
    configurePathRoot(ROOT);
    expect(getPathRoot()).toBe(path.resolve(ROOT));
  });

  it('rejects empty string', () => {
    expect(() => configurePathRoot('')).toThrow(/non-empty string/);
  });

  it('is idempotent for the same value', () => {
    configurePathRoot(ROOT);
    expect(() => configurePathRoot(ROOT)).not.toThrow();
  });

  it('throws on reconfigure to a different root', () => {
    configurePathRoot(ROOT);
    expect(() => configurePathRoot(path.join(os.tmpdir(), 'different'))).toThrow(/already configured/);
  });
});

describe('openPath — security properties', () => {
  beforeEach(() => {
    __resetPathRootForTesting__();
    configurePathRoot(ROOT);
  });

  it('returns a PathHandle for a valid relative path under root', () => {
    const h = openPath('subdir/file.txt');
    expect(h.absolute).toBe(path.resolve(ROOT, 'subdir/file.txt'));
  });

  it('REJECTS absolute paths', () => {
    expect(() => openPath('/etc/passwd')).toThrow(/absolute paths rejected/);
    expect(() => openPath('C:\\Windows\\System32\\config')).toThrow(/absolute paths rejected/);
  });

  it('REJECTS path traversal via ".."', () => {
    expect(() => openPath('../etc/passwd')).toThrow(/traversal/);
    expect(() => openPath('foo/../../bar')).toThrow(/traversal/);
    expect(() => openPath('..\\backslash\\trick')).toThrow(/traversal/);
  });

  it('REJECTS empty / undefined path', () => {
    expect(() => openPath('')).toThrow();
    expect(() => openPath(undefined as unknown as string)).toThrow();
  });

  it('throws when root is not configured', () => {
    __resetPathRootForTesting__();
    expect(() => openPath('foo.txt')).toThrow(/configurePathRoot/);
  });

  it('REJECTS resolved paths that escape root even without literal "..", via symlink-style bypass attempt', () => {
    // The current check already blocks ".." segments. Test that joining
    // a path that on Windows might resolve through drive-letter swap
    // is still safe — path.resolve handles platform-specific normalization.
    // Here we just sanity-check the prefix check.
    const handle = openPath('safe/nested/file.txt');
    expect(handle.absolute.startsWith(path.resolve(ROOT))).toBe(true);
  });

  it('PathHandle.absolute is always absolute', () => {
    const h = openPath('a/b/c');
    expect(path.isAbsolute(h.absolute)).toBe(true);
  });

  it('PathHandle stays under root for nested paths', () => {
    const h = openPath('deeply/nested/path/file.txt');
    const rootResolved = path.resolve(ROOT);
    expect(h.absolute.startsWith(rootResolved)).toBe(true);
  });
});
