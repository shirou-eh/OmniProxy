import { CAPTURE_ANALYZE_USAGE, runCaptureAnalyze } from './commands/capture-analyze.js';
import { CAPTURE_IMPORT_USAGE, runCaptureImport } from './commands/capture-import.js';
import { CAPTURE_RECORD_USAGE, runCaptureRecord } from './commands/capture-record.js';
import { CAPTURE_SANITIZE_USAGE, runCaptureSanitize } from './commands/capture-sanitize.js';
import { PROVIDER_DRAFT_USAGE, runProviderDraft } from './commands/provider-draft.js';
import { runServe } from './commands/serve.js';
import {
  PROVIDER_LIST_USAGE,
  PROVIDER_VALIDATE_USAGE,
  runProviderList,
  runProviderValidate,
} from './commands/provider.js';
import {
  AUTH_ADD_USAGE,
  AUTH_LIST_USAGE,
  AUTH_PATH_USAGE,
  AUTH_REMOVE_USAGE,
  runAuthAdd,
  runAuthList,
  runAuthPath,
  runAuthRemove,
} from './commands/auth.js';
import { EXIT_OK, EXIT_USAGE, type CliIo } from './io.js';

/**
 * Command dispatch, with no side effects on import — the executable wrapper lives in
 * main.ts. Only commands that actually work are listed. As the pipeline grows this
 * help text grows with it; it will never advertise a command that does not exist yet,
 * because a CLI that lies about its capabilities is the same failure as a gateway that
 * lies about its providers.
 */
export const USAGE = `omniproxy — universal relay for provider web APIs

Usage:
  omniproxy serve [--port <n>] [--host <addr>] [--accounts <file.json>] [--api-key <secret>] [--dialect <path>] [--provider <id>] [--provider-dir <dir>] [--env K=V]

  omniproxy provider list [--provider-dir <dir>] [--json]
  omniproxy provider validate [<id>] [--json]
  omniproxy provider draft <bundle.json> [--out <path>] [--provider <id>]

  omniproxy auth add <provider> [--id <id>] [--field K=V]...
  omniproxy auth list [--json]
  omniproxy auth remove <provider> [--id <id>]
  omniproxy auth path

  omniproxy capture record <provider-id> --auth <file.json> [--prompt <text>] [--model <alias>] [--scenario <name>] [--out <dir>] [--env K=V]
  omniproxy capture import <file.har> --provider <id> --scenario <name> [--out <dir>]
  omniproxy capture sanitize <bundle.json> [--out <path>]
  omniproxy capture analyze <bundle.json> [--compare <other.json>] [--json]

Run a command with --help for its options.

Gateway: OpenAI / Anthropic / Gemini / Ollama — four dialects, plus your own via --dialect.
Under construction: browser-based recorder, probe/doctor, job/media.
See docs/omniproxy/04-phase-1-plan.md for what lands next.`;

const CAPTURE_USAGE = `omniproxy capture — record and prepare provider traffic

  record    Run a provider's flow for real and write down what crossed the wire.
  import    Read a HAR exported from browser DevTools into a capture bundle.
  sanitize  Strip credentials from a bundle and write it as a fixture.
  analyze   Work out what each call does and how values flow between them.

A recorded bundle is unsanitized: it holds live credentials, and it belongs in the
raw cache until "capture sanitize" has been over it.`;

const PROVIDER_USAGE = `omniproxy provider — provider modules

  list      Show every module found, and where it came from.
  validate  Check modules and report errors and warnings.
  draft     Turn an analyzed capture into a provider.yaml draft.

A provider module is a directory containing provider.yaml. Yours are found the same
way ours are, and yours take precedence — see ADR-0003.`;

const AUTH_USAGE = `omniproxy auth — credentials for providers

  add       Store a credential (0600 file at ~/.omniproxy/accounts.json).
  list      Show which providers have accounts (names of fields only).
  remove    Remove a credential.
  path      Print the file that holds the credentials.

The store is a JSON file: { "deepseek-web": { "token": "…" } } or a pool
{ "qwen-web": [{ "id": "work", "fields": { "token": "…" } }] }.
It is created 0600 (owner-only) and never logged. Delete it with
\`rm ~/.omniproxy/accounts.json\` (or OMNIPROXY_HOME/accounts.json).`;

export const VERSION_LINE = 'omniproxy 0.1.2 (gateway: openai/anthropic/gemini/ollama + pluggable dialects + auth store)';

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [group, command, ...rest] = argv;

  if (group === undefined || group === '--help' || group === '-h' || group === 'help') {
    io.out(USAGE);
    return EXIT_OK;
  }

  if (group === '--version' || group === '-v') {
    io.out(VERSION_LINE);
    return EXIT_OK;
  }

  if (group === 'serve') {
    // No subcommand: `omniproxy serve` is the whole thing, and `command` is just its
    // first flag.
    return runServe(command === undefined ? [] : [command, ...rest], io);
  }

  if (group === 'capture') {
    if (command === 'record') return runCaptureRecord(rest, io);
    if (command === 'import') return runCaptureImport(rest, io);
    if (command === 'sanitize') return runCaptureSanitize(rest, io);
    if (command === 'analyze') return runCaptureAnalyze(rest, io);
    if (command === undefined) {
      io.err('omniproxy: capture needs a subcommand');
      io.err(CAPTURE_USAGE);
      return EXIT_USAGE;
    }
    if (command === '--help' || command === '-h') {
      io.out(CAPTURE_USAGE);
      for (const usage of [
        CAPTURE_RECORD_USAGE,
        CAPTURE_IMPORT_USAGE,
        CAPTURE_SANITIZE_USAGE,
        CAPTURE_ANALYZE_USAGE,
      ]) {
        io.out('');
        io.out(usage);
      }
      return EXIT_OK;
    }
    io.err(`omniproxy: unknown capture command "${command}"`);
    io.err(CAPTURE_USAGE);
    return EXIT_USAGE;
  }

  if (group === 'provider') {
    if (command === 'list') return runProviderList(rest, io);
    if (command === 'validate') return runProviderValidate(rest, io);
    if (command === 'draft') return runProviderDraft(rest, io);
    if (command === undefined) {
      io.err('omniproxy: provider needs a subcommand');
      io.err(PROVIDER_USAGE);
      return EXIT_USAGE;
    }
    if (command === '--help' || command === '-h') {
      io.out(PROVIDER_USAGE);
      io.out('');
      io.out(PROVIDER_LIST_USAGE);
      io.out('');
      io.out(PROVIDER_VALIDATE_USAGE);
      io.out('');
      io.out(PROVIDER_DRAFT_USAGE);
      return EXIT_OK;
    }
    io.err(`omniproxy: unknown provider command "${command}"`);
    io.err(PROVIDER_USAGE);
    return EXIT_USAGE;
  }

  if (group === 'auth') {
    if (command === 'add') return runAuthAdd(rest, io);
    if (command === 'list') return runAuthList(rest, io);
    if (command === 'remove' || command === 'rm') return runAuthRemove(rest, io);
    if (command === 'path') return runAuthPath(rest, io);
    if (command === undefined) {
      io.err('omniproxy: auth needs a subcommand');
      io.err(AUTH_USAGE);
      return EXIT_USAGE;
    }
    if (command === '--help' || command === '-h') {
      io.out(AUTH_USAGE);
      io.out('');
      io.out(AUTH_ADD_USAGE);
      io.out('');
      io.out(AUTH_LIST_USAGE);
      io.out('');
      io.out(AUTH_REMOVE_USAGE);
      io.out('');
      io.out(AUTH_PATH_USAGE);
      return EXIT_OK;
    }
    io.err(`omniproxy: unknown auth command "${command}"`);
    io.err(AUTH_USAGE);
    return EXIT_USAGE;
  }

  io.err(`omniproxy: unknown command "${group}"`);
  io.err(USAGE);
  return EXIT_USAGE;
}
