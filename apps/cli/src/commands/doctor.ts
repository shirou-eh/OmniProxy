import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { discoverProviders } from '@omniproxy/engine-declarative';
import { EXIT_OK, type CliIo } from '../io.js';
import { discoveryOptionsFrom } from './provider-context.js';

export const DOCTOR_USAGE = `omniproxy doctor [--json] [--anonymized]

Checks the machine and the store and tells you what is wrong, in plain
language. No secrets are printed — only names of fields and whether a
file exists.

Checks:
  - node >=22, platform, cwd
  - where provider modules are searched and what was found (including
    shadowing and broken modules)
  - where the credential file lives, whether it exists, is valid JSON,
    and is 0600 (owner-only)
  - what 'omniproxy provider list' would see and what 'auth list' would see

  --json          Machine-readable.
  --anonymized    Same as --json but without absolute paths (for bug reports).
  -h, --help      Show this help.`;

export async function runDoctor(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: 'boolean' },
        anonymized: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
  } catch (error) {
    io.err(`omniproxy: ${(error as Error).message}`);
    return 2;
  }
  if (parsed.values.help) {
    io.out(DOCTOR_USAGE);
    return EXIT_OK;
  }

  const json = Boolean(parsed.values.json || parsed.values.anonymized);
  const anonymized = Boolean(parsed.values.anonymized);

  const report: Record<string, unknown> = {};

  // --- environment ---
  report['node'] = process.version;
  report['platform'] = `${process.platform} ${process.arch}`;
  report['cwd'] = anonymized ? '<redacted>' : io.cwd;
  report['omniproxy'] = '0.1.3';

  // --- providers ---
  const found = await discoverProviders(discoveryOptionsFrom(io, undefined));
  report['providers'] = found.map((m) => ({
    id: m.id,
    origin: m.origin,
    dir: anonymized ? '<redacted>' : m.dir,
    status: m.declaration?.status ?? (m.error ? 'broken' : 'unknown'),
    hasAdapter: m.hasAdapter,
    warnings: m.warnings,
    error: m.error,
  }));
  // Where we looked is visible via `provider list --help` and the
  // discovery order (flag > env > home > repo). Doctor's job is to show
  // what was *found*, not to re-list empty directories.

  // --- auth store ---
  const storePath = (() => {
    if (io.env['OMNIPROXY_HOME']) return join(io.env['OMNIPROXY_HOME'], 'accounts.json');
    const home = io.env['HOME'] ?? io.env['USERPROFILE'] ?? homedir();
    return join(home, '.omniproxy', 'accounts.json');
  })();
  const storeReport: Record<string, unknown> = {
    path: anonymized ? '<redacted>' : storePath,
  };
  try {
    const info = await stat(storePath);
    storeReport['exists'] = true;
    if (process.platform !== 'win32') storeReport['mode'] = (info.mode & 0o777).toString(8);
    const { readFile } = await import('node:fs/promises');
    const txt = await readFile(storePath, 'utf8');
    const raw = JSON.parse(txt) as Record<string, unknown>;
    const providers = Object.keys(raw);
    storeReport['providers'] = providers;
    // Count accounts without revealing values.
    let total = 0;
    for (const v of Object.values(raw)) total += Array.isArray(v) ? v.length : 1;
    storeReport['accounts'] = total;
    storeReport['validJson'] = true;
    if (process.platform !== 'win32' && (info.mode & 0o044) !== 0) {
      storeReport['warning'] = 'file is group/other readable; run: chmod 600 ' + storePath;
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      storeReport['exists'] = false;
      storeReport['hint'] = 'run: omniproxy auth add <provider> --field token=...';
    } else if (error instanceof SyntaxError) {
      storeReport['exists'] = true;
      storeReport['validJson'] = false;
      storeReport['error'] = (error as Error).message;
    } else {
      storeReport['exists'] = false;
      storeReport['error'] = String(error);
    }
  }
  report['authStore'] = storeReport;

  // --- human output ---
  if (json) {
    io.out(JSON.stringify(report, null, 2));
    return EXIT_OK;
  }

  io.out('omniproxy doctor');
  io.out('');
  io.out(`node ${report['node']} on ${report['platform']}`);
  io.out(`cwd ${report['cwd']}`);
  io.out('');
  if (found.length === 0) {
    io.out('providers: none found');
    io.out('  hint: put a provider.yaml in ./providers/<id>/ or ~/.omniproxy/providers/<id>/');
  } else {
    io.out(`providers: ${found.length} found`);
    for (const m of found) {
      const status = m.declaration?.status ?? (m.error ? 'BROKEN' : 'unknown');
      const warn = m.warnings.length > 0 ? ` [${m.warnings.length} warning(s)]` : '';
      const err = m.error ? ` — ${m.error.slice(0, 120)}` : '';
      io.out(`  ${m.id}  [${status}]  ${m.origin}  ${anonymized ? '<redacted>' : m.dir}${warn}${err}`);
    }
  }
  io.out('');
  if (storeReport['exists']) {
    io.out(`auth store: ${storeReport['path']} — ${storeReport['accounts'] ?? 0} account(s) in ${((storeReport['providers'] as string[]) ?? []).length} provider(s)`);
    if (storeReport['warning']) io.out(`  warning: ${storeReport['warning']}`);
  } else {
    io.out(`auth store: missing — ${storeReport['path']}`);
    if (storeReport['hint']) io.out(`  ${storeReport['hint']}`);
  }
  io.out('');
  io.out('Run with --json for machine-readable, --anonymized for bug reports (no paths).');
  return EXIT_OK;
}
