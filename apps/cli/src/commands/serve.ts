import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { discoverProviders, type ProviderDeclaration } from '@omniproxy/engine-declarative';
import {
  AccountFileError,
  AccountPool,
  listModelIds,
  parseAccountsFile,
  serve,
  ServeError,
  type Account,
  type RunningGateway,
} from '@omniproxy/gateway';
import { fetchHttpClient } from '@omniproxy/transport';
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type CliIo } from '../io.js';
import { discoveryOptionsFrom } from './provider-context.js';

export const SERVE_USAGE = `omniproxy serve [options]

Starts the gateway in front of every provider module found. It speaks several client
protocols at once, over the same accounts and the same providers.

  POST /v1/chat/completions                    OpenAI Chat Completions
  POST /v1/messages                            Anthropic Messages
  POST /v1beta/models/<model>:generateContent  Gemini (and :streamGenerateContent)
  POST /api/chat, /api/generate                Ollama (NDJSON, streaming by default)
  GET  /v1/models, /v1beta/models, /api/tags   every alias, qualified and bare
  GET  /health                                 what is loaded, and how accounts are doing

Streaming and non-streaming on all four. Point any client at it:

  OPENAI_BASE_URL=http://127.0.0.1:8787/v1       OPENAI_API_KEY=unused
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787       ANTHROPIC_API_KEY=unused
  GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787   GEMINI_API_KEY=unused
  OLLAMA_HOST=http://127.0.0.1:8787

The key, when you set one, is accepted as Authorization: Bearer, x-api-key,
x-goog-api-key or ?key= — whichever your client sends.

Options:
  --port <n>            Default: 8787.
  --host <addr>         Default: 127.0.0.1. A non-loopback address needs --api-key.
  --accounts <file>     Credentials, as JSON. Default: ~/.omniproxy/accounts.json
  --api-key <secret>    Require it from callers. Also read from OMNIPROXY_API_KEY.
  --provider <id>       Serve only this provider. May be given more than once.
  --provider-dir <dir>  Extra directory to search. May be given more than once.
  --env <K=V>           Value for {{env.K}} in a declaration. Repeatable.
  -h, --help            Show this help.

The accounts file maps a provider id to its credentials, and holds either one account
or a pool:

  {
    "deepseek-web": { "token": "…" },
    "qwen-web": [
      { "id": "work",     "fields": { "token": "…" } },
      { "id": "personal", "fields": { "token": "…" } }
    ]
  }

A request tries one account and moves to the next only if the first fails before the
provider has started answering. Nothing in that file is ever logged or returned.`;

/** Injected so the command is testable without a signal handler. */
export interface ServeHooks {
  waitForShutdown?(io: CliIo): Promise<void>;
}

export async function runServe(
  argv: readonly string[],
  io: CliIo,
  hooks: ServeHooks = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        accounts: { type: 'string' },
        'api-key': { type: 'string' },
        provider: { type: 'string', multiple: true },
        'provider-dir': { type: 'string', multiple: true },
        env: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    io.err(SERVE_USAGE);
    return EXIT_USAGE;
  }

  if (parsed.values.help) {
    io.out(SERVE_USAGE);
    return EXIT_OK;
  }

  const port = parsePort(parsed.values.port as string | undefined);
  if (port === undefined) {
    io.err(`omniproxy: --port must be a number between 0 and 65535`);
    return EXIT_USAGE;
  }

  // ── the providers ──
  const found = await discoverProviders(discoveryOptionsFrom(io, parsed.values['provider-dir']));
  const wanted = parsed.values.provider as string[] | undefined;

  const providers: ProviderDeclaration[] = [];
  for (const module of found) {
    if (wanted && wanted.length > 0 && !wanted.includes(module.id)) continue;
    if (!module.declaration) {
      // Named, not swallowed, and not fatal: one broken module must not take the
      // working ones down with it.
      io.err(`warning: ${module.id} did not load and will not be served: ${module.error}`);
      continue;
    }
    for (const warning of module.warnings) io.err(`warning: ${module.id}: ${warning}`);
    providers.push(module.declaration);
  }

  if (wanted) {
    for (const id of wanted) {
      if (!providers.some((provider) => provider.id === id)) {
        io.err(`omniproxy: no provider module called "${id}"`);
        io.err('Run: omniproxy provider list');
        return EXIT_FAILURE;
      }
    }
  }

  if (providers.length === 0) {
    io.err('omniproxy: no provider modules were found, so there is nothing to serve');
    io.err('Run "omniproxy provider list" to see where it looked.');
    return EXIT_FAILURE;
  }

  // ── the accounts ──
  let accounts: Account[];
  try {
    accounts = await loadAccounts(io, parsed.values.accounts as string | undefined);
  } catch (error) {
    if (error instanceof AccountFileError) {
      io.err(`omniproxy: ${error.message}`);
      io.err(error.userAction);
      return EXIT_FAILURE;
    }
    io.err(`omniproxy: ${(error as Error).message}`);
    return EXIT_FAILURE;
  }

  for (const account of accounts) {
    if (!providers.some((provider) => provider.id === account.provider)) {
      // Worth saying out loud: an account for a provider that is not loaded is almost
      // always a typo in the id, and the symptom would otherwise be a 401 much later.
      io.err(`warning: the accounts file has "${account.provider}", which is not loaded`);
    }
  }

  const pool = new AccountPool(accounts);
  const apiKey = (parsed.values['api-key'] as string | undefined) ?? io.env['OMNIPROXY_API_KEY'];

  // ── the socket ──
  let gateway: RunningGateway;
  try {
    gateway = await serve({
      providers,
      accounts: pool,
      http: fetchHttpClient(),
      env: { ...io.env, ...parseEnvPairs(parsed.values.env as string[] | undefined) },
      port,
      log: (line) => io.err(line),
      ...(parsed.values.host ? { host: parsed.values.host as string } : {}),
      ...(apiKey ? { apiKey } : {}),
    });
  } catch (error) {
    if (error instanceof ServeError) {
      io.err(`omniproxy: ${error.message}`);
      io.err(error.userAction);
      return EXIT_FAILURE;
    }
    io.err(`omniproxy: ${(error as Error).message}`);
    return EXIT_FAILURE;
  }

  report(io, gateway, providers, pool, apiKey !== undefined);

  try {
    await (hooks.waitForShutdown ?? waitForSignal)(io);
  } finally {
    await gateway.close();
  }

  return EXIT_OK;
}

/* ──────────────────────────────────── reporting ──────────────────────────────────── */

function report(
  io: CliIo,
  gateway: RunningGateway,
  providers: readonly ProviderDeclaration[],
  pool: AccountPool,
  keyed: boolean,
): void {
  io.out(`omniproxy listening on ${gateway.url}`);
  io.out('');

  for (const provider of providers) {
    const accounts = pool.size(provider.id);
    const needsAccount = provider.auth.kind !== 'none';
    // The status is printed exactly as the declaration states it. A provider nobody has
    // verified against the live service must not look like one that works (§12.10).
    const account = !needsAccount
      ? 'no account needed'
      : accounts === 0
        ? 'NO ACCOUNT — requests to it will fail'
        : `${accounts} account${accounts === 1 ? '' : 's'}`;
    io.out(`  ${provider.id}  [${provider.status}]  ${account}`);
  }

  io.out('');
  io.out(`  models: ${listModelIds(providers).join(', ')}`);
  io.out('');
  io.out(`  OPENAI_BASE_URL=${gateway.url}/v1`);
  io.out(`  ANTHROPIC_BASE_URL=${gateway.url}`);
  io.out(`  GOOGLE_GEMINI_BASE_URL=${gateway.url}`);
  io.out(`  OLLAMA_HOST=${gateway.url}`);
  if (!keyed) {
    io.out('  ..._API_KEY=unused   (the gateway is on loopback and asks for no key)');
  }
  io.out('');
  io.out('Press Ctrl-C to stop.');
}

/* ──────────────────────────────────── plumbing ──────────────────────────────────── */

async function loadAccounts(io: CliIo, file: string | undefined): Promise<Account[]> {
  const path = file
    ? resolve(io.cwd, file)
    : join(io.env['OMNIPROXY_HOME'] ?? join(homedir(), '.omniproxy'), 'accounts.json');

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (file) {
      throw new AccountFileError(
        `could not read ${file}: ${(error as Error).message}`,
        'Point --accounts at a JSON file mapping a provider id to its credentials.',
      );
    }
    // No default file is not an error: a gateway with no accounts still serves
    // /health and /v1/models, and says exactly what is missing when asked for a chat.
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AccountFileError(
      `${path} is not valid JSON: ${(error as Error).message}`,
      'Fix the syntax. Nothing from this file is printed, so the error cannot say more.',
    );
  }

  return parseAccountsFile(parsed);
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return 8787;
  if (!/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 0 && port <= 65535 ? port : undefined;
}

function parseEnvPairs(pairs: readonly string[] | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const index = pair.indexOf('=');
    if (index > 0) env[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return env;
}

async function waitForSignal(io: CliIo): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (signal: string): void => {
      io.err(`\nomniproxy: ${signal}, shutting down`);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve();
    };
    const onInt = (): void => stop('SIGINT');
    const onTerm = (): void => stop('SIGTERM');
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
  });
}
