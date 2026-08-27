import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asPlugin, loadDialects } from '../src/dialects.js';

/**
 * Loading a dialect from disk.
 *
 * Two properties matter more than the rest and each has its own test: a broken file is
 * named rather than swallowed (invariant I-1 — one bad module never takes the gateway
 * down), and the order files are mounted in is the same on every machine (ADR-0005),
 * because a plugin that shadows another must not do it differently on Windows.
 */

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function tempDir(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), 'omniproxy-dialects-'));
  return directory;
}

/** A module that exports a usable plugin, written the way a user would write one. */
const WORKING = (name: string, exported = 'default'): string => `
const hooks = {
  name: ${JSON.stringify(name)},
  plan: () => ({ kind: 'refused', status: 400, body: {} }),
  identity: () => ({ id: '', model: '' }),
  respond: async () => {},
  error: (e) => ({ status: 502, body: { message: e.message } }),
  refuse: (status, kind, message, action) => ({ kind: 'refused', status, body: { message, action } }),
};
export ${exported === 'default' ? 'default' : `const ${exported} =`} {
  name: ${JSON.stringify(name)},
  dialect: hooks,
  match: (path) => (path === '/${name}' ? {} : undefined),
};
`;

describe('loadDialects', () => {
  it('loads a plugin from a file', async () => {
    const dir = await tempDir();
    const file = join(dir, 'plain.mjs');
    await writeFile(file, WORKING('plain'), 'utf8');

    const [loaded] = await loadDialects([file]);
    expect(loaded?.error).toBeUndefined();
    expect(loaded?.plugin?.name).toBe('plain');
    expect(loaded?.source).toBe(file);
  });

  it('accepts `default`, `dialect` or `plugin` as the export name', async () => {
    // Guessing wrong at the export name is a poor reason to reject working code.
    const dir = await tempDir();
    await writeFile(join(dir, 'a.mjs'), WORKING('a'), 'utf8');
    await writeFile(join(dir, 'b.mjs'), WORKING('b', 'dialect'), 'utf8');
    await writeFile(join(dir, 'c.mjs'), WORKING('c', 'plugin'), 'utf8');

    const loaded = await loadDialects([dir]);
    expect(loaded.map((entry) => entry.plugin?.name)).toEqual(['a', 'b', 'c']);
  });

  it('reads a directory in a fixed order, so shadowing is the same everywhere', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'z.mjs'), WORKING('z'), 'utf8');
    await writeFile(join(dir, 'a.mjs'), WORKING('a'), 'utf8');

    const loaded = await loadDialects([dir]);
    expect(loaded.map((entry) => entry.plugin?.name)).toEqual(['a', 'z']);
  });

  it('ignores files in a directory that are not JavaScript', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'notes.md'), '# not a dialect', 'utf8');
    await writeFile(join(dir, 'ok.mjs'), WORKING('ok'), 'utf8');

    expect((await loadDialects([dir])).map((entry) => entry.plugin?.name)).toEqual(['ok']);
  });

  it('names a file that does not parse, and keeps going', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'a-broken.mjs'), 'export default {{{', 'utf8');
    await writeFile(join(dir, 'b-fine.mjs'), WORKING('fine'), 'utf8');

    const loaded = await loadDialects([dir]);
    expect(loaded[0]?.plugin).toBeUndefined();
    expect(loaded[0]?.error).toBeTruthy();
    // The working one still loads: one broken file must not take the rest down (I-1).
    expect(loaded[1]?.plugin?.name).toBe('fine');
  });

  it('names a path that does not exist rather than dropping it silently', async () => {
    const dir = await tempDir();
    const [loaded] = await loadDialects([join(dir, 'missing.mjs')]);
    // A typo in --dialect should be visible, not a gateway that quietly serves four.
    expect(loaded?.plugin).toBeUndefined();
    expect(loaded?.error).toBeTruthy();
  });

  it('says what to do about a TypeScript file instead of failing obscurely', async () => {
    const dir = await tempDir();
    const file = join(dir, 'mine.ts');
    await writeFile(file, 'export default {}', 'utf8');

    const [loaded] = await loadDialects([file]);
    expect(loaded?.error).toContain('compile it to .js first');
  });

  it('mounts files in the order the paths were given', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'one.mjs'), WORKING('one'), 'utf8');
    await writeFile(join(dir, 'two.mjs'), WORKING('two'), 'utf8');

    const loaded = await loadDialects([join(dir, 'two.mjs'), join(dir, 'one.mjs')]);
    expect(loaded.map((entry) => entry.plugin?.name)).toEqual(['two', 'one']);
  });
});

describe('asPlugin', () => {
  const dialect = {
    plan: () => undefined,
    identity: () => undefined,
    respond: () => undefined,
    error: () => undefined,
    refuse: () => undefined,
  };

  it('accepts a complete plugin', () => {
    const value = { name: 'x', dialect, match: (): undefined => undefined };
    expect(asPlugin(value)).toBe(value);
  });

  it.each([
    ['exports no dialect', undefined, 'exports no dialect'],
    ['exports a number', 42, 'exports no dialect'],
    ['has no name', { dialect, match: (): undefined => undefined }, 'has no `name`'],
    ['has an empty name', { name: '', dialect, match: (): undefined => undefined }, 'has no `name`'],
    ['has no match', { name: 'x', dialect }, 'has no `match'],
    ['has no dialect', { name: 'x', match: (): undefined => undefined }, 'has no `dialect`'],
    [
      'has a side that is not a function',
      { name: 'x', dialect, match: (): undefined => undefined, side: 1 },
      '`side` is not a function',
    ],
    [
      'has paths that are not an array',
      { name: 'x', dialect, match: (): undefined => undefined, paths: '/x' },
      '`paths` is not an array',
    ],
  ])('explains, in one sentence, a plugin that %s', (_title, value, expected) => {
    const result = asPlugin(value);
    expect(typeof result).toBe('string');
    expect(result as string).toContain(expected);
  });

  it('names the hook a dialect is missing, rather than failing at the first request', () => {
    for (const hook of ['plan', 'identity', 'respond', 'error', 'refuse']) {
      const partial: Record<string, unknown> = { ...dialect };
      delete partial[hook];
      const result = asPlugin({ name: 'x', dialect: partial, match: (): undefined => undefined });
      expect(result as string).toContain(`\`${hook}()\``);
    }
  });
});
