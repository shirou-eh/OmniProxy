import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { rawCacheDir, writeRawBundle } from '@omniproxy/capture';
import {
  DeclarationError,
  DeclarationExecutionError,
  defaultTransformContext,
  executeFlow,
  loadDeclarationFile,
  loadProvider,
  memoryStateStore,
  TransformRegistry,
  type ProviderDeclaration,
} from '@omniproxy/engine-declarative';
import { fetchHttpClient, recordingHttpClient, TransportError } from '@omniproxy/transport';
import type { UMSEvent } from '@omniproxy/schema';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../io.js';
import { discoveryOptionsFrom } from './provider-context.js';

export const CAPTURE_RECORD_USAGE = `omniproxy capture record <provider-id> --auth <file.json> [options]

Runs a provider's flow for real and writes down everything that crossed the wire.

This is the command the rest of the pipeline is waiting for. What comes out is an
ordinary capture bundle — the same thing "capture import" produces from a HAR — so
sanitize, analyze and the fixture gate all work on it unchanged.

The bundle is UNSANITIZED. It holds your live cookies and tokens. It is written to the
raw cache with owner-only permissions, never to fixtures/ and never anywhere git can
see it. Run "omniproxy capture sanitize" on it before sharing it with anyone, ever.

Options:
  --auth <file.json>    Credential fields for the provider, as JSON. Required unless
                        the declaration's auth.kind is none.
  --prompt <text>       What to send. Default: a short greeting.
  --model <alias>       Model alias from the declaration. Default: the first one.
  --scenario <name>     Names the recording. Default: chat-stream.
  --file <path>         Record a declaration file directly, ignoring discovery.
  --provider-dir <dir>  Extra directory to search. May be given more than once.
  --out <dir>           Where to write the bundle. Default: ~/.omniproxy/tmp/
  --env <K=V>           Value for {{env.K}} in the declaration. Repeatable.
  -h, --help            Show this help.

Nothing is invented here: the request is exactly what the declaration describes, sent
to exactly the hosts it lists.`;

interface RecordOptions {
  auth?: string;
  prompt?: string;
  model?: string;
  scenario?: string;
  file?: string;
  out?: string;
}

export async function runCaptureRecord(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        auth: { type: 'string' },
        prompt: { type: 'string' },
        model: { type: 'string' },
        scenario: { type: 'string' },
        file: { type: 'string' },
        out: { type: 'string' },
        env: { type: 'string', multiple: true },
        'provider-dir': { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    io.err(CAPTURE_RECORD_USAGE);
    return EXIT_USAGE;
  }

  if (parsed.values.help) {
    io.out(CAPTURE_RECORD_USAGE);
    return EXIT_OK;
  }

  const values = parsed.values as RecordOptions;
  const id = parsed.positionals[0];
  if (!id && !values.file) {
    io.err('omniproxy: name a provider to record, or point at a declaration with --file');
    io.err(CAPTURE_RECORD_USAGE);
    return EXIT_USAGE;
  }

  // ── the declaration ──
  let declaration: ProviderDeclaration;
  try {
    if (values.file) {
      declaration = await loadDeclarationFile(resolve(io.cwd, values.file));
    } else {
      const module = await loadProvider(id as string, discoveryOptionsFrom(io, parsed.values['provider-dir']));
      if (!module.declaration) {
        io.err(`omniproxy: ${module.id} did not load: ${module.error ?? 'unknown error'}`);
        io.err('Run: omniproxy provider validate ' + module.id);
        return EXIT_FAILURE;
      }
      for (const warning of module.warnings) io.err(`warning: ${warning}`);
      declaration = module.declaration;
    }
  } catch (error) {
    if (error instanceof DeclarationError) {
      io.err(`omniproxy: ${error.message}`);
      io.err(error.userAction);
      return EXIT_FAILURE;
    }
    io.err(`omniproxy: ${(error as Error).message}`);
    return EXIT_FAILURE;
  }

  // ── the credentials ──
  let auth: Record<string, unknown> = {};
  if (values.auth) {
    try {
      auth = JSON.parse(await readFile(resolve(io.cwd, values.auth), 'utf8')) as Record<string, unknown>;
    } catch (error) {
      io.err(`omniproxy: could not read ${values.auth}: ${(error as Error).message}`);
      io.err('The file holds the credential fields the declaration presents, as JSON.');
      return EXIT_FAILURE;
    }
  } else if (declaration.auth.kind !== 'none') {
    io.err(`omniproxy: ${declaration.id} needs credentials (auth.kind: ${declaration.auth.kind})`);
    io.err('Pass them with --auth <file.json>. Fields the declaration presents:');
    for (const [name, value] of Object.entries(declaration.auth.present.headers)) {
      io.err(`  ${name}: ${value}`);
    }
    return EXIT_FAILURE;
  }

  const model = values.model ?? declaration.models[0]?.alias;
  if (!model) {
    io.err(`omniproxy: ${declaration.id} declares no models, so there is nothing to send`);
    return EXIT_FAILURE;
  }

  const env: Record<string, string | undefined> = {};
  for (const pair of parsed.values.env ?? []) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      io.err(`omniproxy: --env expects K=V, got "${pair}"`);
      return EXIT_USAGE;
    }
    env[pair.slice(0, separator)] = pair.slice(separator + 1);
  }

  // ── the run ──
  const scenario = values.scenario ?? 'chat-stream';
  const recording = recordingHttpClient(fetchHttpClient(), {
    providerId: declaration.id,
    scenario,
    method: 'cdp',
    source: 'omniproxy capture record',
  });

  const events: UMSEvent[] = [];
  let failure: string | undefined;

  try {
    for await (const event of executeFlow({
      declaration,
      http: recording.client,
      transforms: new TransformRegistry(),
      transformContext: defaultTransformContext(),
      state: memoryStateStore(),
      auth,
      env,
      request: { model, prompt: values.prompt ?? 'Reply with a short greeting.' },
    })) {
      events.push(event);
      if (event.type === 'text.delta') io.out(event.text);
    }
  } catch (error) {
    failure = describeFailure(error, io);
  }

  // ── the bundle, written whether or not the flow succeeded ──
  const bundle = recording.bundle();
  if (bundle.entries.length === 0) {
    io.err('omniproxy: nothing was recorded — the flow failed before its first request.');
    return EXIT_FAILURE;
  }

  if (failure) {
    bundle.notes.push(`the flow failed: ${failure}`);
  }

  const written = await writeRawBundle(bundle, {
    ...(values.out ? { dir: resolve(io.cwd, values.out) } : {}),
  });

  io.out('');
  io.out(`Recorded ${bundle.entries.length} exchange(s) to:`);
  io.out(`  ${written.path}`);
  if (written.prunedFiles > 0) {
    io.out(`  (${written.prunedFiles} expired recording(s) removed from ${rawCacheDir(io.env)})`);
  }
  io.out('');
  io.out('This bundle is NOT sanitized: it contains your live credentials.');
  io.out(`Next:  omniproxy capture sanitize ${written.path}`);

  if (failure) {
    io.err('');
    io.err(`The flow itself failed, and the recording is of that failure — which is`);
    io.err('usually the recording worth having. Analyze it the same way.');
    return EXIT_FAILURE;
  }

  return EXIT_OK;
}

/** Prints what went wrong and what to do, and returns a one-line note for the bundle. */
function describeFailure(error: unknown, io: CliIo): string {
  io.err('');
  if (error instanceof DeclarationExecutionError) {
    io.err(`omniproxy: ${error.omni.message}`);
    io.err(error.omni.userAction);
    return `${error.omni.code}: ${error.message}`;
  }
  if (error instanceof TransportError) {
    io.err(`omniproxy: ${error.message}`);
    io.err(error.userAction);
    return `transport ${error.kind}: ${error.message}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.err(`omniproxy: ${message}`);
  return message;
}
