import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { omniproxyHome, pruneRawCache, rawCacheDir, writeRawBundle } from '../src/store.js';
import type { CaptureBundle } from '@omniproxy/schema';

const bundle: CaptureBundle = {
  id: 'example-chat-stream-20260827-001000Z',
  providerId: 'example',
  capturedAt: '2026-08-27T00:10:00.000Z',
  method: 'har-import',
  scenario: 'chat-stream',
  sanitized: false,
  entries: [],
  redactions: {},
  notes: [],
};

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'omniproxy-capture-'));
}

describe('writeRawBundle', () => {
  it('writes the bundle under the raw cache and reports where', async () => {
    const dir = await tempDir();
    const { path } = await writeRawBundle(bundle, { dir });

    expect(path).toBe(join(dir, `${bundle.id}.raw.json`));
    const written = JSON.parse(await readFile(path, 'utf8')) as CaptureBundle;
    expect(written.id).toBe(bundle.id);
    expect(written.sanitized).toBe(false);
  });

  it('creates the directory when it does not exist yet', async () => {
    const dir = join(await tempDir(), 'nested', 'deeper');
    const { path } = await writeRawBundle(bundle, { dir });
    expect(await readdir(dir)).toContain(`${bundle.id}.raw.json`);
    expect(path).toContain('deeper');
  });

  it('prunes stale raw captures on every write', async () => {
    const dir = await tempDir();
    const stale = join(dir, 'old-capture.raw.json');
    await writeFile(stale, '{}');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, twoHoursAgo, twoHoursAgo);

    const { prunedFiles } = await writeRawBundle(bundle, { dir });

    expect(prunedFiles).toBe(1);
    expect(await readdir(dir)).toEqual([`${bundle.id}.raw.json`]);
  });

  it('leaves unrelated files alone', async () => {
    const dir = await tempDir();
    const notOurs = join(dir, 'notes.txt');
    await writeFile(notOurs, 'keep me');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(notOurs, old, old);

    await writeRawBundle(bundle, { dir });

    expect(await readdir(dir)).toContain('notes.txt');
  });
});

describe('pruneRawCache', () => {
  it('is a no-op on a directory that does not exist', async () => {
    const removed = await pruneRawCache({
      dir: join(tmpdir(), 'omniproxy-does-not-exist-9f3a'),
      ttlMs: 1,
      now: Date.now(),
    });
    expect(removed).toBe(0);
  });
});

describe('paths', () => {
  it('honours OMNIPROXY_HOME so nothing is hardcoded', () => {
    const env = { OMNIPROXY_HOME: join('C:', 'elsewhere') } as NodeJS.ProcessEnv;
    expect(omniproxyHome(env)).toBe(join('C:', 'elsewhere'));
    expect(rawCacheDir(env)).toBe(join('C:', 'elsewhere', 'tmp'));
  });

  it('falls back to the user home directory', () => {
    expect(rawCacheDir({} as NodeJS.ProcessEnv)).toContain('.omniproxy');
  });
});
