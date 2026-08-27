import { parseArgs } from 'node:util';
import {
  discoverProviders,
  providerSearchPath,
  type FoundProvider,
} from '@omniproxy/engine-declarative';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../io.js';
import { discoveryOptionsFrom } from './provider-context.js';

export const PROVIDER_LIST_USAGE = `omniproxy provider list [--provider-dir <dir>] [--json]

Shows every provider module found, and where it came from.

Modules are searched for in this order, first match winning:
  1. --provider-dir           (repeatable)
  2. $OMNIPROXY_PROVIDER_PATH (${process.platform === 'win32' ? ';' : ':'}-separated)
  3. ~/.omniproxy/providers/
  4. providers/ in the repository

Your directories come first on purpose: shadowing a shipped provider with your own
edited copy is a supported thing to do, not an accident to be prevented.

Options:
  --provider-dir <dir>  Extra directory to search. May be given more than once.
  --json                Machine-readable output.
  -h, --help            Show this help.`;

export const PROVIDER_VALIDATE_USAGE = `omniproxy provider validate [<id>] [--provider-dir <dir>]

Checks provider modules and reports what is wrong and what is merely suspicious.

Errors mean the module will not load: an unknown key, a JSONPath that is not one, a
transform nobody implemented. Warnings mean it will load and something looks off — a
provider calling itself stable with no capture behind it, a missing probe, an
unmeasured context budget. Warnings never block: the author knows their provider
better than this list does.

With no id, every module found is checked.

Options:
  --provider-dir <dir>  Extra directory to search. May be given more than once.
  --json                Machine-readable output.
  -h, --help            Show this help.`;

export async function runProviderList(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parse(argv, io, PROVIDER_LIST_USAGE);
  if (typeof parsed === 'number') return parsed;
  if (parsed.values.help) {
    io.out(PROVIDER_LIST_USAGE);
    return EXIT_OK;
  }

  const options = discoveryOptionsFrom(io, parsed.values['provider-dir']);
  const modules = await discoverProviders(options);

  if (parsed.values.json) {
    io.out(JSON.stringify(modules.map(summarise), null, 2));
    return EXIT_OK;
  }

  if (modules.length === 0) {
    io.out('No provider modules found. Looked in:');
    for (const entry of providerSearchPath(options)) io.out(`  ${entry.dir}`);
    io.out('');
    io.out('A provider module is a directory containing provider.yaml.');
    return EXIT_OK;
  }

  const width = Math.max(...modules.map((module) => module.id.length));
  for (const module of modules) {
    const status = module.error ? 'BROKEN' : (module.declaration?.status ?? 'unknown');
    const marks = [
      module.hasAdapter ? 'adapter' : '',
      module.warnings.length > 0 ? `${module.warnings.length} warning(s)` : '',
    ]
      .filter((mark) => mark !== '')
      .join(', ');
    io.out(
      `${module.id.padEnd(width)}  ${status.padEnd(13)} ${module.origin.padEnd(5)}  ${module.dir}` +
        (marks ? `  [${marks}]` : ''),
    );
  }

  const broken = modules.filter((module) => module.error);
  if (broken.length > 0) {
    io.out('');
    io.out(`${broken.length} module(s) did not load. Run: omniproxy provider validate`);
  }
  return EXIT_OK;
}

export async function runProviderValidate(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parse(argv, io, PROVIDER_VALIDATE_USAGE);
  if (typeof parsed === 'number') return parsed;
  if (parsed.values.help) {
    io.out(PROVIDER_VALIDATE_USAGE);
    return EXIT_OK;
  }

  const options = discoveryOptionsFrom(io, parsed.values['provider-dir']);
  const wanted = parsed.positionals[0];
  const all = await discoverProviders(options);
  const modules = wanted ? all.filter((module) => module.id === wanted) : all;

  if (wanted && modules.length === 0) {
    io.err(`omniproxy: no provider module "${wanted}"`);
    io.err('Looked in:');
    for (const entry of providerSearchPath(options)) io.err(`  ${entry.dir}`);
    return EXIT_FAILURE;
  }

  if (parsed.values.json) {
    io.out(JSON.stringify(modules.map(summarise), null, 2));
    return modules.some((module) => module.error) ? EXIT_FAILURE : EXIT_OK;
  }

  if (modules.length === 0) {
    io.out('No provider modules found.');
    return EXIT_OK;
  }

  let failed = 0;
  for (const module of modules) {
    io.out(`${module.id}  (${module.file})`);

    if (module.error) {
      failed += 1;
      io.out('  ERROR');
      for (const line of module.error.split('; ')) io.out(`    ${line}`);
    } else {
      io.out(`  ok — status: ${module.declaration?.status}, ` +
        `channels: ${module.declaration?.channels.map((c) => c.id).join(', ')}, ` +
        `models: ${module.declaration?.models.length ?? 0}`);
    }

    for (const warning of module.warnings) io.out(`  warning: ${warning}`);
    io.out('');
  }

  if (failed > 0) {
    io.err(`${failed} of ${modules.length} module(s) did not load.`);
    return EXIT_FAILURE;
  }
  return EXIT_OK;
}

function summarise(module: FoundProvider) {
  return {
    id: module.id,
    origin: module.origin,
    dir: module.dir,
    status: module.declaration?.status ?? null,
    ok: module.error === undefined,
    error: module.error ?? null,
    warnings: module.warnings,
    hasAdapter: module.hasAdapter,
    models: module.declaration?.models.map((model) => model.alias) ?? [],
  };
}

function parse(argv: readonly string[], io: CliIo, usage: string) {
  try {
    return parseArgs({
      args: [...argv],
      options: {
        'provider-dir': { type: 'string', multiple: true },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    io.err(usage);
    return EXIT_USAGE;
  }
}
