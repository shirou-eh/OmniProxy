import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../src/io.js';
import type { CaptureBundle } from '@omniproxy/schema';

const harFixture = fileURLToPath(
  new URL('../../../packages/capture/test/fixtures/devtools-sse.har', import.meta.url),
);

interface Recorded extends CliIo {
  stdout: string[];
  stderr: string[];
}

function recordingIo(cwd: string): Recorded {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    env: {} as NodeJS.ProcessEnv,
    cwd,
  };
}

describe('omniproxy capture import', () => {
  let workDir: string;
  let io: Recorded;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'omniproxy-cli-'));
    io = recordingIo(workDir);
  });

  it('imports a HAR and writes the bundle where it says it does', async () => {
    const outDir = join(workDir, 'out');
    const code = await run(
      ['capture', 'import', harFixture, '--provider', 'example', '--scenario', 'chat-stream', '--out', outDir],
      io,
    );

    expect(code).toBe(EXIT_OK);

    const files = await readdir(outDir);
    expect(files).toEqual(['example-chat-stream-20260827-001000Z.raw.json']);

    const bundle = JSON.parse(await readFile(join(outDir, files[0] as string), 'utf8')) as CaptureBundle;
    expect(bundle.entries).toHaveLength(6);
    expect(bundle.sanitized).toBe(false);

    const output = io.stdout.join('\n');
    expect(output).toContain('Imported 6 entries');
    expect(output).toContain('4 frame(s) reassembled');
    expect(output).toContain('1 connection(s)');
    // The warning is the point of the command, not a footnote.
    expect(output).toContain('NOT sanitized');
  });

  it('surfaces the missing-body warning on stderr instead of burying it', async () => {
    await run(
      ['capture', 'import', harFixture, '--provider', 'example', '--scenario', 'chat-stream', '--out', join(workDir, 'out')],
      io,
    );
    expect(io.stderr.join('\n')).toContain('Save all as HAR with content');
  });

  it('refuses to guess when required options are missing', async () => {
    const code = await run(['capture', 'import', harFixture], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr.join('\n')).toContain('--provider');
    expect(io.stderr.join('\n')).toContain('--scenario');
  });

  it('reports a missing file with the path it actually looked at', async () => {
    const code = await run(
      ['capture', 'import', 'nope.har', '--provider', 'x', '--scenario', 'y'],
      io,
    );
    expect(code).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toContain('nope.har');
  });

  it('explains a file that is not JSON', async () => {
    const bad = join(workDir, 'bad.har');
    await writeFile(bad, 'this is not json');
    const code = await run(['capture', 'import', bad, '--provider', 'x', '--scenario', 'y'], io);
    expect(code).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toContain('not valid JSON');
  });

  it('explains JSON that is not a HAR, with the next step to take', async () => {
    const bad = join(workDir, 'notahar.json');
    await writeFile(bad, '{"hello":"world"}');
    const code = await run(['capture', 'import', bad, '--provider', 'x', '--scenario', 'y'], io);
    expect(code).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toContain('Save all as HAR with content');
  });

  it('accepts a provider id that does not exist yet — that is how your own starts', async () => {
    const code = await run(
      ['capture', 'import', harFixture, '--provider', 'my-cool-image-service', '--scenario', 'generate', '--out', join(workDir, 'out')],
      io,
    );
    expect(code).toBe(EXIT_OK);
    expect(await readdir(join(workDir, 'out'))).toEqual([
      'my-cool-image-service-generate-20260827-001000Z.raw.json',
    ]);
  });
});

describe('omniproxy dispatch', () => {
  const io = recordingIo(process.cwd());

  it('shows usage with no arguments', async () => {
    const local = recordingIo(process.cwd());
    expect(await run([], local)).toBe(EXIT_OK);
    expect(local.stdout.join('\n')).toContain('capture import');
  });

  it('does not advertise commands that do not exist yet', async () => {
    const local = recordingIo(process.cwd());
    await run(['--help'], local);
    const help = local.stdout.join('\n');
    // A CLI that lies about what it can do is the same failure as a gateway that lies
    // about its providers. This list shrinks as commands land; it never grows ahead.
    expect(help).not.toContain('provider init');
    expect(help).not.toContain('omniproxy tenant');
    // `auth add` shipped in 0.1.2 — it must now be advertised.
    expect(help).toContain('auth add');
  });

  it('names what is still under construction rather than implying it exists', async () => {
    const local = recordingIo(process.cwd());
    await run(['--help'], local);
    expect(local.stdout.join('\n')).toMatch(/Under construction/);
  });

  it('rejects an unknown command group', async () => {
    const local = recordingIo(process.cwd());
    expect(await run(['teleport'], local)).toBe(EXIT_USAGE);
    expect(local.stderr.join('\n')).toContain('unknown command');
  });

  it('reports a version', async () => {
    expect(await run(['--version'], io)).toBe(EXIT_OK);
    expect(io.stdout.join('\n')).toMatch(/^omniproxy \d+\.\d+\.\d+ /);
  });
});
