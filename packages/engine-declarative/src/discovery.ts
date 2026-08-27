import { readdir, readFile, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { ProviderDeclaration } from '@omniproxy/schema';
import { DeclarationError, parseDeclaration, validateDeclaration, type ValidationReport } from './loader.js';
import { TransformRegistry } from './transforms.js';

/**
 * Finding provider modules on disk (ADR-0003).
 *
 * The whole point of this file is that a provider a stranger wrote is found the same
 * way a provider we shipped is found. There is no registry to be admitted to, no
 * approval step, no difference in capability — a directory with a `provider.yaml` in
 * it is a provider. Someone who wants a service we have never heard of drops a folder
 * in `~/.omniproxy/providers/` and it is theirs.
 *
 * Search order, first match winning:
 *
 *   1. `--provider-dir` on the command line
 *   2. `$OMNIPROXY_PROVIDER_PATH` (`;`-separated on Windows, `:` elsewhere)
 *   3. `~/.omniproxy/providers/`
 *   4. `providers/` in the repository
 *
 * The user's own directories come before ours on purpose. Overriding a shipped
 * provider with your own edited copy is a supported thing to do, not an accident to
 * be prevented — if someone rewires our DeepSeek declaration because their account
 * behaves differently, that is them using the tool correctly.
 */

export interface DiscoveryOptions {
  /** Explicit directories, highest priority. */
  extraDirs?: readonly string[];
  /** Usually `process.env`. */
  env?: Record<string, string | undefined>;
  /** Where `~/.omniproxy` lives; defaults to the user's home. */
  home?: string;
  /** Repository root, for the shipped `providers/` directory. */
  repoRoot?: string;
  /** Transforms available, so a module naming a missing one is reported, not crashed. */
  transforms?: TransformRegistry;
}

export interface FoundProvider {
  id: string;
  /** The directory, not the file. A module may hold fixtures and an adapter too. */
  dir: string;
  file: string;
  /** Which of the four sources it came from, for `omniproxy provider list`. */
  origin: 'flag' | 'env' | 'home' | 'repo';
  declaration?: ProviderDeclaration;
  /** Present when the module exists but does not load. Never fatal for the others. */
  error?: string;
  warnings: string[];
  /** An `adapter.ts` beside the declaration: code, and so requires trust (ADR-0003). */
  hasAdapter: boolean;
}

const MODULE_FILE = 'provider.yaml';

export function providerSearchPath(options: DiscoveryOptions = {}): { dir: string; origin: FoundProvider['origin'] }[] {
  const env = options.env ?? {};
  const path: { dir: string; origin: FoundProvider['origin'] }[] = [];

  for (const dir of options.extraDirs ?? []) {
    path.push({ dir: resolve(dir), origin: 'flag' });
  }

  const fromEnv = env['OMNIPROXY_PROVIDER_PATH'];
  if (fromEnv) {
    // `path.delimiter`, not a hardcoded ':' — a Windows path is `C:\...` and splitting
    // it on a colon produces two directories that do not exist (ADR-0005).
    for (const dir of fromEnv.split(delimiter)) {
      if (dir.trim() !== '') path.push({ dir: resolve(dir.trim()), origin: 'env' });
    }
  }

  const home = options.home ?? env['OMNIPROXY_HOME'] ?? env['HOME'] ?? env['USERPROFILE'];
  if (home) path.push({ dir: join(home, '.omniproxy', 'providers'), origin: 'home' });

  if (options.repoRoot) path.push({ dir: join(options.repoRoot, 'providers'), origin: 'repo' });

  return path;
}

/**
 * Every module found, best source first, one entry per id.
 *
 * A module that fails to load is *reported*, not thrown: one broken declaration in a
 * directory must not make the other nineteen providers disappear. That is the whole
 * difference between "your gateway is down" and "one provider needs attention".
 */
export async function discoverProviders(options: DiscoveryOptions = {}): Promise<FoundProvider[]> {
  const transforms = options.transforms ?? new TransformRegistry();
  const seen = new Map<string, FoundProvider>();

  for (const { dir, origin } of providerSearchPath(options)) {
    for (const candidate of await moduleDirs(dir)) {
      const found = await loadModule(candidate, origin, transforms);
      if (!found) continue;
      // First source wins: the user's copy shadows ours, deliberately.
      if (!seen.has(found.id)) seen.set(found.id, found);
    }
  }

  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Loads one module by id, or explains where it looked. */
export async function loadProvider(
  id: string,
  options: DiscoveryOptions = {},
): Promise<FoundProvider> {
  const found = (await discoverProviders(options)).find((module) => module.id === id);
  if (found) return found;

  const looked = providerSearchPath(options)
    .map((entry) => `  ${entry.dir}`)
    .join('\n');
  throw new DeclarationError(
    `no provider module "${id}"`,
    `Looked in:\n${looked}\n\nA provider module is a directory containing ${MODULE_FILE}. ` +
      `Point at one directly with --provider-dir, or add its parent to $OMNIPROXY_PROVIDER_PATH.`,
  );
}

/** Loads a declaration from an explicit file path, bypassing discovery entirely. */
export async function loadDeclarationFile(
  file: string,
  options: DiscoveryOptions = {},
): Promise<ProviderDeclaration> {
  const path = isAbsolute(file) ? file : resolve(file);
  const text = await readFile(path, 'utf8');
  const parseOptions: { source: string; transforms?: TransformRegistry } = { source: path };
  if (options.transforms) parseOptions.transforms = options.transforms;
  return parseDeclaration(text, parseOptions);
}

/* ──────────────────────────────────── internals ──────────────────────────────────── */

async function moduleDirs(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // A directory on the search path that does not exist is normal, not an error:
    // most users will never create ~/.omniproxy/providers at all.
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = join(root, entry.name);
    if (await exists(join(dir, MODULE_FILE))) dirs.push(dir);
  }
  return dirs.sort();
}

async function loadModule(
  dir: string,
  origin: FoundProvider['origin'],
  transforms: TransformRegistry,
): Promise<FoundProvider | undefined> {
  const file = join(dir, MODULE_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }

  const hasAdapter =
    (await exists(join(dir, 'adapter.ts'))) || (await exists(join(dir, 'adapter.js')));

  let report: ValidationReport;
  try {
    report = validateDeclaration(text, { source: file, transforms });
  } catch (error) {
    return {
      id: fallbackId(dir),
      dir,
      file,
      origin,
      error: error instanceof Error ? error.message : String(error),
      warnings: [],
      hasAdapter,
    };
  }

  if (!report.ok || !report.declaration) {
    return {
      id: fallbackId(dir),
      dir,
      file,
      origin,
      error: report.errors.join('; '),
      warnings: report.warnings,
      hasAdapter,
    };
  }

  const found: FoundProvider = {
    id: report.declaration.id,
    dir,
    file,
    origin,
    declaration: report.declaration,
    warnings: [...report.warnings],
    hasAdapter,
  };

  // A mismatch is legal but confusing enough to say out loud: discovery finds modules
  // by directory and everything else refers to them by id.
  if (report.declaration.id !== basename(dir)) {
    found.warnings.push(
      `the directory is "${basename(dir)}" but the declaration says id: ${report.declaration.id}. ` +
        'Both work; matching them makes the module easier to find.',
    );
  }

  if (hasAdapter) {
    found.warnings.push(
      'this module ships an adapter file. Code from a provider module runs only after ' +
        'you trust it explicitly (ADR-0003) — read it first.',
    );
  }

  return found;
}

/** For a module that failed to parse: the directory name is all we can go on. */
function fallbackId(dir: string): string {
  return basename(dir);
}

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
