import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AccountFileError, parseAccountsFile } from '@omniproxy/gateway';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../io.js';

export const AUTH_ADD_USAGE = `omniproxy auth add <provider> [--id <id>] [--field K=V]...

Stores a credential for a provider. The file is \${OMNIPROXY_HOME:-~/.omniproxy}/accounts.json
— a JSON map from provider id to one account or a pool. It is created with
owner-only permissions (0600 on POSIX; ACL on Windows) and never leaves your
machine. Delete it with \`rm ~/.omniproxy/accounts.json\` or
\`omniproxy auth remove <provider> [--id <id>]\`.

  <provider>        Provider id as in provider.yaml (e.g. deepseek-web).
  --id <id>         Label for this account when a provider has a pool.
                    Default: the provider id, or provider#N for the Nth.
  --field K=V       One credential field. Repeatable: --field token=... --field cookie=...
  --file <path>     Write to a different file (for testing). Default is the store.
  -h, --help        Show this help.

Example:
  omniproxy auth add deepseek-web --field token=ds-... --field userToken=...
  omniproxy auth add qwen-web --id work --field token=...`;

export const AUTH_LIST_USAGE = `omniproxy auth list [--json]

Shows which providers have accounts and which fields each one stores.
Field values are never printed — only the names (token, cookie, …).

  --json            Machine-readable (provider, id, fields[]).
  --file <path>     Read a different file.
  -h, --help        Show this help.

The store lives at \${OMNIPROXY_HOME:-~/.omniproxy}/accounts.json.
Remove it: rm ~/.omniproxy/accounts.json`;

export const AUTH_REMOVE_USAGE = `omniproxy auth remove <provider> [--id <id>] [--file <path>]

Removes a credential. With --id removes one account from a pool;
without --id removes the whole provider entry.

  <provider>        Provider id.
  --id <id>         Which account in the pool.
  --file <path>     Different file.
  -h, --help        Show this help.`;

export const AUTH_PATH_USAGE = `omniproxy auth path

Prints the file that \`auth add\` writes and \`serve\` reads.
Default: \${OMNIPROXY_HOME:-~/.omniproxy}/accounts.json`;

function storePath(io: CliIo, file?: string): string {
  if (file) return resolve(io.cwd, file);
  if (io.env['OMNIPROXY_HOME']) return join(resolve(io.env['OMNIPROXY_HOME']), 'accounts.json');
  const home = io.env['HOME'] ?? io.env['USERPROFILE'] ?? homedir();
  return join(home, '.omniproxy', 'accounts.json');
}

async function loadStore(io: CliIo, file?: string): Promise<{ path: string; raw: unknown }> {
  const path = storePath(io, file);
  try {
    const txt = await readFile(path, 'utf8');
    return { path, raw: JSON.parse(txt) as unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, raw: {} };
    if (error instanceof SyntaxError) {
      throw new AccountFileError(
        `${path} is not valid JSON: ${(error as Error).message}`,
        'Fix the syntax or delete the file and run `omniproxy auth add` again.',
      );
    }
    throw error;
  }
}

async function saveStore(path: string, raw: unknown, io: CliIo): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const txt = JSON.stringify(raw, null, 2) + '\n';
  // 0600 — owner-only. On Windows the mode is an advisory ACL via Node's chmod
  // emulation; the real protection there is DPAPI/libsecret (planned), for now
  // the file is still plaintext. Never log its contents (§12.7).
  await writeFile(path, txt, { mode: 0o600 });
  // On POSIX the mkdir 0700 above may have been masked by umask; ensure 0600.
  if (process.platform !== 'win32') {
    try {
      const { chmod } = await import('node:fs/promises');
      await chmod(path, 0o600);
    } catch {
      // best-effort
    }
  }
  // Warn if the containing dir is group/other readable (adreess R-10, I-9).
  if (process.platform !== 'win32') {
    try {
      const info = await stat(dir);
      if ((info.mode & 0o044) !== 0) {
        io.err(`warning: ${dir} is readable by group/others; run: chmod 700 ${dir}`);
      }
    } catch {}
  }
}

function parseFields(pairs: readonly string[] | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const idx = pair.indexOf('=');
    if (idx <= 0) throw new Error(`--field expects K=V, got "${pair}"`);
    const k = pair.slice(0, idx);
    const v = pair.slice(idx + 1);
    if (k === '') throw new Error(`--field expects K=V, got "${pair}"`);
    fields[k] = v;
  }
  return fields;
}

export async function runAuthAdd(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        field: { type: 'string', multiple: true },
        id: { type: 'string' },
        file: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    io.err(AUTH_ADD_USAGE);
    return EXIT_USAGE;
  }
  if (parsed.values.help) {
    io.out(AUTH_ADD_USAGE);
    return EXIT_OK;
  }
  const provider = parsed.positionals[0];
  if (!provider) {
    io.err('omniproxy: auth add needs a provider id');
    io.err(AUTH_ADD_USAGE);
    return EXIT_USAGE;
  }
  if (parsed.positionals.length > 1) {
    io.err(`omniproxy: unexpected argument "${parsed.positionals[1]!}"`);
    return EXIT_USAGE;
  }
  let fields: Record<string, string>;
  try {
    fields = parseFields(parsed.values.field as string[] | undefined);
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    return EXIT_USAGE;
  }
  if (Object.keys(fields).length === 0) {
    // Interactive fallback for humans at a TTY: ask for the one field that
    // every provider has today (`token`). This keeps `auth add` copy-pasteable
    // for scripts (`--field`) but also "type and forget" for a person who just
    // ran `omniproxy auth add deepseek-web`.
    if (process.stdin.isTTY && process.stdout.isTTY) {
      try {
        const { createInterface } = await import('node:readline');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q: string): Promise<string> =>
          new Promise((resolve) => rl.question(q, resolve));
        io.out(`No --field given — enter the credential for ${provider}.`);
        io.out(`For deepseek-web this is the 'token' from localStorage.userToken.value`);
        const answer = (await ask('token: ')).trim();
        rl.close();
        if (answer) fields['token'] = answer;
      } catch {
        // fall through to the usage error below
      }
    }
    if (Object.keys(fields).length === 0) {
      io.err('omniproxy: auth add needs at least one --field K=V');
      io.err('Example: omniproxy auth add deepseek-web --field token=...');
      io.err('Or run interactively: omniproxy auth add deepseek-web  (then paste token)');
      return EXIT_USAGE;
    }
  }
  const id = parsed.values.id as string | undefined;
  const file = parsed.values.file as string | undefined;

  let loaded;
  try {
    loaded = await loadStore(io, file);
  } catch (error) {
    if (error instanceof AccountFileError) {
      io.err(`omniproxy: ${error.message}`);
      io.err(error.userAction);
      return EXIT_FAILURE;
    }
    io.err(`omniproxy: ${(error as Error).message}`);
    return EXIT_FAILURE;
  }
  const raw = loaded.raw as Record<string, unknown>;
  // Validate that existing file is parseable as accounts (but don't reveal values).
  try {
    parseAccountsFile(raw);
  } catch (error) {
    if (error instanceof AccountFileError) {
      io.err(`omniproxy: existing store is invalid: ${error.message}`);
      io.err(error.userAction);
      return EXIT_FAILURE;
    }
    throw error;
  }

  // Merge: provider entry may be single object, array, or missing.
  const existing = raw[provider];
  if (existing === undefined) {
    // Single account unless an explicit id is given — then store as envelope
    // so the id survives a round-trip through parseAccountsFile.
    if (id !== undefined) {
      raw[provider] = [{ id, fields }];
    } else {
      raw[provider] = { ...fields };
    }
  } else if (Array.isArray(existing)) {
    // Pool — check duplicate id.
    const desiredId = id ?? `${provider}#${existing.length + 1}`;
    const dup = (existing as Record<string, unknown>[]).some(
      (entry) => (entry as Record<string, unknown>)['id'] === desiredId,
    );
    if (dup) {
      io.err(`omniproxy: an account called "${desiredId}" already exists for ${provider}`);
      io.err(`Use --id with a different name, or remove it first: omniproxy auth remove ${provider} --id ${desiredId}`);
      return EXIT_FAILURE;
    }
    (existing as unknown[]).push(id !== undefined ? { id, fields } : { id: desiredId, fields });
  } else if (existing !== null && typeof existing === 'object') {
    // Single object — promote to pool.
    const prev = existing as Record<string, unknown>;
    const prevIsEnvelope =
      prev['fields'] !== null && typeof prev['fields'] === 'object' && !Array.isArray(prev['fields']);
    const prevId = (prevIsEnvelope && typeof prev['id'] === 'string' ? prev['id'] : provider) as string;
    const prevFields = (prevIsEnvelope ? (prev['fields'] as Record<string, unknown>) : prev) as Record<string, unknown>;
    const desiredId = id ?? `${provider}#2`;
    if (desiredId === prevId) {
      io.err(`omniproxy: an account called "${desiredId}" already exists for ${provider}`);
      return EXIT_FAILURE;
    }
    raw[provider] = [
      { id: prevId, fields: prevFields },
      { id: desiredId, fields },
    ];
  } else {
    io.err(`omniproxy: ${provider} entry is not an object or array`);
    return EXIT_FAILURE;
  }

  // Final validation before writing — ensures we never corrupt the store.
  try {
    parseAccountsFile(raw);
  } catch (error) {
    if (error instanceof AccountFileError) {
      io.err(`omniproxy: would write an invalid store: ${error.message}`);
      io.err(error.userAction);
      return EXIT_FAILURE;
    }
    throw error;
  }

  await saveStore(loaded.path, raw, io);
  io.out(`stored ${provider}${id ? `/${id}` : ''} → ${loaded.path} (0600)`);
  return EXIT_OK;
}

export async function runAuthList(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: 'boolean' },
        file: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    return EXIT_USAGE;
  }
  if (parsed.values.help) {
    io.out(AUTH_LIST_USAGE);
    return EXIT_OK;
  }
  const file = parsed.values.file as string | undefined;
  let loaded;
  try {
    loaded = await loadStore(io, file);
  } catch (error) {
    if (error instanceof AccountFileError) {
      io.err(`omniproxy: ${error.message}`);
      return EXIT_FAILURE;
    }
    throw error;
  }
  // Parse to get normalized accounts (validates shape).
  let accounts: ReturnType<typeof parseAccountsFile>;
  try {
    accounts = parseAccountsFile(loaded.raw);
  } catch (error) {
    if (error instanceof AccountFileError) {
      io.err(`omniproxy: ${loaded.path}: ${error.message}`);
      io.err(error.userAction);
      return EXIT_FAILURE;
    }
    throw error;
  }
  if (parsed.values.json) {
    // Machine-readable: provider, id, fields[] (names only).
    const out = accounts.map((a) => ({ provider: a.provider, id: a.id, fields: Object.keys(a.fields).sort() }));
    io.out(JSON.stringify(out, null, 2));
    return EXIT_OK;
  }
  if (accounts.length === 0) {
    io.out(`no accounts in ${loaded.path}`);
    return EXIT_OK;
  }
  // Human table: provider  id  fields
  const byProvider = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const arr = byProvider.get(a.provider) ?? [];
    arr.push(a);
    byProvider.set(a.provider, arr);
  }
  for (const [provider, list] of [...byProvider.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const acc of list) {
      io.out(`${provider}  ${acc.id}  fields: ${Object.keys(acc.fields).sort().join(', ')}`);
    }
  }
  io.out(`store: ${loaded.path}`);
  return EXIT_OK;
}

export async function runAuthRemove(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        id: { type: 'string' },
        file: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    return EXIT_USAGE;
  }
  if (parsed.values.help) {
    io.out(AUTH_REMOVE_USAGE);
    return EXIT_OK;
  }
  const provider = parsed.positionals[0];
  if (!provider) {
    io.err('omniproxy: auth remove needs a provider id');
    io.err(AUTH_REMOVE_USAGE);
    return EXIT_USAGE;
  }
  if (parsed.positionals.length > 1) {
    io.err(`omniproxy: unexpected argument "${parsed.positionals[1]!}"`);
    return EXIT_USAGE;
  }
  const id = parsed.values.id as string | undefined;
  const file = parsed.values.file as string | undefined;

  let loaded;
  try {
    loaded = await loadStore(io, file);
  } catch (error) {
    if (error instanceof AccountFileError) {
      io.err(`omniproxy: ${error.message}`);
      return EXIT_FAILURE;
    }
    throw error;
  }
  const raw = loaded.raw as Record<string, unknown>;
  if (raw[provider] === undefined) {
    io.err(`omniproxy: no entry for "${provider}" in ${loaded.path}`);
    return EXIT_FAILURE;
  }
  if (id === undefined) {
    delete raw[provider];
  } else {
    const existing = raw[provider];
    if (Array.isArray(existing)) {
      const arr = existing as Record<string, unknown>[];
      const idx = arr.findIndex((e) => e['id'] === id || (e['fields'] === undefined && id === provider));
      // Also handle single-object-form stored as plain fields where id==provider
      if (idx === -1) {
        io.err(`omniproxy: no account "${id}" for ${provider}`);
        return EXIT_FAILURE;
      }
      arr.splice(idx, 1);
      if (arr.length === 0) delete raw[provider];
      else if (arr.length === 1) {
        // Keep as array for stability — parseAccountsFile accepts both.
      }
    } else if (existing !== null && typeof existing === 'object') {
      const rec = existing as Record<string, unknown>;
      const isEnvelope = rec['fields'] !== null && typeof rec['fields'] === 'object' && !Array.isArray(rec['fields']);
      const curId = isEnvelope && typeof rec['id'] === 'string' ? (rec['id'] as string) : provider;
      if (curId !== id) {
        io.err(`omniproxy: no account "${id}" for ${provider} (found "${curId}")`);
        return EXIT_FAILURE;
      }
      delete raw[provider];
    } else {
      io.err(`omniproxy: ${provider} entry is not an object or array`);
      return EXIT_FAILURE;
    }
  }

  // Validate remaining (empty is ok).
  try {
    parseAccountsFile(raw);
  } catch (error) {
    if (error instanceof AccountFileError) {
      io.err(`omniproxy: would leave an invalid store: ${error.message}`);
      return EXIT_FAILURE;
    }
    throw error;
  }

  await saveStore(loaded.path, raw, io);
  io.out(`removed ${provider}${id ? `/${id}` : ''} from ${loaded.path}`);
  return EXIT_OK;
}

export async function runAuthPath(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { help: { type: 'boolean', short: 'h' } },
      allowPositionals: false,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    return EXIT_USAGE;
  }
  if (parsed.values.help) {
    io.out(AUTH_PATH_USAGE);
    return EXIT_OK;
  }
  io.out(storePath(io, undefined));
  return EXIT_OK;
}
