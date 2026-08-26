import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { HarImportError, importHar, rawCacheDir, writeRawBundle } from '@omniproxy/capture';
import type { CaptureBundle } from '@omniproxy/schema';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../io.js';

export const CAPTURE_IMPORT_USAGE = `omniproxy capture import <file.har> --provider <id> --scenario <name>

Imports a HAR file exported from browser DevTools into a capture bundle.

Options:
  --provider <id>    Provider the traffic belongs to. Any id — it does not have to
                     exist yet; this is how a provider of your own starts.
  --scenario <name>  What you did while recording: chat-stream, image-generate, ...
  --out <dir>        Where to write. Defaults to the local raw cache.
  -h, --help         Show this help.

The imported bundle is NOT sanitized: it still contains the cookies and tokens that
were in the traffic. It stays in the local raw cache, is deleted after an hour, and
must never be committed. Sanitization arrives with the next step of the pipeline.`;

export async function runCaptureImport(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        provider: { type: 'string' },
        scenario: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    io.err(CAPTURE_IMPORT_USAGE);
    return EXIT_USAGE;
  }

  if (parsed.values.help) {
    io.out(CAPTURE_IMPORT_USAGE);
    return EXIT_OK;
  }

  const file = parsed.positionals[0];
  const providerId = parsed.values.provider;
  const scenario = parsed.values.scenario;

  const missing: string[] = [];
  if (!file) missing.push('a .har file');
  if (!providerId) missing.push('--provider');
  if (!scenario) missing.push('--scenario');
  if (missing.length > 0 || !file || !providerId || !scenario) {
    io.err(`omniproxy: missing ${missing.join(', ')}`);
    io.err(CAPTURE_IMPORT_USAGE);
    return EXIT_USAGE;
  }

  const path = isAbsolute(file) ? file : resolve(io.cwd, file);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    io.err(`omniproxy: cannot read ${path}: ${(error as Error).message}`);
    io.err('Check the path, or re-export the HAR from the DevTools Network panel.');
    return EXIT_FAILURE;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    io.err(`omniproxy: ${path} is not valid JSON: ${(error as Error).message}`);
    io.err('A HAR file is JSON. Re-export it with "Save all as HAR with content".');
    return EXIT_FAILURE;
  }

  let bundle: CaptureBundle;
  try {
    bundle = importHar(json, { providerId, scenario, source: basename(path) });
  } catch (error) {
    if (error instanceof HarImportError) {
      io.err(`omniproxy: ${error.message}`);
      io.err(error.userAction);
      return EXIT_FAILURE;
    }
    throw error;
  }

  const outDir = parsed.values.out
    ? resolve(io.cwd, parsed.values.out)
    : rawCacheDir(io.env);
  const { path: written, prunedFiles } = await writeRawBundle(bundle, { dir: outDir });

  report(bundle, written, prunedFiles, io);
  return EXIT_OK;
}

function report(bundle: CaptureBundle, written: string, prunedFiles: number, io: CliIo): void {
  const streamed = bundle.entries.filter((e) => (e.response.frames?.length ?? 0) > 0);
  const frames = streamed.reduce((sum, e) => sum + (e.response.frames?.length ?? 0), 0);
  const sockets = bundle.entries.filter((e) => (e.response.webSocketMessages?.length ?? 0) > 0);
  const hosts = new Set(bundle.entries.map((e) => hostOf(e.request.url)));

  io.out(`Imported ${bundle.entries.length} entries from ${bundle.source ?? 'the HAR'}`);
  io.out(`  bundle    ${bundle.id}`);
  io.out(`  captured  ${bundle.capturedAt}`);
  io.out(`  hosts     ${[...hosts].sort().join(', ')}`);
  if (streamed.length > 0) {
    io.out(`  streams   ${streamed.length} response(s), ${frames} frame(s) reassembled`);
  }
  if (sockets.length > 0) {
    io.out(`  websocket ${sockets.length} connection(s)`);
  }
  io.out(`  written   ${written}`);
  if (prunedFiles > 0) {
    io.out(`  pruned    ${prunedFiles} expired capture(s) from the raw cache`);
  }

  for (const note of bundle.notes) {
    io.err(`warning: ${note}`);
  }

  io.out('');
  io.out('This bundle is NOT sanitized — it contains live credentials from the capture.');
  io.out('It expires from the raw cache in an hour. Do not commit it and do not share it.');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
