import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CaptureBundle } from '@omniproxy/schema';
import { findResidualSecretShapes, type ResidualSecret } from './sanitize.js';

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

/** Where a user's own provider module lives — the same layout as a built-in one. */
export function providerDir(providerId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(omniproxyHome(env), 'providers', providerId);
}

export function providerFixtureDir(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(providerDir(providerId, env), 'fixtures');
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

/**
 * The gate.
 *
 * A fixture is a file that ends up in git, in issues and in other people's hands.
 * Nothing unsanitized may become one — and "sanitized" is not taken on the bundle's
 * word: the finished text is scanned again for anything shaped like a credential
 * before it is allowed to touch the disk. Refusing here is cheap; a leaked session in
 * a public repository cannot be undone.
 */
export class FixtureRefused extends Error {
  override readonly name = 'FixtureRefused';
  constructor(
    message: string,
    readonly userAction: string,
    readonly residues: ResidualSecret[] = [],
  ) {
    super(message);
  }
}

export async function writeFixture(bundle: CaptureBundle, path: string): Promise<string> {
  if (!bundle.sanitized) {
    throw new FixtureRefused(
      `Refusing to write ${path}: the bundle is not sanitized and still contains live credentials.`,
      'Run "omniproxy capture sanitize" on it first.',
    );
  }

  const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
  const residues = findResidualSecretShapes(serialized);
  if (residues.length > 0) {
    throw new FixtureRefused(
      `Refusing to write ${path}: ${residues.length} value(s) are still shaped like a credential.`,
      'Do not commit this bundle. Report the shape that was missed so the detector can be extended.',
      residues,
    );
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialized, 'utf8');
  return path;
}
