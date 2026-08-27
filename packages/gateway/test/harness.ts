import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeclaration } from '@omniproxy/engine-declarative';
import {
  startDeepSeekSim,
  simWasmPath,
  type DeepSeekSim,
  type DeepSeekSimOptions,
} from '@omniproxy/provider-sim';
import type { ProviderDeclaration } from '@omniproxy/schema';
import { fetchHttpClient } from '@omniproxy/transport';
import { AccountPool, type Account } from '../src/accounts.js';
import { ConcurrencyGate } from '../src/gate.js';
import { serve, type RunningGateway } from '../src/serve.js';

/**
 * A real gateway in front of a real simulator, over real sockets.
 *
 * The only substitution anywhere in this harness is the provider's address, so what
 * the tests exercise is the declaration and the code that ship. Shared by the OpenAI
 * and Anthropic suites on purpose: the two dialects are supposed to sit on one request
 * loop, and testing them through separate scaffolding would hide it if they stopped.
 */

const declarationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../providers/deepseek-web/provider.yaml',
);

export const TOKEN = 'ds-live-token-9f2a4c6e8b1d3f5a7c9e0b2d4f6a8c0e';
export const REPLY = 'Привет! Это ответ симулятора. 🌍';

export interface Harness {
  sim: DeepSeekSim;
  gateway: RunningGateway;
  pool: AccountPool;
  gate: ConcurrencyGate;
  logs: string[];
}

export interface HarnessOptions {
  simulator?: DeepSeekSimOptions;
  accounts?: Account[];
  apiKey?: string;
  host?: string;
  concurrency?: number;
  gate?: ConcurrencyGate;
}

export interface Started {
  harness: Harness;
  sim: DeepSeekSim;
  gateway: RunningGateway;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Started> {
  const sim = await startDeepSeekSim({ token: TOKEN, reply: REPLY, ...options.simulator });

  const yaml = await readFile(declarationPath, 'utf8');
  const shipped = parseDeclaration(yaml, { source: 'providers/deepseek-web/provider.yaml' });
  const declaration = {
    ...shipped,
    channels: [
      {
        ...shipped.channels[0]!,
        base: sim.url,
        ...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
      },
    ],
  } as ProviderDeclaration;

  const pool = new AccountPool(
    options.accounts ?? [{ id: 'sim', provider: 'deepseek-web', fields: { token: TOKEN } }],
  );
  const logs: string[] = [];
  const gate = options.gate ?? new ConcurrencyGate();

  const gateway = await serve({
    providers: [declaration],
    accounts: pool,
    gate,
    http: fetchHttpClient(),
    env: { DEEPSEEK_WASM_URL: `${sim.url}${simWasmPath()}` },
    port: 0,
    log: (line) => logs.push(line),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.host ? { host: options.host } : {}),
  });

  return { harness: { sim, gateway, pool, gate, logs }, sim, gateway };
}

export async function post(
  harness: Harness,
  path: string,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${harness.gateway.url}${path}`, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** The `data:` payloads of an SSE response, with any sentinel kept. */
export function sseData(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
}

/** `[eventName, payload]` pairs, for a stream that names its events. */
export function sseEvents(text: string): [string, Record<string, unknown>][] {
  const parsed: [string, Record<string, unknown>][] = [];
  for (const block of text.split('\n\n')) {
    const name = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (name && data) parsed.push([name, JSON.parse(data) as Record<string, unknown>]);
  }
  return parsed;
}
