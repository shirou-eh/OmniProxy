import { clearWasmCache } from '@omniproxy/engine-declarative';
import type { DeepSeekSim } from '@omniproxy/provider-sim';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/serve.js';
import {
  post,
  REPLY,
  sseEvents,
  startHarness,
  TOKEN,
  type Harness,
  type HarnessOptions,
} from './harness.js';

/**
 * `POST /v1/messages`, end to end.
 *
 * The same gateway, the same accounts, the same concurrency gate and the same DeepSeek
 * declaration as the OpenAI suite — a different protocol at the edge and nothing else.
 * Several of the assertions below are deliberately about that sameness: if serving a
 * second dialect had needed its own request loop, the universal layers would not be
 * earning their keep.
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

const message = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'deepseek-chat',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Скажи что-нибудь' }],
  ...overrides,
});

async function messages(
  harness: Harness,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return post(harness, '/v1/messages', body, init);
}

/* ────────────────────────────────── the happy path ────────────────────────────────── */

describe('POST /v1/messages', () => {
  it('answers with a Messages-shaped response', async () => {
    const harness = await start();
    const response = await messages(harness, message());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      type: string;
      role: string;
      model: string;
      content: { type: string; text: string }[];
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };

    expect(body.id).toMatch(/^msg_/);
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('deepseek-chat');
    expect(body.content).toEqual([{ type: 'text', text: REPLY }]);
    expect(body.stop_reason).toBe('end_turn');
    expect(body.usage.output_tokens).toBeGreaterThan(0);
  });

  it('streams the same answer as Anthropic events', async () => {
    const harness = await start();
    const response = await messages(harness, message({ stream: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

    const events = sseEvents(await response.text());
    const names = events.map(([name]) => name);

    expect(names[0]).toBe('message_start');
    expect(names.at(-1)).toBe('message_stop');
    expect(names).toContain('content_block_start');
    expect(names).toContain('content_block_stop');

    const text = events
      .filter(([name]) => name === 'content_block_delta')
      .map(([, payload]) => (payload['delta'] as { text?: string }).text ?? '')
      .join('');
    expect(text).toBe(REPLY);
  });

  it('sends the system field and the whole conversation upstream', async () => {
    const harness = await start();
    await messages(
      harness,
      message({
        system: 'Be terse.',
        messages: [
          { role: 'user', content: 'what is 2+2' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'and 3+3' },
        ],
      }),
    );

    const send = harness.sim.requests.find((entry) => entry.path.endsWith('/chat/completion'));
    const prompt = (JSON.parse(send?.body ?? '{}') as { prompt: string }).prompt;
    expect(prompt).toContain('Be terse.');
    expect(prompt).toContain('User: what is 2+2');
    expect(prompt).toContain('Assistant: 4');
    expect(prompt).toContain('User: and 3+3');
  });

  it('produces the same upstream prompt as the OpenAI endpoint would', async () => {
    // The point of the universal layer, asserted rather than assumed: the model sees
    // the same conversation whichever SDK the caller happened to use.
    const harness = await start();

    await messages(
      harness,
      message({
        system: 'Be terse.',
        messages: [
          { role: 'user', content: 'what is 2+2' },
          { role: 'assistant', content: '4' },
        ],
      }),
    );
    const anthropicPrompt = lastPrompt(harness.sim);

    clearWasmCache();
    await post(harness, '/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'what is 2+2' },
        { role: 'assistant', content: '4' },
      ],
    });
    const openAiPrompt = lastPrompt(harness.sim);

    expect(anthropicPrompt).toBe(openAiPrompt);
  });

  it('carries thinking when the caller enables it', async () => {
    const harness = await start({ simulator: { reasoning: 'Считаю…' } });
    const response = await messages(harness, message({ thinking: { type: 'enabled', budget_tokens: 1024 } }));

    const body = (await response.json()) as { content: { type: string; thinking?: string }[] };
    expect(body.content[0]).toEqual({ type: 'thinking', thinking: 'Считаю…' });
    expect(body.content[1]).toMatchObject({ type: 'text' });
  });

  it('leaves thinking out when the caller did not ask for it', async () => {
    const harness = await start({ simulator: { reasoning: 'Считаю…' } });
    const response = await messages(harness, message());
    const body = (await response.json()) as { content: { type: string }[] };
    expect(body.content.every((block) => block.type !== 'thinking')).toBe(true);
  });

  it('opens a fresh upstream session for every request', async () => {
    const harness = await start();
    await messages(harness, message());
    clearWasmCache();
    await messages(harness, message());

    expect(harness.sim.sessions).toHaveLength(2);
    expect(new Set(harness.sim.sessions).size).toBe(2);
  });

  it('accepts the qualified model name', async () => {
    const harness = await start();
    const response = await messages(harness, message({ model: 'deepseek-web/deepseek-chat' }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { model: string }).model).toBe('deepseek-web/deepseek-chat');
  });
});

/* ─────────────────────────────── refusing, informatively ─────────────────────────────── */

describe('requests /v1/messages refuses', () => {
  it('refuses a request with no max_tokens, and says so', async () => {
    const harness = await start();
    const response = await messages(harness, {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toMatch(/max_tokens is required/);
    expect(harness.sim.requests).toHaveLength(0);
  });

  it('uses Anthropic error shapes, not OpenAI ones', async () => {
    // A client parsing `error.type` finds it where its own SDK looks. Serving one
    // dialect's error shape from the other endpoint is the sort of thing that works in
    // a curl test and breaks every real client.
    const harness = await start();
    const response = await messages(harness, message({ model: 'gpt-4o' }));

    expect(response.status).toBe(404);
    const body = (await response.json()) as { type: string; error: { type: string; action: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('not_found_error');
    expect(body.error.action).toContain('deepseek-chat');
  });

  it('rejects a body that is not JSON, in its own words', async () => {
    const harness = await start();
    const response = await messages(harness, 'not json');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { type: string }).type).toBe('error');
  });

  it('rejects a conversation that flattens to nothing', async () => {
    const harness = await start();
    const response = await messages(harness, message({ system: '   ', messages: [{ role: 'user', content: '' }] }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /empty prompt/,
    );
    expect(harness.sim.requests).toHaveLength(0);
  });
});

/* ──────────────────────────────── upstream failures ──────────────────────────────── */

describe('when the provider fails a /v1/messages request', () => {
  it('turns a quota envelope into a 429 with an Anthropic error type', async () => {
    const harness = await start({ simulator: { quotaExhausted: true } });
    const response = await messages(harness, message());

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { type: string; action: string } };
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.action).toMatch(/another|reset/i);
    expect(harness.pool.snapshot()[0]?.available).toBe(false);
  });

  it('fails a streaming request before the first byte with a real status code', async () => {
    const harness = await start({ simulator: { quotaExhausted: true } });
    const response = await messages(harness, message({ stream: true }));

    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('moves to another account, exactly as the OpenAI endpoint does', async () => {
    const harness = await start({
      accounts: [
        { id: 'stale', provider: 'deepseek-web', fields: { token: 'expired-token' } },
        { id: 'fresh', provider: 'deepseek-web', fields: { token: TOKEN } },
      ],
    });

    const response = await messages(harness, message());
    expect(response.status).toBe(200);

    const snapshot = harness.pool.snapshot();
    expect(snapshot.find((entry) => entry.id === 'stale')?.available).toBe(false);
    expect(snapshot.find((entry) => entry.id === 'fresh')?.successes).toBe(1);
  });

  it('honours the same concurrency limit', async () => {
    // One gate, one pool, one loop. Two endpoints must not add up to twice the
    // provider's allowance.
    const harness = await start({ simulator: { frameDelayMs: 5 } });

    const responses = await Promise.all([
      messages(harness, message()),
      post(harness, '/v1/chat/completions', {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect(harness.gate.snapshot()).toEqual([]);
    expect(harness.sim.sessions).toHaveLength(2);
  });
});

/* ────────────────────────────────── access control ────────────────────────────────── */

describe('the proxy API key on /v1/messages', () => {
  it('accepts x-api-key, which is what Anthropic clients send', async () => {
    const harness = await start({ apiKey: 'let-me-in' });
    const response = await messages(harness, message(), { headers: { 'x-api-key': 'let-me-in' } });
    expect(response.status).toBe(200);
  });

  it('accepts Authorization: Bearer too, so either client works', async () => {
    const harness = await start({ apiKey: 'let-me-in' });
    const response = await messages(harness, message(), {
      headers: { authorization: 'Bearer let-me-in' },
    });
    expect(response.status).toBe(200);
  });

  it('refuses a wrong key with an Anthropic authentication error', async () => {
    const harness = await start({ apiKey: 'let-me-in' });
    const response = await messages(harness, message(), { headers: { 'x-api-key': 'nope' } });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
    expect(harness.sim.requests).toHaveLength(0);
  });
});

describe('GET /v1/models, read by both clients', () => {
  it('carries both field sets so neither client gets a surprise', async () => {
    const harness = await start();
    const body = (await (await fetch(`${harness.gateway.url}/v1/models`)).json()) as {
      object: string;
      has_more: boolean;
      data: Record<string, unknown>[];
    };

    expect(body.object).toBe('list');
    expect(body.has_more).toBe(false);
    const entry = body.data[0];
    // OpenAI's names…
    expect(entry?.['object']).toBe('model');
    expect(typeof entry?.['created']).toBe('number');
    // …and Anthropic's, on the same entry. A superset, not a fiction.
    expect(entry?.['type']).toBe('model');
    expect(typeof entry?.['created_at']).toBe('string');
    expect(entry?.['display_name']).toBe(entry?.['id']);
  });
});

function lastPrompt(simulator: DeepSeekSim): string {
  const sends = simulator.requests.filter((entry) => entry.path.endsWith('/chat/completion'));
  return (JSON.parse(sends.at(-1)?.body ?? '{}') as { prompt: string }).prompt;
}
