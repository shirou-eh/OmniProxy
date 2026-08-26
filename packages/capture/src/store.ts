import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CaptureBundle } from '@omniproxy/schema';

/**
 * Local storage for raw, unsanitized captures.
 *
 * A freshly imported bundle contains live cookies and tokens. It is allowed to exist
 * in exactly one place — a short-lived cache under the user's OmniProxy home — and is
 * never written to a provider's `fixtures/` directory or anywhere inside the repo.
 * The sanitizer (PR-2) is what produces something safe to keep.
 *
 * File permissions are set to owner-only where the platform honours them. On Windows
 * `chmod` is a no-op (ADR-0005), which is precisely why the long-term protection for
 * secrets is encryption and a one-hour TTL rather than file modes.
 */

export const RAW_CACHE_TTL_MS = 60 * 60 * 1000;

/** Root for all local state. `OMNIPROXY_HOME` overrides it — X-1 of the charter. */
export function omniproxyHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['OMNIPROXY_HOME'] ?? join(homedir(), '.omniproxy');
}

export function rawCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(omniproxyHome(env), 'tmp');
}

export interface WriteRawBundleResult {
  path: string;
  prunedFiles: number;
}

export async function writeRawBundle(
  bundle: CaptureBundle,
  options: { dir?: string; ttlMs?: number; now?: number } = {},
): Promise<WriteRawBundleResult> {
  const dir = options.dir ?? rawCacheDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const prunedFiles = await pruneRawCache({
    dir,
    ttlMs: options.ttlMs ?? RAW_CACHE_TTL_MS,
    now: options.now ?? Date.now(),
  });

  const path = join(dir, `${bundle.id}.raw.json`);
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  return { path, prunedFiles };
}

/** Deletes raw captures older than the TTL. Returns how many were removed. */
export async function pruneRawCache(options: {
  dir: string;
  ttlMs: number;
  now: number;
}): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(options.dir);
  } catch {
    return 0;
  }

  for (const name of names) {
    if (!name.endsWith('.raw.json')) continue;
    const path = join(options.dir, name);
    try {
      const info = await stat(path);
      if (options.now - info.mtimeMs > options.ttlMs) {
        await rm(path, { force: true });
        removed += 1;
      }
    } catch {
      // A file that vanished or cannot be read is not a reason to abort the import.
    }
  }

  return removed;
}
