import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DialectHooks, DialectPlugin } from './dialect.js';

/**
 * Loading a dialect somebody else wrote.
 *
 * The gateway speaks four protocols because four were worth building. It speaks a fifth
 * because you wrote one — no fork, no patch, no pull request waiting on us. A dialect
 * is a JavaScript module that exports a `DialectPlugin`, and the built-in four are
 * mounted through exactly the same door (`server.ts`), so there is nothing a plugin
 * cannot reach that we can.
 *
 * **Nothing is loaded implicitly.** Only paths the user named on the command line are
 * read — never the working directory, never `node_modules`, never a well-known folder
 * that something else could drop a file into. A dialect module is code, and it runs
 * with the gateway's privileges and its accounts; that is a reasonable thing to allow
 * on purpose and a terrible thing to allow by accident.
 *
 * A module that fails to load is named and skipped. One broken file must not take a
 * working gateway down with it (invariant I-1).
 */

export interface LoadedDialect {
  /** The file it came from, so a message about it can be acted on. */
  source: string;
  plugin?: DialectPlugin;
  /** Why it did not load. Set exactly when `plugin` is not. */
  error?: string;
}

/** Extensions Node can import without a loader. TypeScript has to be compiled first. */
const LOADABLE = new Set(['.js', '.mjs', '.cjs']);

/**
 * Every dialect under the given files and directories, in the order given.
 *
 * A directory is read one level deep and sorted, so the mounting order is the same on
 * every machine — a plugin that shadows another must not do it differently on Windows
 * than on Linux (ADR-0005).
 */
export async function loadDialects(paths: readonly string[]): Promise<LoadedDialect[]> {
  const loaded: LoadedDialect[] = [];
  for (const path of paths) {
    for (const file of await expand(resolve(path))) {
      loaded.push(await loadOne(file));
    }
  }
  return loaded;
}

async function expand(path: string): Promise<string[]> {
  let info;
  try {
    info = await stat(path);
  } catch {
    // Kept as an entry rather than dropped: a typo in --dialect should be visible.
    return [path];
  }
  if (!info.isDirectory()) return [path];

  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && LOADABLE.has(extname(entry.name)))
    .map((entry) => join(path, entry.name))
    .sort();
}

async function loadOne(file: string): Promise<LoadedDialect> {
  if (!LOADABLE.has(extname(file))) {
    return {
      source: file,
      error:
        extname(file) === '.ts'
          ? 'TypeScript cannot be imported directly — compile it to .js first'
          : `not a JavaScript module (expected ${[...LOADABLE].join(', ')})`,
    };
  }

  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    return { source: file, error: (error as Error).message };
  }

  // `default`, or a named `dialect`/`plugin` — all three are natural things to write,
  // and guessing wrong at the export name is a poor reason to reject working code.
  const exported = module['default'] ?? module['dialect'] ?? module['plugin'];
  const checked = asPlugin(exported);
  return typeof checked === 'string'
    ? { source: file, error: checked }
    : { source: file, plugin: checked };
}

/**
 * The plugin, or one sentence about why it is not one.
 *
 * Checked here rather than at the first request: a dialect whose `respond` is missing
 * should fail at startup with the file name, not halfway through somebody's answer.
 */
export function asPlugin(value: unknown): DialectPlugin | string {
  if (typeof value !== 'object' || value === null) {
    return 'exports no dialect (expected `export default { name, dialect, match }`)';
  }

  const plugin = value as Partial<DialectPlugin>;
  if (typeof plugin.name !== 'string' || plugin.name === '') return 'has no `name`';
  if (typeof plugin.match !== 'function') return 'has no `match(path, method)`';
  if (plugin.side !== undefined && typeof plugin.side !== 'function') {
    return '`side` is not a function';
  }
  if (plugin.paths !== undefined && !Array.isArray(plugin.paths)) return '`paths` is not an array';

  const dialect = plugin.dialect as Partial<DialectHooks<never>> | undefined;
  if (typeof dialect !== 'object' || dialect === null) return 'has no `dialect`';
  for (const hook of ['plan', 'identity', 'respond', 'error', 'refuse'] as const) {
    if (typeof dialect[hook] !== 'function') return `its dialect has no \`${hook}()\``;
  }

  return plugin as DialectPlugin;
}
