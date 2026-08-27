import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { DiscoveryOptions } from '@omniproxy/engine-declarative';
import type { CliIo } from '../io.js';

/**
 * Turning CLI arguments and the environment into discovery options.
 *
 * Kept apart from the commands so that every command searches the same way. A
 * `provider list` that finds a module and a `capture record` that does not would be
 * the most confusing possible bug in this area.
 */
export function discoveryOptionsFrom(
  io: CliIo,
  providerDirs: readonly string[] | undefined,
): DiscoveryOptions {
  const options: DiscoveryOptions = {
    env: io.env as Record<string, string | undefined>,
  };
  if (providerDirs && providerDirs.length > 0) {
    options.extraDirs = providerDirs.map((dir) => resolve(io.cwd, dir));
  }
  const repoRoot = findRepoRoot(io.cwd);
  if (repoRoot) options.repoRoot = repoRoot;
  return options;
}

/**
 * Walks up looking for the repository's own `providers/` directory.
 *
 * Anchored on `pnpm-workspace.yaml` rather than on `.git`: a user who downloaded a
 * zip instead of cloning still has a working checkout, and losing the shipped
 * providers because there is no `.git` would be a baffling way to fail.
 */
export function findRepoRoot(from: string): string | undefined {
  let current = resolve(from);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
