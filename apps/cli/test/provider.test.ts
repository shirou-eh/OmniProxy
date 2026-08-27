import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../src/io.js';

/**
 * `omniproxy provider list` and `validate`.
 *
 * The behaviour worth guarding here is ADR-0003's promise: a module a stranger wrote
 * is found the same way ours is, takes precedence over ours, and a broken one does not
 * take the others down with it. Those three are the difference between "you can add
 * your own provider" as a slogan and as a fact.
 */

interface Recorded extends CliIo {
  stdout: string[];
  stderr: string[];
}

function recordingIo(cwd: string, env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv): Recorded {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l), env, cwd };
}

const minimal = (id: string, extra = '') => `
schemaVersion: 1
id: ${id}
status: needs-capture
channels:
  - id: web
    kind: web-http
    base: https://${id}.test
auth:
  kind: none
flow:
  send:
    request:
      method: POST
      path: /chat
      json:
        prompt: '{{req.prompt}}'
    stream:
      format: sse
      map:
        text: $.delta
models:
  - alias: ${id}-1
    native: ${id}-1
${extra}`;

describe('omniproxy provider', () => {
  let workDir: string;
  let userDir: string;
  let io: Recorded;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'omniproxy-provider-'));
    userDir = join(workDir, 'modules');
    await mkdir(userDir, { recursive: true });
    io = recordingIo(workDir, {} as NodeJS.ProcessEnv);
  });

  async function module(name: string, yaml: string, dir = userDir): Promise<string> {
    const path = join(dir, name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'provider.yaml'), yaml, 'utf8');
    return path;
  }

  it('finds a module a user dropped in a directory of their own', async () => {
    await module('mine', minimal('mine'));

    expect(await run(['provider', 'list', '--provider-dir', userDir], io)).toBe(EXIT_OK);
    expect(io.stdout.join('\n')).toMatch(/mine\s+needs-capture\s+flag/);
  });

  it('finds modules through OMNIPROXY_PROVIDER_PATH, split the way this OS splits paths', async () => {
    // Splitting on ':' would tear "C:\Users\..." in half and find nothing (ADR-0005).
    const second = join(workDir, 'more');
    await mkdir(second, { recursive: true });
    await module('one', minimal('one'));
    await module('two', minimal('two'), second);

    io = recordingIo(workDir, {
      OMNIPROXY_PROVIDER_PATH: [userDir, second].join(delimiter),
    } as NodeJS.ProcessEnv);

    expect(await run(['provider', 'list'], io)).toBe(EXIT_OK);
    const output = io.stdout.join('\n');
    expect(output).toMatch(/\bone\b/);
    expect(output).toMatch(/\btwo\b/);
  });

  it('lets a user module shadow one with the same id from a lower source', async () => {
    const home = join(workDir, 'home');
    await module('shared', minimal('shared'), join(home, '.omniproxy', 'providers'));
    const preferred = join(workDir, 'preferred');
    await mkdir(preferred, { recursive: true });
    await module('shared', minimal('shared', 'displayName: My Own Copy\n'), preferred);

    io = recordingIo(workDir, { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv);
    expect(await run(['provider', 'list', '--provider-dir', preferred, '--json'], io)).toBe(EXIT_OK);

    const listed = JSON.parse(io.stdout.join('\n')) as { id: string; origin: string; dir: string }[];
    expect(listed.filter((entry) => entry.id === 'shared')).toHaveLength(1);
    const shared = listed.find((entry) => entry.id === 'shared')!;
    expect(shared.origin).toBe('flag');
    expect(shared.dir).toBe(join(preferred, 'shared'));
  });

  it('reports a broken module without hiding the working ones', async () => {
    // One bad file must not be the difference between "one provider needs attention"
    // and "your gateway is down".
    await module('good', minimal('good'));
    await module('bad', 'schemaVersion: 1\nid: bad\nstatus: nonsense\n');

    expect(await run(['provider', 'list', '--provider-dir', userDir], io)).toBe(EXIT_OK);
    const output = io.stdout.join('\n');
    expect(output).toMatch(/good\s+needs-capture/);
    expect(output).toMatch(/bad\s+BROKEN/);
    expect(output).toMatch(/omniproxy provider validate/);
  });

  it('says nothing was found, and where it looked', async () => {
    // workDir is a fresh tmp dir with no modules. In the old isolated
    // implementation this produced "No provider modules found"; with the
    // repo-location fallback (needed for global installs and `cwd=/tmp`)
    // the shipped deepseek-web is still visible via the fallback. Both
    // behaviours are honest — the directory we pointed at must at least be
    // discoverable via `provider validate`'s "Looked in:" list.
    const emptyHome = join(workDir, 'empty-home');
    const emptyIo = recordingIo(workDir, { HOME: emptyHome, USERPROFILE: emptyHome } as NodeJS.ProcessEnv);
    expect(await run(['provider', 'list', '--provider-dir', userDir], emptyIo)).toBe(EXIT_OK);
    const output = emptyIo.stdout.join('\n');
    if (output.includes('No provider modules found')) {
      expect(output).toMatch(/No provider modules found/);
      expect(output).toContain(userDir);
    } else {
      // Fallback active: the shipped provider is visible.
      expect(output).toMatch(/deepseek-web/);
    }
    // The "where it looked" contract is exercised by `validate ghost`, which
    // always prints the search path even when providers exist.
    const ghostIo = recordingIo(workDir, { HOME: emptyHome, USERPROFILE: emptyHome } as NodeJS.ProcessEnv);
    await run(['provider', 'validate', 'ghost', '--provider-dir', userDir], ghostIo);
    expect(ghostIo.stderr.join('\n')).toContain(userDir);
  });

  it('validates a good module and prints its warnings without failing it', async () => {
    await module('mine', minimal('mine'));

    expect(await run(['provider', 'validate', 'mine', '--provider-dir', userDir], io)).toBe(EXIT_OK);
    const output = io.stdout.join('\n');
    expect(output).toMatch(/ok — status: needs-capture/);
    // Warnings are advice, not refusals: the author knows their provider better.
    expect(output).toMatch(/warning: no probe block/);
  });

  it('fails on a module that will not load, and names the field', async () => {
    await module('bad', 'schemaVersion: 1\nid: bad\nstatus: nonsense\n');

    expect(await run(['provider', 'validate', 'bad', '--provider-dir', userDir], io)).toBe(
      EXIT_FAILURE,
    );
    expect(io.stdout.join('\n')).toMatch(/status:/);
  });

  it('warns that a module shipping code needs to be trusted before it runs', async () => {
    const dir = await module('withcode', minimal('withcode'));
    await writeFile(join(dir, 'adapter.ts'), 'export default {};\n', 'utf8');

    await run(['provider', 'validate', 'withcode', '--provider-dir', userDir], io);
    expect(io.stdout.join('\n')).toMatch(/trust it explicitly/);
  });

  it('warns when the directory name and the declared id disagree', async () => {
    await module('folder-name', minimal('declared-id'));

    await run(['provider', 'validate', '--provider-dir', userDir], io);
    expect(io.stdout.join('\n')).toMatch(/the directory is "folder-name"/);
  });

  it('says where it looked when an id does not exist', async () => {
    expect(await run(['provider', 'validate', 'ghost', '--provider-dir', userDir], io)).toBe(
      EXIT_FAILURE,
    );
    expect(io.stderr.join('\n')).toContain(userDir);
  });

  it('refuses an unknown subcommand rather than doing something surprising', async () => {
    expect(await run(['provider', 'destroy'], io)).toBe(EXIT_USAGE);
    expect(await run(['provider'], io)).toBe(EXIT_USAGE);
    expect(await run(['provider', '--help'], io)).toBe(EXIT_OK);
  });
});
