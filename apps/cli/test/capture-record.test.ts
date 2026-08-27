import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearWasmCache } from '@omniproxy/engine-declarative';
import { startDeepSeekSim, simWasmPath, type DeepSeekSim } from '@omniproxy/provider-sim';
import type { CaptureBundle } from '@omniproxy/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../src/io.js';

/**
 * `omniproxy capture record` against a live simulator.
 *
 * The whole capture pipeline used to start with "ask the user for a HAR". This command
 * is the other way in, and it is the one that gets used: it runs the declaration that
 * is actually shipped, against a real socket, and writes a bundle the rest of the
 * pipeline already knows how to read.
 *
 * Two things it must never do, both tested below: write anything unsanitized where it
 * could be shared by accident, and stay silent when the flow fails.
 */

const TOKEN = 'ds-test-token-4f2a9c7e1b3d5086';
const declarationPath = fileURLToPath(
  new URL('../../../providers/deepseek-web/provider.yaml', import.meta.url),
);

interface Recorded extends CliIo {
  stdout: string[];
  stderr: string[];
}

function recordingIo(cwd: string, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv): Recorded {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l), env, cwd };
}

let sim: DeepSeekSim | undefined;
let workDir: string;
let outDir: string;
let io: Recorded;

beforeEach(async () => {
  clearWasmCache();
  workDir = await mkdtemp(join(tmpdir(), 'omniproxy-record-'));
  outDir = join(workDir, 'raw');
  io = recordingIo(workDir, { OMNIPROXY_HOME: join(workDir, 'home') } as NodeJS.ProcessEnv);
});

afterEach(async () => {
  await sim?.close();
  sim = undefined;
});

/** Writes the shipped declaration into a module directory, pointed at the simulator. */
async function moduleFor(simulator: DeepSeekSim): Promise<string> {
  const dir = join(workDir, 'modules', 'deepseek-web');
  await mkdir(dir, { recursive: true });
  const yaml = (await readFile(declarationPath, 'utf8')).replace(
    'base: https://chat.deepseek.com',
    `base: ${simulator.url}`,
  );
  await writeFile(join(dir, 'provider.yaml'), yaml, 'utf8');
  await writeFile(join(workDir, 'auth.json'), JSON.stringify({ token: TOKEN }), 'utf8');
  return join(workDir, 'modules');
}

function recordArgs(modules: string, simulator: DeepSeekSim, extra: string[] = []): string[] {
  return [
    'capture',
    'record',
    'deepseek-web',
    '--provider-dir',
    modules,
    '--auth',
    join(workDir, 'auth.json'),
    '--out',
    outDir,
    '--env',
    `DEEPSEEK_WASM_URL=${simulator.url}${simWasmPath()}`,
    ...extra,
  ];
}

async function onlyBundle(): Promise<CaptureBundle> {
  const files = await readdir(outDir);
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(join(outDir, files[0] as string), 'utf8')) as CaptureBundle;
}

describe('omniproxy capture record', () => {
  it('runs the shipped declaration and writes what crossed the wire', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: 'Привет из симулятора' });
    const modules = await moduleFor(sim);

    expect(await run(recordArgs(modules, sim, ['--prompt', 'скажи привет']), io)).toBe(EXIT_OK);

    const output = io.stdout.join('');
    expect(output).toContain('Привет из симулятора');

    const bundle = await onlyBundle();
    expect(bundle.providerId).toBe('deepseek-web');
    expect(bundle.scenario).toBe('chat-stream');
    expect(bundle.entries.map((entry) => new URL(entry.request.url).pathname)).toEqual([
      '/api/v0/chat/create_pow_challenge',
      '/api/v0/chat_session/create',
      simWasmPath(),
      '/api/v0/chat/completion',
    ]);
    // The prompt reached the provider as written, not as something the CLI decided.
    expect(JSON.parse(bundle.entries[3]!.request.body!).prompt).toBe('скажи привет');
  });

  it('marks the bundle unsanitized and says so out loud', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const modules = await moduleFor(sim);
    await run(recordArgs(modules, sim), io);

    const bundle = await onlyBundle();
    expect(bundle.sanitized).toBe(false);
    expect(JSON.stringify(bundle)).toContain(TOKEN);

    const said = io.stdout.join('\n');
    expect(said).toMatch(/NOT sanitized/);
    expect(said).toMatch(/omniproxy capture sanitize/);
  });

  it('keeps the recording when the flow fails, and fails the command', async () => {
    // A failed run is usually the recording worth having: it is the one that shows
    // what the provider actually said when it stopped working.
    sim = await startDeepSeekSim({ token: TOKEN, failCompletionWith: { attempt: 1, status: 429 } });
    const modules = await moduleFor(sim);

    expect(await run(recordArgs(modules, sim), io)).toBe(EXIT_FAILURE);

    const bundle = await onlyBundle();
    expect(bundle.entries.at(-1)!.response.status).toBe(429);
    expect(bundle.notes.join(' ')).toMatch(/rate_limit/);
    const said = io.stderr.join('\n');
    expect(said).toMatch(/quota|another account|Wait/i);
    expect(said).toMatch(/recording is of that failure/);
  });

  it('explains an expired credential instead of just failing', async () => {
    sim = await startDeepSeekSim({ token: 'a-different-token' });
    const modules = await moduleFor(sim);

    expect(await run(recordArgs(modules, sim), io)).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toMatch(/omniproxy auth add deepseek-web/);
  });

  it('records a declaration file directly, without discovery', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: 'direct' });
    const modules = await moduleFor(sim);
    const file = join(modules, 'deepseek-web', 'provider.yaml');

    expect(
      await run(
        [
          'capture',
          'record',
          '--file',
          file,
          '--auth',
          join(workDir, 'auth.json'),
          '--out',
          outDir,
          '--env',
          `DEEPSEEK_WASM_URL=${sim.url}${simWasmPath()}`,
        ],
        io,
      ),
    ).toBe(EXIT_OK);
    expect(io.stdout.join('')).toContain('direct');
  });

  it('names the credential fields it needs when none are given', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const modules = await moduleFor(sim);

    expect(
      await run(['capture', 'record', 'deepseek-web', '--provider-dir', modules, '--out', outDir], io),
    ).toBe(EXIT_FAILURE);
    const said = io.stderr.join('\n');
    expect(said).toMatch(/needs credentials \(auth\.kind: bearer\)/);
    expect(said).toMatch(/authorization: Bearer \{\{auth\.token\}\}/);
  });

  it('refuses a model the declaration does not have, listing the ones it does', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const modules = await moduleFor(sim);

    expect(await run(recordArgs(modules, sim, ['--model', 'gpt-4o']), io)).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toMatch(/Available: deepseek-chat/);
  });

  it('rejects malformed --env instead of silently ignoring it', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const modules = await moduleFor(sim);

    expect(
      await run(
        ['capture', 'record', 'deepseek-web', '--provider-dir', modules, '--auth', join(workDir, 'auth.json'), '--env', 'BROKEN'],
        io,
      ),
    ).toBe(EXIT_USAGE);
    expect(io.stderr.join('\n')).toMatch(/--env expects K=V/);
  });

  it('says where it looked when the provider does not exist', async () => {
    expect(
      await run(['capture', 'record', 'ghost', '--provider-dir', join(workDir, 'nothing')], io),
    ).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toMatch(/no provider module "ghost"/);
    expect(io.stderr.join('\n')).toMatch(/provider\.yaml/);
  });

  it('needs a provider or a file, and says so', async () => {
    expect(await run(['capture', 'record'], io)).toBe(EXIT_USAGE);
    expect(await run(['capture', 'record', '--help'], io)).toBe(EXIT_OK);
    expect(io.stdout.join('\n')).toMatch(/Nothing is invented here/);
  });

  it('hands the bundle straight to sanitize, which strips the token', async () => {
    // The point of the command: what comes out is an ordinary bundle, and the rest of
    // the pipeline needs no special case for it.
    sim = await startDeepSeekSim({ token: TOKEN, reply: 'chained' });
    const modules = await moduleFor(sim);
    await run(recordArgs(modules, sim), io);

    const files = await readdir(outDir);
    const fixtures = join(workDir, 'fixtures');
    expect(await run(['capture', 'sanitize', join(outDir, files[0] as string), '--out', fixtures], io)).toBe(
      EXIT_OK,
    );

    const written = await readdir(fixtures);
    const fixture = await readFile(join(fixtures, written[0] as string), 'utf8');
    expect(fixture).not.toContain(TOKEN);
    expect(JSON.parse(fixture).sanitized).toBe(true);
  });
});
