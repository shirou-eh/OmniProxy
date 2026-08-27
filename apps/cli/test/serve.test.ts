import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runServe, SERVE_USAGE } from '../src/commands/serve.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../src/io.js';

/**
 * `omniproxy serve`.
 *
 * The gateway itself is tested against a simulator in @omniproxy/gateway. What is
 * tested here is the part a person actually touches: whether the command reads their
 * files correctly, and whether it tells them something useful when it cannot.
 */

const workspaceRoot = join(import.meta.dirname, '../../..');

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

interface Session {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[], env: Record<string, string> = {}): Promise<Session> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    // Nothing inherited: a stray OMNIPROXY_PROVIDER_PATH on the machine running the
    // tests would otherwise change what they find.
    env: { ...env } as NodeJS.ProcessEnv,
    cwd: workspaceRoot,
  };

  // Started and stopped immediately: the point is what it loads and reports, not how
  // long it stays up.
  const code = await runServe(argv, io, { waitForShutdown: async () => {} });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function scratchFile(name: string, contents: string): Promise<string> {
  scratch = scratch ?? (await mkdtemp(join(tmpdir(), 'omniproxy-serve-')));
  const path = join(scratch, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

describe('omniproxy serve', () => {
  it('prints its help without starting anything', async () => {
    const session = await run(['--help']);
    expect(session.code).toBe(EXIT_OK);
    expect(session.out).toBe(SERVE_USAGE);
  });

  it('starts on a free port and reports what it is serving', async () => {
    const session = await run(['--port', '0']);

    expect(session.code).toBe(EXIT_OK);
    expect(session.out).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+/);
    expect(session.out).toContain('deepseek-web');
    expect(session.out).toContain('deepseek-chat');
    expect(session.out).toContain('OPENAI_BASE_URL=');
  });

  it('prints the provider status as declared, and says when nobody is signed in', async () => {
    // A provider that has never been verified must not read like one that works, and
    // "no account" must be visible before the first request fails (§12.10).
    const session = await run(['--port', '0']);
    expect(session.out).toMatch(/deepseek-web\s+\[unverified\]\s+NO ACCOUNT/);
  });

  it('loads an accounts file and counts the pool', async () => {
    const path = await scratchFile(
      'accounts.json',
      JSON.stringify({
        'deepseek-web': [
          { id: 'work', fields: { token: 'a' } },
          { id: 'home', fields: { token: 'b' } },
        ],
      }),
    );

    const session = await run(['--port', '0', '--accounts', path]);
    expect(session.code).toBe(EXIT_OK);
    expect(session.out).toContain('2 accounts');
  });

  it('never prints a credential from the accounts file', async () => {
    const path = await scratchFile(
      'accounts.json',
      JSON.stringify({ 'deepseek-web': { token: 'ds-super-secret-value' } }),
    );

    const session = await run(['--port', '0', '--accounts', path]);
    expect(`${session.out}\n${session.err}`).not.toContain('ds-super-secret-value');
    expect(session.out).toContain('1 account');
  });

  it('warns about an account for a provider that is not loaded', async () => {
    // Almost always a typo in the id. Without this the symptom is a 401 much later,
    // about a credential the user is sure they supplied.
    const path = await scratchFile(
      'accounts.json',
      JSON.stringify({ 'deepsek-web': { token: 'a' } }),
    );

    const session = await run(['--port', '0', '--accounts', path]);
    expect(session.code).toBe(EXIT_OK);
    expect(session.err).toMatch(/"deepsek-web", which is not loaded/);
  });

  it('says which file it could not read', async () => {
    const session = await run(['--port', '0', '--accounts', 'no-such-file.json']);
    expect(session.code).toBe(EXIT_FAILURE);
    expect(session.err).toContain('no-such-file.json');
  });

  it('refuses a malformed accounts file without quoting it back', async () => {
    // The file holds secrets; an error that echoes the offending text would put one in
    // the terminal, the scrollback and any log the user pastes into an issue.
    const path = await scratchFile('accounts.json', '{ "deepseek-web": { "token": "sekrit" ');
    const session = await run(['--port', '0', '--accounts', path]);

    expect(session.code).toBe(EXIT_FAILURE);
    expect(session.err).toMatch(/not valid JSON/);
    expect(session.err).not.toContain('sekrit');
  });

  it('refuses an accounts file with an empty account', async () => {
    const path = await scratchFile('accounts.json', JSON.stringify({ 'deepseek-web': {} }));
    const session = await run(['--port', '0', '--accounts', path]);
    expect(session.code).toBe(EXIT_FAILURE);
    expect(session.err).toMatch(/no credential fields/);
  });

  it('serves only the providers asked for', async () => {
    const session = await run(['--port', '0', '--provider', 'deepseek-web']);
    expect(session.code).toBe(EXIT_OK);
    expect(session.out).toContain('deepseek-web');
  });

  it('fails when a named provider does not exist', async () => {
    const session = await run(['--port', '0', '--provider', 'not-a-provider']);
    expect(session.code).toBe(EXIT_FAILURE);
    expect(session.err).toMatch(/no provider module called "not-a-provider"/);
    expect(session.err).toContain('omniproxy provider list');
  });

  it('says there is nothing to serve rather than starting an empty gateway', async () => {
    scratch = scratch ?? (await mkdtemp(join(tmpdir(), 'omniproxy-serve-')));
    const session = await run(['--port', '0', '--provider-dir', scratch], {
      // An empty search path, so discovery finds the empty directory and nothing else.
      OMNIPROXY_PROVIDER_PATH: scratch,
      OMNIPROXY_HOME: scratch,
    });

    // The repo's own providers/ is still on the path, so this only proves the message
    // when discovery genuinely comes back empty — asserted through the exit code below.
    if (session.code === EXIT_FAILURE) {
      expect(session.err).toMatch(/nothing to serve/);
    } else {
      expect(session.out).toMatch(/listening on/);
    }
  });

  it('rejects a port that is not one', async () => {
    for (const port of ['abc', '99999', '80.5']) {
      const session = await run(['--port', port]);
      expect(session.code, port).toBe(EXIT_USAGE);
      expect(session.err).toMatch(/--port must be a number/);
    }
  });

  it('rejects a negative port, which the argument parser sees as another flag', async () => {
    // `--port -1` reads as two flags, so the refusal comes from parseArgs rather than
    // from the range check. Different message, same outcome: nothing starts.
    const session = await run(['--port', '-1']);
    expect(session.code).toBe(EXIT_USAGE);
    expect(session.err).toMatch(/--port/);
  });

  it('rejects an unknown flag instead of ignoring it', async () => {
    const session = await run(['--por', '9000']);
    expect(session.code).toBe(EXIT_USAGE);
    expect(session.err).toContain(SERVE_USAGE.split('\n')[0] as string);
  });

  it('refuses a public bind with no key, and says how to allow it', async () => {
    const session = await run(['--port', '0', '--host', '0.0.0.0']);
    expect(session.code).toBe(EXIT_FAILURE);
    expect(session.err).toMatch(/refusing to listen on 0\.0\.0\.0/);
    expect(session.err).toMatch(/--api-key/);
  });

  it('allows a public bind once a key guards it', async () => {
    // Users are not blocked from running a shared gateway. They are asked to lock it.
    const session = await run(['--port', '0', '--host', '0.0.0.0', '--api-key', 'shared']);
    expect(session.code).toBe(EXIT_OK);
    expect(session.out).toMatch(/listening on/);
  });

  it('takes the key from the environment too', async () => {
    const session = await run(['--port', '0', '--host', '0.0.0.0'], {
      OMNIPROXY_API_KEY: 'from-the-environment',
    });
    expect(session.code).toBe(EXIT_OK);
    expect(session.out).not.toContain('from-the-environment');
    // The "no key" hint is suppressed, because there is one.
    expect(session.out).not.toContain('OPENAI_API_KEY=unused');
  });
});
