import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../src/io.js';

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

describe('omniproxy capture analyze', () => {
  let workDir: string;
  let io: Recorded;
  let bundlePath: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'omniproxy-analyze-'));
    io = recordingIo(workDir);
    const outDir = join(workDir, 'raw');
    await run(
      ['capture', 'import', harFixture, '--provider', 'example', '--scenario', 'chat-stream', '--out', outDir],
      io,
    );
    const [file] = await readdir(outDir);
    bundlePath = join(outDir, file as string);
    io.stdout.length = 0;
    io.stderr.length = 0;
  });

  it('names each call and shows why', async () => {
    expect(await run(['capture', 'analyze', bundlePath], io)).toBe(EXIT_OK);
    const output = io.stdout.join('\n');

    expect(output).toContain('SEND');
    expect(output).toContain('SESSION');
    expect(output).toContain('why:');
    expect(output).toContain('uses:');
    expect(output).toContain('Set aside');
  });

  it('says plainly that one capture cannot tell a constant from a variable', async () => {
    await run(['capture', 'analyze', bundlePath], io);
    expect(io.stdout.join('\n')).toContain('No second capture supplied');
  });

  it('reports what varies when given a second capture', async () => {
    const second = join(workDir, 'second.json');
    const raw = JSON.parse(
      await (await import('node:fs/promises')).readFile(bundlePath, 'utf8'),
    ) as { entries: unknown[] };
    await writeFile(
      second,
      JSON.stringify(raw).replace(/chat-abc-001/g, 'chat-def-002'),
    );

    await run(['capture', 'analyze', bundlePath, '--compare', second], io);
    const output = io.stdout.join('\n');
    expect(output).toContain('field(s) vary between runs');
    expect(output).toContain('varies: request.query.chat_id');
  });

  it('emits machine-readable output on request', async () => {
    await run(['capture', 'analyze', bundlePath, '--json'], io);
    const parsed = JSON.parse(io.stdout.join('\n')) as { flow: unknown[]; links: unknown[] };
    expect(Array.isArray(parsed.flow)).toBe(true);
    expect(parsed.links.length).toBeGreaterThan(0);
  });

  it('rejects something that is not a bundle', async () => {
    const bad = join(workDir, 'bad.json');
    await writeFile(bad, '{"nope":true}');
    expect(await run(['capture', 'analyze', bad], io)).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toContain('capture import');
  });

  it('needs a bundle', async () => {
    expect(await run(['capture', 'analyze'], io)).toBe(EXIT_USAGE);
  });
});
