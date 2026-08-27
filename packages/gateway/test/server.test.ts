import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearWasmCache, parseDeclaration } from '@omniproxy/engine-declarative';
import { startDeepSeekSim, simWasmPath, type DeepSeekSim, type DeepSeekSimOptions } from '@omniproxy/provider-sim';
import type { ProviderDeclaration } from '@omniproxy/schema';
import { fetchHttpClient } from '@omniproxy/transport';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountPool, type Account } from '../src/accounts.js';
import { ConcurrencyGate } from '../src/gate.js';
import { serve, type RunningGateway } from '../src/serve.js';

/**
 * The gateway, end to end, over real sockets.
 *
 * A client speaks OpenAI to a real HTTP server; that server runs the shipped DeepSeek
 * declaration through the engine; the engine talks to a simulator that speaks DeepSeek's
 * web protocol, proof of work and all. Nothing is stubbed between the two ends — the
 * only substitution is the address, so what is exercised here is what ships.
 *
 * As everywhere else in this repo: passing does not mean chat.deepseek.com still
 * behaves this way today. That is a canary question, and the provider's status stays
 * `unverified` because of it (§12.10).
 */

const declarationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../providers/deepseek-web/provider.yaml',
);

const TOKEN = 'ds-live-token-9f2a4c6e8b1d3f5a7c9e0b2d4f6a8c0e';
const REPLY = 'Привет! Это ответ симулятора. 🌍';

let sim: DeepSeekSim | undefined;
let gateway: RunningGateway | undefined;

beforeEach(() => {
  // Process-wide by design; leaving it warm lets one test's WASM download satisfy
  // another's, which is exactly the coupling that makes a suite pass in one order only.
  clearWasmCache();
});

afterEach(async () => {
  await gateway?.close();
  await sim?.close();
  gateway = undefined;
  sim = undefined;
});

interface Harness {
  sim: DeepSeekSim;
  gateway: RunningGateway;
  pool: AccountPool;
  gate: ConcurrencyGate;
  logs: string[];
}

async function start(
  options: {
    simulator?: DeepSeekSimOptions;
    accounts?: Account[];
    apiKey?: string;
    host?: string;
    concurrency?: number;
    gate?: ConcurrencyGate;
  } = {},
): Promise<Harness> {
  sim = await startDeepSeekSim({ token: TOKEN, reply: REPLY, ...options.simulator });

  const yaml = await readFile(declarationPath, 'utf8');
  const shipped = parseDeclaration(yaml, { source: 'providers/deepseek-web/provider.yaml' });
  // Only the address changes. The flow, the extracts, the PoW var, the stream mapping
  // and the error rules are the ones users get.
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

  gateway = await serve({
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

  return { sim, gateway, pool, gate, logs };
}

async function chat(
  harness: Harness,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${harness.gateway.url}/v1/chat/completions`, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** The `data:` payloads of an SSE response, with the sentinel kept. */
function sseData(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length));
}

function streamedText(text: string): string {
  return sseData(text)
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as { choices: { delta: { content?: string } }[] })
    .map((chunk) => chunk.choices[0]?.delta.content ?? '')
    .join('');
}

/* ────────────────────────────────── the happy path ────────────────────────────────── */

describe('POST /v1/chat/completions', () => {
  it('answers a non-streaming request with the provider text', async () => {
    const harness = await start();

    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Скажи что-нибудь' }],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      model: string;
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { total_tokens: number };
    };

    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('deepseek-chat');
    expect(body.choices[0]?.message.content).toBe(REPLY);
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it('streams the same answer as server-sent events', async () => {
    const harness = await start();

    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Скажи что-нибудь' }],
      stream: true,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

    const text = await response.text();
    expect(streamedText(text)).toBe(REPLY);
    expect(sseData(text).at(-1)).toBe('[DONE]');
  });

  it('sends the whole conversation upstream, flattened', async () => {
    // The provider takes a string and keeps its own history. Anything the caller sent
    // that does not reach that string is silently lost context.
    const harness = await start();

    await chat(harness, {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'what is 2+2' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: 'and 3+3' },
      ],
    });

    const send = harness.sim.requests.find((request) => request.path.endsWith('/chat/completion'));
    const prompt = (JSON.parse(send?.body ?? '{}') as { prompt: string }).prompt;
    expect(prompt).toContain('Be terse.');
    expect(prompt).toContain('User: what is 2+2');
    expect(prompt).toContain('Assistant: 4');
    expect(prompt).toContain('User: and 3+3');
  });

  it('opens a fresh upstream session for every request', async () => {
    // Reusing a session across requests is faster and is risk R-6: two callers would
    // share context, and a retry would continue a conversation that had moved on.
    const harness = await start();
    const message = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] };

    await chat(harness, message);
    clearWasmCache();
    await chat(harness, message);

    expect(harness.sim.sessions).toHaveLength(2);
    expect(new Set(harness.sim.sessions).size).toBe(2);
  });

  it('carries reasoning when the model alias asks for it', async () => {
    const harness = await start({ simulator: { reasoning: 'Считаю…' } });

    const response = await chat(harness, {
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'думай' }],
    });

    const body = (await response.json()) as {
      choices: { message: { content: string; reasoning_content?: string } }[];
    };
    expect(body.choices[0]?.message.reasoning_content).toBe('Считаю…');
    expect(body.choices[0]?.message.content).toBe(REPLY);
  });

  it('accepts the qualified model name', async () => {
    const harness = await start();
    const response = await chat(harness, {
      model: 'deepseek-web/deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { model: string }).model).toBe('deepseek-web/deepseek-chat');
  });
});

/* ─────────────────────────────── refusing, informatively ─────────────────────────────── */

describe('requests the gateway refuses', () => {
  it('names the available models when the model is unknown', async () => {
    const harness = await start();
    const response = await chat(harness, {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; action: string } };
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.action).toContain('deepseek-chat');
  });

  it('rejects a body that is not JSON', async () => {
    const harness = await start();
    const response = await chat(harness, 'not json at all');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { action: string } }).error.action).toMatch(
      /Content-Type: application\/json/,
    );
  });

  it('rejects a request with no messages', async () => {
    const harness = await start();
    const response = await chat(harness, { model: 'deepseek-chat', messages: [] });
    expect(response.status).toBe(400);
  });

  it('rejects a conversation that flattens to nothing', async () => {
    // A system-only conversation has no question in it. Sending an empty prompt makes
    // the provider answer something arbitrary, which reads like a bug in the model.
    const harness = await start();
    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: '   ' }],
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { param: string; message: string } };
    expect(body.error.param).toBe('messages');
    expect(body.error.message).toMatch(/empty prompt/);
    expect(harness.sim.requests).toHaveLength(0);
  });

  it('refuses n > 1 rather than quietly returning one completion', async () => {
    const harness = await start();
    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      n: 3,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { param: string } }).error.param).toBe('n');
  });

  it('answers an unknown path with a route list, not a bare 404', async () => {
    const harness = await start();
    const response = await fetch(`${harness.gateway.url}/v1/embeddings`, { method: 'POST' });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { action: string } }).error.action).toContain(
      '/v1/chat/completions',
    );
  });
});

/* ──────────────────────────────── upstream failures ──────────────────────────────── */

describe('when the provider fails', () => {
  it('turns a quota envelope into a 429 with something to do about it', async () => {
    const harness = await start({ simulator: { quotaExhausted: true } });

    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string; action: string } };
    expect(body.error.code).toBe('quota_exhausted');
    expect(body.error.action).toMatch(/another|reset/i);

    // And the account is rested, so the next request does not spend another message
    // proving the same thing.
    expect(harness.pool.snapshot()[0]?.available).toBe(false);
  });

  it('moves to another account when the first one is refused', async () => {
    const harness = await start({
      accounts: [
        { id: 'stale', provider: 'deepseek-web', fields: { token: 'expired-token' } },
        { id: 'fresh', provider: 'deepseek-web', fields: { token: TOKEN } },
      ],
    });

    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { choices: { message: { content: string } }[] })
      .choices[0]?.message.content).toBe(REPLY);

    const snapshot = harness.pool.snapshot();
    expect(snapshot.find((entry) => entry.id === 'stale')?.available).toBe(false);
    expect(snapshot.find((entry) => entry.id === 'fresh')?.successes).toBe(1);
    expect(harness.logs.join('\n')).toMatch(/trying another account/);
  });

  it('reports the failure when there is nowhere left to move', async () => {
    const harness = await start({
      accounts: [{ id: 'stale', provider: 'deepseek-web', fields: { token: 'expired-token' } }],
    });

    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; action: string } };
    expect(body.error.code).toBe('auth_expired');
    expect(body.error.action).toMatch(/omniproxy auth add deepseek-web/);
  });

  it('says which file to fix when no account is configured at all', async () => {
    const harness = await start({ accounts: [] });

    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; action: string } };
    expect(body.error.code).toBe('auth_missing');
    expect(body.error.action).toContain('deepseek-web');
    expect(harness.sim.requests).toHaveLength(0);
  });

  it('fails a streaming request before the first byte with a real status code', async () => {
    // Nothing has been written yet, so the honest answer is a 429 — not a 200 carrying
    // an error the client has to dig out of a chunk.
    const harness = await start({ simulator: { quotaExhausted: true } });

    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('reports a 429 from the provider as a rate limit', async () => {
    const harness = await start({ simulator: { failCompletionWith: { attempt: 1, status: 429 } } });

    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limit');
  });
});

/* ──────────────────────────────── the other endpoints ──────────────────────────────── */

describe('GET /v1/models', () => {
  it('lists every alias, qualified and bare', async () => {
    const harness = await start();
    const response = await fetch(`${harness.gateway.url}/v1/models`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; data: { id: string }[] };
    const ids = body.data.map((entry) => entry.id);

    expect(body.object).toBe('list');
    expect(ids).toContain('deepseek-chat');
    expect(ids).toContain('deepseek-web/deepseek-reasoner');
  });

  it('offers only names that actually resolve', async () => {
    const harness = await start();
    const body = (await (await fetch(`${harness.gateway.url}/v1/models`)).json()) as {
      data: { id: string }[];
    };

    for (const entry of body.data) {
      const response = await chat(harness, {
        model: entry.id,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(response.status, `model ${entry.id}`).not.toBe(404);
      await response.arrayBuffer();
      clearWasmCache();
    }
  });
});

describe('GET /health', () => {
  it('reports the provider status as declared, without dressing it up', async () => {
    const harness = await start();
    const body = (await (await fetch(`${harness.gateway.url}/health`)).json()) as {
      status: string;
      providers: { id: string; status: string; accounts: number }[];
    };

    expect(body.status).toBe('ok');
    expect(body.providers[0]?.id).toBe('deepseek-web');
    expect(body.providers[0]?.status).toBe('unverified');
    expect(body.providers[0]?.accounts).toBe(1);
  });

  it('never puts a credential in the response (§12.7)', async () => {
    const harness = await start();
    const text = await (await fetch(`${harness.gateway.url}/health`)).text();

    expect(text).not.toContain(TOKEN);
    expect(text).toContain('"fields":["token"]');
  });

  it('needs no API key, so a health check still works when the key is wrong', async () => {
    const harness = await start({ apiKey: 'secret' });
    expect((await fetch(`${harness.gateway.url}/health`)).status).toBe(200);
  });
});

/* ────────────────────────────────── access control ────────────────────────────────── */

describe('the proxy API key', () => {
  it('refuses a request without it', async () => {
    const harness = await start({ apiKey: 'let-me-in' });
    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'invalid_api_key',
    );
  });

  it('refuses a wrong one, including one that is merely a prefix', async () => {
    const harness = await start({ apiKey: 'let-me-in' });
    for (const key of ['wrong', 'let-me-i', 'let-me-in-too']) {
      const response = await chat(
        harness,
        { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
        { headers: { authorization: `Bearer ${key}` } },
      );
      expect(response.status, key).toBe(401);
      await response.arrayBuffer();
    }
  });

  it('accepts the right one', async () => {
    const harness = await start({ apiKey: 'let-me-in' });
    const response = await chat(
      harness,
      { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] },
      { headers: { authorization: 'Bearer let-me-in' } },
    );
    expect(response.status).toBe(200);
  });

  it('never reaches a provider with an unauthenticated request', async () => {
    const harness = await start({ apiKey: 'let-me-in' });
    await chat(harness, { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
    expect(harness.sim.requests).toHaveLength(0);
  });
});

describe('CORS', () => {
  it('echoes a loopback origin', async () => {
    const harness = await start();
    const response = await fetch(`${harness.gateway.url}/v1/models`, {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });

  it('does not echo anybody else', async () => {
    // A wildcard here would let any page on the internet spend the user's accounts
    // through their own machine.
    const harness = await start();
    const response = await fetch(`${harness.gateway.url}/v1/models`, {
      headers: { origin: 'https://evil.test' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe(null);
  });

  it('answers a preflight without touching a provider', async () => {
    const harness = await start();
    const response = await fetch(`${harness.gateway.url}/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5173' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(harness.sim.requests).toHaveLength(0);
  });
});

/* ────────────────────────────── the declared concurrency ────────────────────────────── */

describe('channels[].concurrency', () => {
  it('serializes requests against one account when the declaration says one', async () => {
    // The DeepSeek channel declares `concurrency: 1`. Before the gate existed the
    // declaration said so and nothing enforced it — three simultaneous requests all
    // went out, which is how a web chat answers one of them wrongly or bans the
    // account.
    const harness = await start({ simulator: { frameDelayMs: 5 } });
    const message = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] };

    const responses = await Promise.all([
      chat(harness, message),
      chat(harness, message),
      chat(harness, message),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(((await response.json()) as { choices: { message: { content: string } }[] })
        .choices[0]?.message.content).toBe(REPLY);
    }

    // Three answers, three sessions, and never two completions overlapping.
    expect(harness.sim.sessions).toHaveLength(3);
    expect(maxOverlap(harness.sim)).toBe(1);
  });

  it('runs the declared number at once when the declaration allows more', async () => {
    const harness = await start({ concurrency: 3, simulator: { frameDelayMs: 5 } });
    const message = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] };

    const responses = await Promise.all([
      chat(harness, message),
      chat(harness, message),
      chat(harness, message),
    ]);

    for (const response of responses) expect(response.status).toBe(200);
    for (const response of responses) await response.arrayBuffer();
    expect(maxOverlap(harness.sim)).toBeGreaterThan(1);
  });

  it('lets two accounts work at the same time', async () => {
    // A per-provider limit would make a second account pointless. This is per account.
    const harness = await start({
      simulator: { frameDelayMs: 5 },
      accounts: [
        { id: 'one', provider: 'deepseek-web', fields: { token: TOKEN } },
        { id: 'two', provider: 'deepseek-web', fields: { token: TOKEN } },
      ],
    });
    const message = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] };

    const responses = await Promise.all([chat(harness, message), chat(harness, message)]);
    for (const response of responses) expect(response.status).toBe(200);
    for (const response of responses) await response.arrayBuffer();

    expect(maxOverlap(harness.sim)).toBe(2);
    // One request each, rather than both landing on the same account.
    const snapshot = harness.pool.snapshot();
    expect(snapshot.map((entry) => entry.successes).sort()).toEqual([1, 1]);
  });

  it('gives the slot back when the request fails, not only when it succeeds', async () => {
    // A slot lost on the error path is an account that looks permanently busy — the
    // failure this whole gate exists to prevent, arriving by the back door.
    const harness = await start({ simulator: { quotaExhausted: true } });

    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(response.status).toBe(429);
    await response.arrayBuffer();

    expect(harness.gate.snapshot()).toEqual([]);
  });

  it('gives the slot back after a stream has finished', async () => {
    const harness = await start();
    const response = await chat(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    await response.text();

    expect(harness.gate.snapshot()).toEqual([]);
  });

  it('refuses, with something to do about it, when the queue is full', async () => {
    // Accepting a request that will not be served for minutes is worse than saying so.
    const harness = await start({
      gate: new ConcurrencyGate({ maxQueue: 1 }),
      simulator: { frameDelayMs: 20 },
    });
    const message = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] };

    const responses = await Promise.all([
      chat(harness, message),
      chat(harness, message),
      chat(harness, message),
    ]);

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 200, 429]);

    const refused = responses.find((response) => response.status === 429);
    const body = (await refused?.json()) as { error: { code: string; action: string } };
    expect(body.error.code).toBe('rate_limit');
    expect(body.error.action).toMatch(/Add another account|fewer at once/);

    // Our queue being full is not the account's fault, and it is not rested for it.
    expect(harness.pool.snapshot()[0]?.available).toBe(true);

    for (const response of responses) await response.arrayBuffer().catch(() => {});
  });
});

/**
 * The largest number of completion requests the simulator ever had open at once.
 *
 * Reconstructed from its request log rather than measured with a timer, so the
 * assertion is about what actually happened and not about how fast the machine is.
 */
function maxOverlap(sim: DeepSeekSim): number {
  // The simulator records a request when it arrives and the gateway holds its slot for
  // the whole response, so counting sessions created between two completions would be
  // indirect. Counting how many completions began before the previous one's session
  // was created is what actually distinguishes serialized from parallel.
  const marks = sim.requests.map((request) =>
    request.path.endsWith('/chat/completion') ? 1 : request.path.endsWith('/chat_session/create') ? -1 : 0,
  );

  let open = 0;
  let peak = 0;
  for (const mark of marks) {
    if (mark === -1) open += 1;
    if (mark === 1) {
      peak = Math.max(peak, open);
      open -= 1;
    }
  }
  return peak;
}
