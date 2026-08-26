import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  FixtureRefused,
  providerFixtureDir,
  sanitizeBundle,
  SanitizeError,
  writeFixture,
} from '@omniproxy/capture';
import { captureBundleSchema, type CaptureBundle } from '@omniproxy/schema';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../io.js';

export const CAPTURE_SANITIZE_USAGE = `omniproxy capture sanitize <bundle.json> [--out <path>]

Strips credentials from a captured bundle and writes it as a fixture.

Cookies, tokens, JWTs, email addresses and credential-shaped values are replaced with
stable placeholders: the same value always becomes the same placeholder, so the shape
of the traffic — which response an id came from, which request used it — survives.
Cookie names, Set-Cookie attributes and authorization schemes are kept, because a
provider declaration has to describe them.

Options:
  --out <path>   Destination file or directory.
                 Default: ~/.omniproxy/providers/<provider>/fixtures/<bundle>.json
  -h, --help     Show this help.

A fixture is refused if anything credential-shaped survives. That check does not
trust the sanitizer's own bookkeeping — it re-reads the finished file.`;

export async function runCaptureSanitize(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    io.err(CAPTURE_SANITIZE_USAGE);
    return EXIT_USAGE;
  }

  if (parsed.values.help) {
    io.out(CAPTURE_SANITIZE_USAGE);
    return EXIT_OK;
  }

  const file = parsed.positionals[0];
  if (!file) {
    io.err('omniproxy: missing the bundle to sanitize');
    io.err(CAPTURE_SANITIZE_USAGE);
    return EXIT_USAGE;
  }

  const path = isAbsolute(file) ? file : resolve(io.cwd, file);

  let bundle: CaptureBundle;
  try {
    const parsedJson: unknown = JSON.parse(await readFile(path, 'utf8'));
    const result = captureBundleSchema.safeParse(parsedJson);
    if (!result.success) {
      io.err(`omniproxy: ${path} is not a capture bundle.`);
      io.err('Import a HAR first: omniproxy capture import <file.har> --provider <id> --scenario <name>');
      return EXIT_FAILURE;
    }
    bundle = result.data;
  } catch (error) {
    io.err(`omniproxy: cannot read ${path}: ${(error as Error).message}`);
    return EXIT_FAILURE;
  }

  let sanitized;
  try {
    sanitized = sanitizeBundle(bundle);
  } catch (error) {
    if (error instanceof SanitizeError) {
      io.err(`omniproxy: ${error.message}`);
      for (const residue of error.residues) {
        io.err(`  ${residue.where}: ${residue.sample}`);
      }
      io.err(error.userAction);
      return EXIT_FAILURE;
    }
    throw error;
  }

  const destination = resolveDestination(parsed.values.out, sanitized.bundle, io);

  try {
    await writeFixture(sanitized.bundle, destination);
  } catch (error) {
    if (error instanceof FixtureRefused) {
      io.err(`omniproxy: ${error.message}`);
      for (const residue of error.residues) {
        io.err(`  ${residue.where}: ${residue.sample}`);
      }
      io.err(error.userAction);
      return EXIT_FAILURE;
    }
    throw error;
  }

  const kinds = Object.entries(sanitized.stats.byKind)
    .map(([kind, count]) => `${count} ${kind}`)
    .sort()
    .join(', ');

  io.out(`Sanitized ${sanitized.bundle.entries.length} entries`);
  io.out(`  redacted  ${sanitized.stats.redactions} value(s)${kinds ? ` — ${kinds}` : ''}`);
  if (sanitized.stats.uninspectedBinaryBodies > 0) {
    io.out(
      `  binary    ${sanitized.stats.uninspectedBinaryBodies} body(ies) were not inspected`,
    );
  }
  io.out(`  written   ${destination}`);
  io.out('');
  io.out('Safe to commit: no credential-shaped value survived the check.');

  return EXIT_OK;
}

function resolveDestination(out: string | undefined, bundle: CaptureBundle, io: CliIo): string {
  if (out === undefined) {
    return join(providerFixtureDir(bundle.providerId, io.env), `${bundle.id}.json`);
  }
  const target = isAbsolute(out) ? out : resolve(io.cwd, out);
  return target.endsWith('.json') ? target : join(target, `${bundle.id}.json`);
}
