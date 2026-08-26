#!/usr/bin/env node
import { run } from './cli.js';
import { processIo } from './io.js';

/** Executable entry point. All logic lives in cli.ts so it can be tested in-process. */
run(process.argv.slice(2), processIo())
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`omniproxy: unexpected failure: ${String(error)}\n`);
    process.exitCode = 1;
  });
