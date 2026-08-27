import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { draftDeclaration } from '@omniproxy/capture';
import { validateDeclaration } from '@omniproxy/engine-declarative';
import { captureBundleSchema } from '@omniproxy/schema';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../io.js';

export const PROVIDER_DRAFT_USAGE = `omniproxy provider draft <bundle.json> [--out <path>]

Turns an analyzed capture into a provider.yaml draft.

This is the last step of onboarding a provider: record, sanitize, analyze, draft. The
draft contains only what the recording showed. Where the recording was silent it says
"TODO(capture)" rather than guessing — a guess and a fact look identical three weeks
later, and that is how a declaration ends up lying about a provider.

The draft comes out with status: needs-capture. Raising it is a decision someone makes
after reading the file and trying it, never a side effect of generating it.

Options:
  --provider <id>   Id for the declaration. Default: the bundle's.
  --name <text>     Display name.
  --out <path>      Write here instead of stdout.
  -h, --help        Show this help.`;

export async function runProviderDraft(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        provider: { type: 'string' },
        name: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    io.err(PROVIDER_DRAFT_USAGE);
    return EXIT_USAGE;
  }

  if (parsed.values.help) {
    io.out(PROVIDER_DRAFT_USAGE);
    return EXIT_OK;
  }

  const file = parsed.positionals[0];
  if (!file) {
    io.err('omniproxy: missing the capture bundle to draft from');
    io.err(PROVIDER_DRAFT_USAGE);
    return EXIT_USAGE;
  }

  const path = resolve(io.cwd, file);
  let bundle;
  try {
    bundle = captureBundleSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    io.err(`omniproxy: could not read ${path}: ${(error as Error).message}`);
    return EXIT_FAILURE;
  }

  if (!bundle.sanitized) {
    // Not fatal — drafting from a raw bundle is a normal thing to do right after
    // recording — but the draft may carry a live value into a file someone commits.
    io.err('warning: this bundle is not sanitized. Check the draft for real credentials');
    io.err('         before saving it anywhere, or run capture sanitize first.');
  }

  const options: Parameters<typeof draftDeclaration>[1] = {};
  if (parsed.values.provider) options.providerId = parsed.values.provider;
  if (parsed.values.name) options.displayName = parsed.values.name;
  if (bundle.sanitized) options.fixturePath = path;

  const draft = draftDeclaration(bundle, options);

  // A draft that does not parse is a bug in the generator, and shipping one would
  // waste the reader's time on our mistake instead of their provider.
  const check = validateDeclaration(draft.yaml, { source: 'the generated draft' });
  if (!check.ok) {
    io.err('omniproxy: the generated draft does not validate. This is a bug in the drafter.');
    for (const error of check.errors) io.err(`  ${error}`);
    io.err('The draft is printed below anyway, so the work is not lost.');
  }

  if (parsed.values.out) {
    const target = resolve(io.cwd, parsed.values.out);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, draft.yaml, 'utf8');
    io.out(`Draft written to ${target}`);
  } else {
    io.out(draft.yaml);
  }

  if (draft.notes.length > 0) {
    io.err('');
    io.err('Inferred, and possibly wrong:');
    for (const note of draft.notes) io.err(`  - ${note}`);
  }

  io.err('');
  io.err('Before this is a provider:');
  for (const todo of draft.todos) io.err(`  - ${todo}`);

  return check.ok ? EXIT_OK : EXIT_FAILURE;
}
