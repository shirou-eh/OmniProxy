/**
 * Everything the CLI touches outside itself, in one injectable object.
 *
 * Commands never call `process.exit`, never read `process.env` directly and never
 * write to stdout on their own — they return an exit code and speak through this
 * interface. That is what makes them testable without spawning a process, and it is
 * the same discipline adapters are held to (`AdapterCtx`).
 */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export function processIo(): CliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
  };
}
