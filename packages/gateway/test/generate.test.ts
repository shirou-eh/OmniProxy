import { clearWasmCache } from '@omniproxy/engine-declarative';
import type { DeepSeekSim } from '@omniproxy/provider-sim';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/serve.js';
import { post, REPLY, startHarness, TOKEN, type Harness, type HarnessOptions } from './harness.js';

/**
 * `POST /v1beta/models/{model}:generateContent`, end to end.
 *
 * The third protocol on the same gateway, the same accounts, the same gate and the
 * same DeepSeek declaration. Google puts the model in the URL, which is the only thing
 * about it the request loop had to learn.
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

const contents = (text = 'Скажи что-нибудь'): Record<string, unknown> => ({
  contents: [{ role: 'user', parts: [{ text }] }],
});

async function generate(
  harness: Harness,
  body: unknown,
  model = 'deepseek-chat',
  method = 'generateContent',
  init: RequestInit = {},
): Promise<Response> {
  return post(harness, `/v1beta/models/${model}:${method}`, body, init);
}

interface Candidate {
  content: { role: string; parts: { text?: string; thought?: boolean; functionCall?: unknown }[] };
  finishReason?: string;
  index: number;
  safetyRatings: unknown[];
}

/* ────────────────────────────────── the happy path ────────────────────────────────── */

describe('POST :generateContent', () => {
  it('answers with a candidate', async () => {
    const harness = await start();
    const response = await generate(harness, contents());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      candidates: Candidate[];
      usageMetadata: { totalTokenCount: number };
      modelVersion: string;
    };

    expect(body.candidates[0]?.content.role).toBe('model');
    expect(body.candidates[0]?.content.parts[0]?.text).toBe(REPLY);
    expect(body.candidates[0]?.finishReason).toBe('STOP');
    expect(body.modelVersion).toBe('deepseek-chat');
    expect(body.usageMetadata.totalTokenCount).toBeGreaterThan(0);
  });

  it('streams the same answer as repeated responses', async () => {
    const harness = await start();
    const response = await generate(harness, contents(), 'deepseek-chat', 'streamGenerateContent');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

    const parsed = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { candidates: Candidate[] });

    const text = parsed
      .flatMap((chunk) => chunk.candidates[0]?.content.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    expect(text).toBe(REPLY);
    // The last chunk carries the finish reason: without a sentinel it is the only way
    // a client knows the stream ended rather than broke.
    expect(parsed.at(-1)?.candidates[0]?.finishReason).toBe('STOP');
  });

  it('takes the model from the URL, qualified name and all', async () => {
    const harness = await start();
    const response = await generate(harness, contents(), 'deepseek-web/deepseek-chat');

    expect(response.status).toBe(200);
    expect(((await response.json()) as { modelVersion: string }).modelVersion).toBe('deepseek-chat');
  });

  it('accepts the /v1 path as well as /v1beta', async () => {
    const harness = await start();
    const response = await post(harness, '/v1/models/deepseek-chat:generateContent', contents());
    expect(response.status).toBe(200);
  });

  it('sends systemInstruction and the whole conversation upstream', async () => {
    const harness = await start();
    await generate(harness, {
      systemInstruction: { parts: [{ text: 'Be terse.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'what is 2+2' }] },
        { role: 'model', parts: [{ text: '4' }] },
        { role: 'user', parts: [{ text: 'and 3+3' }] },
      ],
    });

    const send = harness.sim.requests.find((entry) => entry.path.endsWith('/chat/completion'));
    const prompt = (JSON.parse(send?.body ?? '{}') as { prompt: string }).prompt;
    expect(prompt).toContain('Be terse.');
    expect(prompt).toContain('User: what is 2+2');
    expect(prompt).toContain('Assistant: 4');
  });

  it('produces the same upstream prompt as the other two endpoints', async () => {
    // Three protocols, one conversation. If this ever diverges, the universal layer
    // has stopped doing its job and the answers start depending on the caller's SDK.
    const harness = await start();

    await generate(harness, {
      systemInstruction: { parts: [{ text: 'Be terse.' }] },
      contents: [{ role: 'user', parts: [{ text: 'what is 2+2' }] }],
    });
    const gemini = lastPrompt(harness.sim);

    clearWasmCache();
    await post(harness, '/v1/messages', {
      model: 'deepseek-chat',
      max_tokens: 64,
      system: 'Be terse.',
      messages: [{ role: 'user', content: 'what is 2+2' }],
    });
    const anthropic = lastPrompt(harness.sim);

    clearWasmCache();
    await post(harness, '/v1/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'what is 2+2' },
      ],
    });
    const openai = lastPrompt(harness.sim);

    expect(gemini).toBe(anthropic);
    expect(anthropic).toBe(openai);
  });
});

/* ─────────────────────────────── the other endpoints ─────────────────────────────── */

describe('the Gemini side endpoints', () => {
  it('lists models under its own path and its own shape', async () => {
    const harness = await start();
    const body = (await (await fetch(`${harness.gateway.url}/v1beta/models`)).json()) as {
      models: { name: string; baseModelId: string; supportedGenerationMethods: string[] }[];
    };

    expect(body.models[0]?.name).toMatch(/^models\//);
    expect(body.models.map((entry) => entry.baseModelId)).toContain('deepseek-chat');
    expect(body.models[0]?.supportedGenerationMethods).toContain('streamGenerateContent');
  });

  it('leaves /v1/models to the other two clients', async () => {
    // Same word, different shapes. Serving Google's envelope there would break both
    // the OpenAI and Anthropic SDKs.
    const harness = await start();
    const body = (await (await fetch(`${harness.gateway.url}/v1/models`)).json()) as {
      object: string;
      models?: unknown;
    };
    expect(body.object).toBe('list');
    expect(body.models).toBeUndefined();
  });

  it('counts tokens, and says the count is an estimate', async () => {
    // Clients budget against this. One budgeting against arithmetic rather than a
    // tokenizer deserves to be told which it got.
    const harness = await start();
    const response = await generate(harness, contents('x'.repeat(40)), 'deepseek-chat', 'countTokens');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      totalTokens: number;
      omniproxy: { estimated: boolean; method: string };
    };
    expect(body.totalTokens).toBeGreaterThan(0);
    expect(body.omniproxy.estimated).toBe(true);
    expect(body.omniproxy.method).toBe('characters/4');
    // And it reached no provider and spent no message.
    expect(harness.sim.requests).toHaveLength(0);
  });

  it('refuses to count tokens for a model it does not have', async () => {
    const harness = await start();
    const response = await generate(harness, contents(), 'gpt-4o', 'countTokens');
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { status: string } }).error.status).toBe('NOT_FOUND');
  });
});

/* ─────────────────────────────── refusing, informatively ─────────────────────────────── */

describe('requests :generateContent refuses', () => {
  it("uses Google error shapes, not another dialect's", async () => {
    const harness = await start();
    const response = await generate(harness, contents(), 'gpt-4o');

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: number; status: string; message: string; action: string };
    };
    expect(body.error.code).toBe(404);
    expect(body.error.status).toBe('NOT_FOUND');
    expect(body.error.action).toContain('deepseek-chat');
  });

  it('rejects an empty contents list', async () => {
    const harness = await start();
    const response = await generate(harness, { contents: [] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { status: string } }).error.status).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('refuses more than one candidate', async () => {
    const harness = await start();
    const response = await generate(harness, {
      ...contents(),
      generationConfig: { candidateCount: 3 },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(
      /one candidate per request/,
    );
  });

  it('rejects a body that is not JSON in its own words', async () => {
    const harness = await start();
    const response = await generate(harness, 'not json');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { status: string } }).error.status).toBe(
      'INVALID_ARGUMENT',
    );
  });
});

/* ──────────────────────────────── upstream and access ──────────────────────────────── */

describe('the Gemini endpoint under failure and access control', () => {
  it('turns a quota envelope into RESOURCE_EXHAUSTED', async () => {
    const harness = await start({ simulator: { quotaExhausted: true } });
    const response = await generate(harness, contents());

    expect(response.status).toBe(429);
    const body = (await response.json()) as { error: { status: string; action: string } };
    expect(body.error.status).toBe('RESOURCE_EXHAUSTED');
    expect(body.error.action).toMatch(/another|reset/i);
  });

  it('moves to another account, exactly as the other endpoints do', async () => {
    const harness = await start({
      accounts: [
        { id: 'stale', provider: 'deepseek-web', fields: { token: 'expired-token' } },
        { id: 'fresh', provider: 'deepseek-web', fields: { token: TOKEN } },
      ],
    });

    const response = await generate(harness, contents());
    expect(response.status).toBe(200);
    expect(harness.pool.snapshot().find((entry) => entry.id === 'fresh')?.successes).toBe(1);
  });

  it('accepts x-goog-api-key, which Google SDKs send', async () => {
    const harness = await start({ apiKey: 'let-me-in' });
    const response = await generate(harness, contents(), 'deepseek-chat', 'generateContent', {
      headers: { 'x-goog-api-key': 'let-me-in' },
    });
    expect(response.status).toBe(200);
  });

  it('accepts the ?key= parameter, which they also send', async () => {
    const harness = await start({ apiKey: 'let-me-in' });
    const response = await post(
      harness,
      '/v1beta/models/deepseek-chat:generateContent?key=let-me-in',
      contents(),
    );
    expect(response.status).toBe(200);
  });

  it('refuses a wrong key with a Google authentication error', async () => {
    const harness = await start({ apiKey: 'let-me-in' });
    const response = await generate(harness, contents(), 'deepseek-chat', 'generateContent', {
      headers: { 'x-goog-api-key': 'nope' },
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { status: string } }).error.status).toBe(
      'UNAUTHENTICATED',
    );
    expect(harness.sim.requests).toHaveLength(0);
  });

  it('shares the concurrency gate with the other endpoints', async () => {
    const harness = await start({ simulator: { frameDelayMs: 5 } });

    const responses = await Promise.all([
      generate(harness, contents()),
      post(harness, '/v1/messages', {
        model: 'deepseek-chat',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
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
    expect(harness.sim.sessions).toHaveLength(3);
  });

  it('reports all four dialects on /health', async () => {
    const harness = await start();
    const body = (await (await fetch(`${harness.gateway.url}/health`)).json()) as {
      dialects: string[];
    };
    expect(body.dialects).toEqual(['openai', 'anthropic', 'ollama', 'gemini']);
  });
});

function lastPrompt(simulator: DeepSeekSim): string {
  const sends = simulator.requests.filter((entry) => entry.path.endsWith('/chat/completion'));
  return (JSON.parse(sends.at(-1)?.body ?? '{}') as { prompt: string }).prompt;
}
