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

function recordingIo(cwd: string, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv): Recorded {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    env,
    cwd,
  };
}

describe('omniproxy capture sanitize', () => {
  let workDir: string;
  let io: Recorded;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'omniproxy-sanitize-'));
    io = recordingIo(workDir, { OMNIPROXY_HOME: join(workDir, 'home') } as NodeJS.ProcessEnv);
  });

  async function importFixture(): Promise<string> {
    const outDir = join(workDir, 'raw');
    await run(
      ['capture', 'import', harFixture, '--provider', 'example', '--scenario', 'chat-stream', '--out', outDir],
      io,
    );
    const [file] = await readdir(outDir);
    return join(outDir, file as string);
  }

  it('turns an imported bundle into a fixture in the provider module layout', async () => {
    const raw = await importFixture();
    io.stdout.length = 0;

    const code = await run(['capture', 'sanitize', raw], io);
    expect(code).toBe(EXIT_OK);

    const fixtureDir = join(workDir, 'home', 'providers', 'example', 'fixtures');
    const files = await readdir(fixtureDir);
    expect(files).toEqual(['example-chat-stream-20260827-001000Z.json']);

    const fixture = JSON.parse(
      await readFile(join(fixtureDir, files[0] as string), 'utf8'),
    ) as CaptureBundle;
    expect(fixture.sanitized).toBe(true);
    // The session cookies from the capture are gone; their names survive.
    const raw2 = JSON.stringify(fixture);
    expect(raw2).not.toContain('s-1234');
    expect(raw2).toContain('session_id={{redacted:cookie:');

    expect(io.stdout.join('\n')).toContain('Safe to commit');
  });

  it('honours an explicit output path', async () => {
    const raw = await importFixture();
    const target = join(workDir, 'custom', 'my-fixture.json');

    expect(await run(['capture', 'sanitize', raw, '--out', target], io)).toBe(EXIT_OK);
    expect(await readdir(join(workDir, 'custom'))).toEqual(['my-fixture.json']);
  });

  it('treats a directory --out as a directory', async () => {
    const raw = await importFixture();
    const target = join(workDir, 'fixtures-dir');

    expect(await run(['capture', 'sanitize', raw, '--out', target], io)).toBe(EXIT_OK);
    expect(await readdir(target)).toEqual(['example-chat-stream-20260827-001000Z.json']);
  });

  it('reports what it redacted', async () => {
    const raw = await importFixture();
    io.stdout.length = 0;
    await run(['capture', 'sanitize', raw], io);
    expect(io.stdout.join('\n')).toMatch(/redacted\s+\d+ value\(s\)/);
  });

  it('rejects a file that is not a capture bundle', async () => {
    const notABundle = join(workDir, 'nope.json');
    await writeFile(notABundle, '{"hello":"world"}');

    const code = await run(['capture', 'sanitize', notABundle], io);
    expect(code).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toContain('capture import');
  });

  it('reports a missing file', async () => {
    const code = await run(['capture', 'sanitize', join(workDir, 'ghost.json')], io);
    expect(code).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toContain('cannot read');
  });

  it('needs a bundle to work on', async () => {
    const code = await run(['capture', 'sanitize'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr.join('\n')).toContain('missing the bundle');
  });

  it('is listed in the top-level help now that it exists', async () => {
    const local = recordingIo(workDir);
    await run(['--help'], local);
    expect(local.stdout.join('\n')).toContain('capture sanitize');
  });
});
