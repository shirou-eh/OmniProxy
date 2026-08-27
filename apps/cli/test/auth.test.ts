import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../src/io.js';

interface Recorded extends CliIo {
  stdout: string[];
  stderr: string[];
}

function recordingIo(cwd: string, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv): Recorded {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l), env, cwd };
}

describe('omniproxy auth', () => {
  let workDir: string;
  let storeFile: string;
  let io: Recorded;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'omniproxy-auth-'));
    storeFile = join(workDir, 'accounts.json');
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
  });

  it('adds a single account and writes a 0600 file', async () => {
    expect(await run(['auth', 'add', 'deepseek-web', '--field', 'token=abc', '--file', storeFile], io)).toBe(EXIT_OK);
    expect(io.stdout.join('\n')).toMatch(/stored deepseek-web/);
    expect(io.stdout.join('\n')).toContain(storeFile);

    const raw = JSON.parse(await readFile(storeFile, 'utf8')) as Record<string, unknown>;
    expect(raw['deepseek-web']).toEqual({ token: 'abc' });

    // 0600 on POSIX — on Windows the mode is advisory, but we still create it.
    if (process.platform !== 'win32') {
      const info = await stat(storeFile);
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it('adds a second account under the same provider as a pool', async () => {
    await run(['auth', 'add', 'qwen-web', '--field', 'token=one', '--file', storeFile], io);
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    expect(await run(['auth', 'add', 'qwen-web', '--id', 'work', '--field', 'token=two', '--file', storeFile], io)).toBe(
      EXIT_OK,
    );

    const raw = JSON.parse(await readFile(storeFile, 'utf8')) as Record<string, unknown>;
    const pool = raw['qwen-web'] as unknown[];
    expect(pool).toHaveLength(2);
    expect(pool[0]).toMatchObject({ id: 'qwen-web', fields: { token: 'one' } });
    expect(pool[1]).toMatchObject({ id: 'work', fields: { token: 'two' } });
  });

  it('promotes a single-object entry to a pool on second add', async () => {
    await run(['auth', 'add', 'deepseek-web', '--field', 'token=first', '--file', storeFile], io);
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    await run(['auth', 'add', 'deepseek-web', '--id', 'second', '--field', 'token=second', '--file', storeFile], io);

    const raw = JSON.parse(await readFile(storeFile, 'utf8')) as Record<string, unknown>;
    const arr = raw['deepseek-web'] as unknown[];
    expect(arr).toHaveLength(2);
  });

  it('refuses a duplicate account id', async () => {
    await run(['auth', 'add', 'deepseek-web', '--id', 'dup', '--field', 'token=a', '--file', storeFile], io);
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    expect(await run(['auth', 'add', 'deepseek-web', '--id', 'dup', '--field', 'token=b', '--file', storeFile], io)).toBe(
      EXIT_FAILURE,
    );
    expect(io.stderr.join('\n')).toMatch(/already exists/);
  });

  it('requires at least one --field', async () => {
    expect(await run(['auth', 'add', 'deepseek-web', '--file', storeFile], io)).toBe(EXIT_USAGE);
    expect(io.stderr.join('\n')).toMatch(/at least one --field/);
  });

  it('rejects a --field without =', async () => {
    expect(await run(['auth', 'add', 'deepseek-web', '--field', 'token', '--file', storeFile], io)).toBe(EXIT_USAGE);
    expect(io.stderr.join('\n')).toMatch(/K=V/);
  });

  it('requires a provider id', async () => {
    expect(await run(['auth', 'add', '--field', 'token=x', '--file', storeFile], io)).toBe(EXIT_USAGE);
    expect(io.stderr.join('\n')).toMatch(/needs a provider/);
  });

  it('lists accounts with field names only, never values', async () => {
    await run(['auth', 'add', 'deepseek-web', '--field', 'token=secret123', '--field', 'cookie=abc', '--file', storeFile], io);
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    expect(await run(['auth', 'list', '--file', storeFile], io)).toBe(EXIT_OK);
    const out = io.stdout.join('\n');
    expect(out).toContain('deepseek-web');
    expect(out).toContain('token');
    expect(out).toContain('cookie');
    expect(out).not.toContain('secret123');
    expect(out).not.toContain('abc');
    expect(out).toContain(storeFile);
  });

  it('lists as JSON with id and fields[]', async () => {
    await run(['auth', 'add', 'deepseek-web', '--field', 'token=x', '--file', storeFile], io);
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    expect(await run(['auth', 'list', '--json', '--file', storeFile], io)).toBe(EXIT_OK);
    const listed = JSON.parse(io.stdout.join('\n')) as { provider: string; id: string; fields: string[] }[];
    expect(listed).toHaveLength(1);
    expect(listed[0]!.provider).toBe('deepseek-web');
    expect(listed[0]!.fields).toEqual(['token']);
    // Values must not appear even in JSON.
    expect(JSON.stringify(listed)).not.toContain('x');
  });

  it('says the store is empty when the file does not exist', async () => {
    const missing = join(workDir, 'missing.json');
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    expect(await run(['auth', 'list', '--file', missing], io)).toBe(EXIT_OK);
    expect(io.stdout.join('\n')).toMatch(/no accounts/);
  });

  it('removes a whole provider entry', async () => {
    await run(['auth', 'add', 'deepseek-web', '--field', 'token=a', '--file', storeFile], io);
    await run(['auth', 'add', 'qwen-web', '--field', 'token=b', '--file', storeFile], io);
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    expect(await run(['auth', 'remove', 'deepseek-web', '--file', storeFile], io)).toBe(EXIT_OK);
    const raw = JSON.parse(await readFile(storeFile, 'utf8')) as Record<string, unknown>;
    expect(raw['deepseek-web']).toBeUndefined();
    expect(raw['qwen-web']).toBeDefined();
  });

  it('removes one account from a pool', async () => {
    await run(['auth', 'add', 'deepseek-web', '--field', 'token=a', '--file', storeFile], io);
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    await run(['auth', 'add', 'deepseek-web', '--id', 'second', '--field', 'token=b', '--file', storeFile], io);
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    expect(await run(['auth', 'remove', 'deepseek-web', '--id', 'second', '--file', storeFile], io)).toBe(EXIT_OK);
    const raw = JSON.parse(await readFile(storeFile, 'utf8')) as Record<string, unknown>;
    const arr = raw['deepseek-web'] as unknown[];
    expect(arr).toHaveLength(1);
  });

  it('fails when removing a non-existent provider or id', async () => {
    await run(['auth', 'add', 'deepseek-web', '--field', 'token=a', '--file', storeFile], io);
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    expect(await run(['auth', 'remove', 'ghost', '--file', storeFile], io)).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toMatch(/no entry for "ghost"/);

    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    expect(await run(['auth', 'remove', 'deepseek-web', '--id', 'nope', '--file', storeFile], io)).toBe(
      EXIT_FAILURE,
    );
    expect(io.stderr.join('\n')).toMatch(/no account "nope"/);
  });

  it('prints the store path', async () => {
    const home = join(workDir, 'home');
    await mkdir(join(home, '.omniproxy'), { recursive: true });
    io = recordingIo(workDir, { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv);
    expect(await run(['auth', 'path'], io)).toBe(EXIT_OK);
    expect(io.stdout.join('\n')).toContain(join(home, '.omniproxy', 'accounts.json'));
  });

  it('uses OMNIPROXY_HOME when set', async () => {
    const custom = join(workDir, 'custom');
    io = recordingIo(workDir, { OMNIPROXY_HOME: custom } as NodeJS.ProcessEnv);
    expect(await run(['auth', 'add', 'deepseek-web', '--field', 'token=x'], io)).toBe(EXIT_OK);
    const raw = JSON.parse(await readFile(join(custom, 'accounts.json'), 'utf8')) as Record<string, unknown>;
    expect(raw['deepseek-web']).toBeDefined();
  });

  it('is honest about an invalid existing store', async () => {
    await writeFile(storeFile, '{ not json', 'utf8');
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
    expect(await run(['auth', 'list', '--file', storeFile], io)).toBe(EXIT_FAILURE);
    expect(io.stderr.join('\n')).toMatch(/not valid JSON/);
  });

  it('refuses unknown auth subcommand', async () => {
    expect(await run(['auth', 'dance'], io)).toBe(EXIT_USAGE);
    expect(await run(['auth'], io)).toBe(EXIT_USAGE);
    expect(await run(['auth', '--help'], io)).toBe(EXIT_OK);
  });
});
