import { CAPTURE_IMPORT_USAGE, runCaptureImport } from './commands/capture-import.js';
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
  omniproxy capture import <file.har> --provider <id> --scenario <name>

Run a command with --help for its options.

Under construction: the gateway itself, provider modules and the rest of the capture
pipeline. See docs/omniproxy/04-phase-1-plan.md for what lands next.`;

export const VERSION_LINE = 'omniproxy 0.0.0 (phase 1: capture pipeline)';

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

  if (group === 'capture') {
    if (command === 'import') return runCaptureImport(rest, io);
    if (command === undefined) {
      io.err('omniproxy: capture needs a subcommand');
      io.err(CAPTURE_IMPORT_USAGE);
      return EXIT_USAGE;
    }
    if (command === '--help' || command === '-h') {
      io.out(CAPTURE_IMPORT_USAGE);
      return EXIT_OK;
    }
    io.err(`omniproxy: unknown capture command "${command}"`);
    io.err('Available now: import. Recording (capture record) arrives with PR-7.');
    return EXIT_USAGE;
  }

  io.err(`omniproxy: unknown command "${group}"`);
  io.err(USAGE);
  return EXIT_USAGE;
}
