import { clearWasmCache } from '@omniproxy/engine-declarative';
import { collectUms } from '@omniproxy/schema';
import { flattenConversation } from '@omniproxy/umr';
import type { DeepSeekSim } from '@omniproxy/provider-sim';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DialectHooks, DialectPlugin, Refusal, RequestPlan } from '../src/dialect.js';
import { resolveRoute, RoutingError } from '../src/router.js';
import type { RunningGateway } from '../src/serve.js';
import { post, REPLY, startHarness, type Harness, type HarnessOptions } from './harness.js';

/**
 * A dialect nobody here wrote.
 *
 * This is the promise of the hackability charter made testable: a protocol we have
 * never heard of is a file, not a fork. The plugin below is the whole of it — under
 * eighty lines, no build step in the gateway, nothing in `server.ts` that knows it
 * exists — and it gets the same routing, the same account pool, the same concurrency
 * gate and the same retry rule as the built-in four.
 *
 * If any of that ever stops being true, these tests are the ones that go red.
 */

let sim: DeepSeekSim | undefined;
let gateway: RunningGateway | undefined;

beforeEach(() => {
  clearWasmCache();
});

afterEach(async () => {
  await gateway?.close();
  await sim?.close();
  gateway = undefined;
  sim = undefined;
});

async function start(options: HarnessOptions = {}): Promise<Harness> {
  const started = await startHarness(options);
  sim = started.sim;
  gateway = started.gateway;
  return started.harness;
}

/* ────────────────────────── a protocol invented for this test ────────────────────────── */

interface PlainRequest {
  model: string;
  text: string;
}

const refuse = (status: number, message: string, action: string): Refusal => ({
  kind: 'refused',
  status,
  body: { problem: message, do: action },
});

/** `POST /say` — a body of `{ model, text }`, an answer as text/plain. */
const plainDialect: DialectHooks<PlainRequest> = {
  name: 'plain',

  plan(body, providers) {
    const request = body as Partial<PlainRequest> | null;
    if (typeof request?.text !== 'string' || request.text === '') {
      return refuse(400, 'no text to say', 'Send { "model": "…", "text": "…" }.');
    }

    try {
      const route = resolveRoute(providers, request.model ?? '');
      const flattened = flattenConversation([
        { role: 'user', content: [{ type: 'text', text: request.text }] },
      ]);
      return {
        kind: 'planned',
        request: { model: request.model ?? '', text: request.text },
        route,
        prompt: flattened.prompt,
        params: {},
        stream: false,
      } satisfies RequestPlan<PlainRequest>;
    } catch (error) {
      if (error instanceof RoutingError) return refuse(error.status, error.message, error.userAction);
      throw error;
    }
  },

  identity: () => ({ id: '', model: '' }),

  async respond({ events, response, settle }) {
    const collected = await collectUms(events);
    settle(collected.error);
    if (collected.error) {
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(collected.error.message);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(collected.text);
  },

  error: (error) => ({ status: 502, body: { problem: error.message, do: error.userAction } }),
  refuse: (status, _kind, message, action) => refuse(status, message, action),
};

const plainPlugin: DialectPlugin = {
  name: 'plain',
  dialect: plainDialect as unknown as DialectHooks<never>,
  paths: ['/say', '/say/models'],
  match: (path, method) => (method === 'POST' && path === '/say' ? {} : undefined),
  side: (request) =>
    request.method === 'GET' && request.path === '/say/models'
      ? { status: 200, body: { can: request.providers.flatMap((p) => p.models.map((m) => m.alias)) } }
      : undefined,
};

/* ─────────────────────────────────── the tests ─────────────────────────────────── */

describe('a dialect the gateway has never heard of', () => {
  it('answers on its own path, over the shared request loop', async () => {
    const harness = await start({ dialects: [plainPlugin] });
    const response = await post(harness, '/say', { model: 'deepseek-chat', text: 'привет' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toBe(REPLY);
  });

  it('reaches the provider with the same prompt the built-in four produce', async () => {
    // The measurable form of §4: the universal layers are shared, so a dialect somebody
    // wrote in an afternoon is not a second-class citizen upstream.
    const harness = await start({ dialects: [plainPlugin] });

    await post(harness, '/say', { model: 'deepseek-chat', text: 'что такое 2+2' });
    const plain = lastPrompt(harness.sim);

    clearWasmCache();
    await post(harness, '/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'что такое 2+2' }],
    });

    expect(plain).toBe(lastPrompt(harness.sim));
  });

  it('uses the account pool, including moving to another account', async () => {
    const harness = await start({
      dialects: [plainPlugin],
      accounts: [
        { id: 'stale', provider: 'deepseek-web', fields: { token: 'expired-token' } },
        { id: 'fresh', provider: 'deepseek-web', fields: { token: 'ds-live-token-9f2a4c6e8b1d3f5a7c9e0b2d4f6a8c0e' } },
      ],
    });

    const response = await post(harness, '/say', { model: 'deepseek-chat', text: 'hi' });
    expect(response.status).toBe(200);
    expect(harness.pool.snapshot().find((entry) => entry.id === 'fresh')?.successes).toBe(1);
  });

  it('refuses in its own words, not in OpenAI-shaped JSON', async () => {
    const harness = await start({ dialects: [plainPlugin] });
    const response = await post(harness, '/say', { model: 'deepseek-chat' });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      problem: 'no text to say',
      do: 'Send { "model": "…", "text": "…" }.',
    });
  });

  it('serves a side endpoint of its own, without touching a provider', async () => {
    const harness = await start({ dialects: [plainPlugin] });
    const body = (await (await fetch(`${harness.gateway.url}/say/models`)).json()) as {
      can: string[];
    };

    expect(body.can).toContain('deepseek-chat');
    expect(harness.sim.requests).toHaveLength(0);
  });

  it('is listed on /health, ahead of the built-ins', async () => {
    const harness = await start({ dialects: [plainPlugin] });
    const body = (await (await fetch(`${harness.gateway.url}/health`)).json()) as {
      dialects: string[];
    };
    expect(body.dialects).toEqual(['plain', 'openai', 'anthropic', 'ollama', 'gemini']);
  });

  it('is named in the 404 that tells a caller what does exist', async () => {
    const harness = await start({ dialects: [plainPlugin] });
    const response = await post(harness, '/nope', {});
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(404);
    expect(JSON.stringify(body)).toContain('/say');
  });

  it('leaves the built-in four working exactly as they were', async () => {
    const harness = await start({ dialects: [plainPlugin] });
    const response = await post(harness, '/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe(REPLY);
  });
});

/* ────────────────────────── taking over a built-in path ────────────────────────── */

describe('a dialect that claims a path we already serve', () => {
  const shadow: DialectPlugin = {
    ...plainPlugin,
    name: 'shadow',
    match: (path, method) => (method === 'POST' && path === '/v1/chat/completions' ? {} : undefined),
  };

  it('wins, because it is your gateway', async () => {
    const harness = await start({ dialects: [shadow] });
    const response = await post(harness, '/v1/chat/completions', {
      model: 'deepseek-chat',
      text: 'привет',
    });

    // The built-in dialect would have refused this body for having no `messages`.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(REPLY);
  });

  it('says so in the log rather than shadowing silently', async () => {
    const harness = await start({ dialects: [shadow] });
    expect(harness.logs.join('\n')).toContain(
      'dialect "shadow" answers /v1/chat/completions instead of the built-in one',
    );
  });
});

/* ─────────────────────── the body a side endpoint already read ─────────────────────── */

describe('a side endpoint that reads the body', () => {
  const nosy: DialectPlugin = {
    ...plainPlugin,
    name: 'nosy',
    // Looks at every body, answers nothing. The completion that follows must still get
    // its own body: a stream consumed here would otherwise arrive empty there, and only
    // when this plugin happened to be mounted.
    side: async (request) => {
      await request.body();
      return undefined;
    },
  };

  it('does not consume the body the request loop needs', async () => {
    const harness = await start({ dialects: [nosy] });
    const response = await post(harness, '/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe(REPLY);
  });
});

function lastPrompt(simulator: DeepSeekSim): string {
  const sends = simulator.requests.filter((entry) => entry.path.endsWith('/chat/completion'));
  return (JSON.parse(sends.at(-1)?.body ?? '{}') as { prompt: string }).prompt;
}
