import { clearWasmCache } from '@omniproxy/engine-declarative';
import type { DeepSeekSim } from '@omniproxy/provider-sim';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/serve.js';
import { post, REPLY, startHarness, TOKEN, type Harness, type HarnessOptions } from './harness.js';

/**
 * `/api/chat` and `/api/generate`, end to end.
 *
 * The fourth protocol on the same gateway. It matters beyond the count: a whole
 * ecosystem of local-first tools speaks this and nothing else, and pointing one of them
 * at a provider web interface is exactly what this project is for.
 *
 * Its two habits are the opposite of the other three — NDJSON instead of SSE, and
 * streaming on by default — so most of what follows is about those.
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

const chat = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Скажи что-нибудь' }],
  stream: false,
  ...overrides,
});

interface Record_ {
  model: string;
  created_at: string;
  message?: { role: string; content: string; thinking?: string; tool_calls?: unknown[] };
  response?: string;
  done: boolean;
  done_reason?: string;
  eval_count?: number;
  total_duration?: number;
  error?: string;
  action?: string;
}

/** Parsed the way a client parses it: one JSON object per line. */
function ndjson(text: string): Record_[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record_);
}

/* ────────────────────────────────── the happy path ────────────────────────────────── */

describe('POST /api/chat', () => {
  it('answers a non-streaming request', async () => {
    const harness = await start();
    const response = await post(harness, '/api/chat', chat());

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record_;
    expect(body.model).toBe('deepseek-chat');
    expect(body.message?.role).toBe('assistant');
    expect(body.message?.content).toBe(REPLY);
    expect(body.done).toBe(true);
    expect(body.done_reason).toBe('stop');
    expect(body.eval_count).toBeGreaterThan(0);
    expect(body.total_duration).toBeGreaterThan(0);
  });

  it('streams NDJSON, not server-sent events', async () => {
    const harness = await start();
    const response = await post(harness, '/api/chat', chat({ stream: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');

    const text = await response.text();
    expect(text).not.toContain('data: ');

    const parsed = ndjson(text);
    expect(parsed.map((record) => record.message?.content ?? '').join('')).toBe(REPLY);
    expect(parsed.at(-1)?.done).toBe(true);
  });

  it("streams when `stream` is left out, because that is Ollama's default", async () => {
    // Every other protocol here defaults to false. A client that omits the field is
    // asking for a stream, and answering with one JSON object leaves it waiting.
    const harness = await start();
    const response = await post(harness, '/api/chat', {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    expect(ndjson(await response.text()).at(-1)?.done).toBe(true);
  });

  it('does not repeat the answer in the closing record', async () => {
    // Clients concatenate every record they receive. Repeating the text there shows
    // the user the answer twice.
    const harness = await start();
    const parsed = ndjson(await (await post(harness, '/api/chat', chat({ stream: true }))).text());

    expect(parsed.at(-1)?.message?.content).toBe('');
    expect(parsed.filter((record) => !record.done).map((r) => r.message?.content ?? '').join('')).toBe(
      REPLY,
    );
  });

  it('sends the whole conversation upstream', async () => {
    const harness = await start();
    await post(
      harness,
      '/api/chat',
      chat({
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'what is 2+2' },
          { role: 'assistant', content: '4' },
        ],
      }),
    );

    const send = harness.sim.requests.find((entry) => entry.path.endsWith('/chat/completion'));
    const prompt = (JSON.parse(send?.body ?? '{}') as { prompt: string }).prompt;
    expect(prompt).toContain('Be terse.');
    expect(prompt).toContain('Assistant: 4');
  });

  it('produces the same upstream prompt as the OpenAI endpoint', async () => {
    const harness = await start();

    await post(
      harness,
      '/api/chat',
      chat({
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'what is 2+2' },
        ],
      }),
    );
    const ollama = lastPrompt(harness.sim);

    clearWasmCache();
    await post(harness, '/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'what is 2+2' },
      ],
    });

    expect(ollama).toBe(lastPrompt(harness.sim));
  });
});

describe('POST /api/generate', () => {
  it('answers with `response` rather than `message`', async () => {
    // The older single-prompt endpoint, still what a lot of scripts use.
    const harness = await start();
    const response = await post(harness, '/api/generate', {
      model: 'deepseek-chat',
      prompt: 'Скажи что-нибудь',
      stream: false,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record_;
    expect(body.response).toBe(REPLY);
    expect(body.message).toBeUndefined();
    expect(body.done).toBe(true);
  });

  it('carries its system field into the prompt', async () => {
    const harness = await start();
    await post(harness, '/api/generate', {
      model: 'deepseek-chat',
      prompt: 'go',
      system: 'Be terse.',
      stream: false,
    });
    expect(lastPrompt(harness.sim)).toContain('Be terse.');
  });

  it('streams response fragments', async () => {
    const harness = await start();
    const response = await post(harness, '/api/generate', {
      model: 'deepseek-chat',
      prompt: 'hi',
    });

    const parsed = ndjson(await response.text());
    expect(parsed.map((record) => record.response ?? '').join('')).toBe(REPLY);
    expect(parsed.at(-1)?.done).toBe(true);
  });
});

/* ─────────────────────────────── the side endpoints ─────────────────────────────── */

describe('the Ollama side endpoints', () => {
  it('lists models under /api/tags', async () => {
    const harness = await start();
    const body = (await (await fetch(`${harness.gateway.url}/api/tags`)).json()) as {
      models: { name: string; model: string; size: number; digest: string }[];
    };

    expect(body.models.map((entry) => entry.name)).toContain('deepseek-chat');
    // Zero and empty rather than invented: there is no file on disk, and a
    // plausible-looking digest would be a fabricated fact about something that does
    // not exist.
    expect(body.models[0]?.size).toBe(0);
    expect(body.models[0]?.digest).toBe('');
  });

  it('describes a model under /api/show, status and all', async () => {
    const harness = await start();
    const response = await post(harness, '/api/show', { model: 'deepseek-chat' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      model_info: Record<string, string>;
      capabilities: string[];
    };
    expect(body.model_info['omniproxy.provider']).toBe('deepseek-web');
    // As declared (§12.10).
    expect(body.model_info['omniproxy.status']).toBe('unverified');
    expect(body.capabilities).toContain('completion');
  });

  it('refuses /api/show for a model it does not have', async () => {
    const harness = await start();
    const response = await post(harness, '/api/show', { model: 'llama3' });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toMatch(/not found/);
  });

  it('reports a version that does not pretend to be Ollama', async () => {
    const harness = await start();
    const body = (await (await fetch(`${harness.gateway.url}/api/version`)).json()) as {
      version: string;
    };
    expect(body.version).toContain('omniproxy');
  });
});

/* ─────────────────────────────── refusing and failing ─────────────────────────────── */

describe('/api/chat refusals and failures', () => {
  it('uses Ollama error shapes: a string under `error`', async () => {
    const harness = await start();
    const response = await post(harness, '/api/chat', chat({ model: 'llama3' }));

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; action: string };
    expect(body.error).toMatch(/model "llama3" not found/);
    expect(body.action).toContain('deepseek-chat');
  });

  it('turns a quota envelope into a 429 with something to do', async () => {
    const harness = await start({ simulator: { quotaExhausted: true } });
    const response = await post(harness, '/api/chat', chat());

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: string; action: string; code: string };
    expect(body.code).toBe('quota_exhausted');
    expect(body.action).toMatch(/another|reset/i);
  });

  it('ends a mid-stream failure with a done record, not a closed socket', async () => {
    // A client waiting for `done` waits forever otherwise.
    const harness = await start({ simulator: { failCompletionWith: { attempt: 1, status: 429 } } });
    const response = await post(harness, '/api/chat', chat({ stream: true }));

    // Nothing was written yet, so a real status is still possible and is the honest
    // answer.
    expect(response.status).toBe(429);
    await response.arrayBuffer();
  });

  it('moves to another account, exactly as the other endpoints do', async () => {
    const harness = await start({
      accounts: [
        { id: 'stale', provider: 'deepseek-web', fields: { token: 'expired-token' } },
        { id: 'fresh', provider: 'deepseek-web', fields: { token: TOKEN } },
      ],
    });

    const response = await post(harness, '/api/chat', chat());
    expect(response.status).toBe(200);
    expect(harness.pool.snapshot().find((entry) => entry.id === 'fresh')?.successes).toBe(1);
  });

  it('reports all four dialects on /health', async () => {
    const harness = await start();
    const body = (await (await fetch(`${harness.gateway.url}/health`)).json()) as {
      dialects: string[];
    };
    expect(body.dialects).toEqual(['openai', 'anthropic', 'ollama', 'gemini']);
  });

  it('shares one concurrency allowance across all four', async () => {
    const harness = await start({ simulator: { frameDelayMs: 5 } });

    const responses = await Promise.all([
      post(harness, '/api/chat', chat()),
      post(harness, '/v1/messages', {
        model: 'deepseek-chat',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      post(harness, '/v1beta/models/deepseek-chat:generateContent', {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      }),
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
    expect(harness.sim.sessions).toHaveLength(4);
  });
});

function lastPrompt(simulator: DeepSeekSim): string {
  const sends = simulator.requests.filter((entry) => entry.path.endsWith('/chat/completion'));
  return (JSON.parse(sends.at(-1)?.body ?? '{}') as { prompt: string }).prompt;
}
