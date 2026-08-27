import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
 *
 * When the CLI is installed globally (or run from /tmp outside any checkout),
 * there is no pnpm-workspace.yaml above cwd. In that case fall back to the
 * directory that contains this file — in the built image that is
 * `.../apps/cli/dist/commands/` and `../../../providers` is the shipped set,
 * and in a global npm layout it would be `.../providers` beside the package
 * if the publisher includes it (see Containerfile).
 */
export function findRepoRoot(from: string): string | undefined {
  let current = resolve(from);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // Fallback: providers shipped alongside the CLI package itself.
  // In the built image `thisFile` is .../apps/cli/dist/commands/provider-context.js
  // and the repo root is four levels up: commands -> dist -> cli -> apps -> root.
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const candidate = resolve(dirname(thisFile), '../../../../providers');
    if (existsSync(join(candidate, 'deepseek-web', 'provider.yaml'))) {
      // The candidate *is* the providers dir; its parent is the repo root.
      return dirname(candidate);
    }
    // Bundled layout: providers copied next to the CLI package (e.g. /app/providers
    // in Containerfile, or node_modules/@omniproxy/cli/providers when published).
    const bundled = resolve(dirname(thisFile), '../providers');
    if (existsSync(join(bundled, 'deepseek-web', 'provider.yaml'))) return dirname(bundled);
    const alt = resolve(dirname(thisFile), '../../providers');
    if (existsSync(join(alt, 'deepseek-web', 'provider.yaml'))) return dirname(alt);
  } catch {
    // fileURLToPath can throw in some bundlers — not fatal.
  }
  return undefined;
}
