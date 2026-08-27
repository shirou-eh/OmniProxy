import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeBundle,
  findResidualSecretShapes,
  sanitizeBundle,
  writeFixture,
  FixtureRefused,
} from '@omniproxy/capture';
import {
  clearWasmCache,
  DeclarationExecutionError,
  executeFlow,
  memoryStateStore,
  parseDeclaration,
  defaultTransformContext,
  TransformRegistry,
} from '@omniproxy/engine-declarative';
import { startDeepSeekSim, simWasmPath, type DeepSeekSim } from '@omniproxy/provider-sim';
import type { CaptureBundle, UMSEvent } from '@omniproxy/schema';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchHttpClient } from '../src/fetch-client.js';
import { recordingHttpClient } from '../src/recording-client.js';
import { replayHttpClient, ReplayError } from '../src/replay-client.js';

/**
 * The pipeline, end to end, on traffic that actually crossed a socket.
 *
 * This is the answer to risk R-11. Phase 1 had every piece — engine, recorder,
 * sanitizer, analyzer, fixture gate, replay — and no way to run them together without
 * a live DeepSeek session, because §12.1 forbids inventing the traffic. Hand-writing
 * fixtures would have satisfied the letter of that rule and destroyed its point: a
 * fixture I invent proves only that I am consistent with myself.
 *
 * So the traffic here is real traffic against a simulator whose protocol comes from
 * `legacy/server.js`, a client that has worked against the live service. Real HTTP,
 * real headers, real chunk boundaries, real SSE framing. What remains untested is
 * whether chat.deepseek.com still behaves this way today — a canary question, and the
 * reason the provider's status stays `unverified`.
 */

const declarationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../providers/deepseek-web/provider.yaml',
);

const TOKEN = 'ds-live-token-9f2a4c6e8b1d3f5a7c9e0b2d4f6a8c0e';
const REPLY = 'Привет! Это ответ симулятора. 🌍';

let sim: DeepSeekSim | undefined;

beforeEach(() => {
  // The WASM module cache is process-wide by design, and every simulator gets a fresh
  // port. Leaving it warm would let one test's download satisfy another's, which is
  // exactly the kind of hidden coupling that makes a suite pass in one order only.
  clearWasmCache();
});

afterEach(async () => {
  await sim?.close();
  sim = undefined;
});

/** The shipped declaration, pointed at a local simulator instead of the real host. */
async function declarationFor(target: string) {
  const yaml = await readFile(declarationPath, 'utf8');
  const declaration = parseDeclaration(yaml, { source: 'providers/deepseek-web/provider.yaml' });
  // Only the address changes. Everything the test exercises — the flow, the extracts,
  // the PoW var, the stream mapping, the error rules — is what ships.
  const channel = declaration.channels[0]!;
  return {
    ...declaration,
    channels: [{ ...channel, base: target }],
  } as typeof declaration;
}

interface RunResult {
  events: UMSEvent[];
  bundle: CaptureBundle;
  text: string;
}

async function recordOneTurn(
  simulator: DeepSeekSim,
  prompt = 'Скажи что-нибудь',
  state = memoryStateStore(),
): Promise<RunResult> {
  const declaration = await declarationFor(simulator.url);
  const recording = recordingHttpClient(fetchHttpClient(), {
    providerId: 'deepseek-web',
    scenario: 'chat-stream',
    source: 'pipeline.test.ts',
  });

  const events: UMSEvent[] = [];
  for await (const event of executeFlow({
    declaration,
    http: recording.client,
    transforms: new TransformRegistry(),
    transformContext: defaultTransformContext(),
    state,
    auth: { token: TOKEN },
    env: { DEEPSEEK_WASM_URL: `${simulator.url}${simWasmPath()}` },
    request: { model: 'deepseek-chat', prompt },
  })) {
    events.push(event);
  }

  return { events, bundle: recording.bundle(), text: textOf(events) };
}

/** The typed failure of a flow, so a test can assert on the action it offers. */
async function failureOf(promise: Promise<unknown>): Promise<DeclarationExecutionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeclarationExecutionError) return error;
    throw error;
  }
  throw new Error('expected the flow to fail, and it succeeded');
}

function textOf(events: UMSEvent[]): string {
  return events
    .filter((e): e is Extract<UMSEvent, { type: 'text.delta' }> => e.type === 'text.delta')
    .map((e) => e.text)
    .join('');
}

/* ───────────────────────────── the flow against a socket ───────────────────────────── */

describe('the DeepSeek declaration against a live simulator', () => {
  it('completes a turn and streams the answer back', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: REPLY });
    const { text, events } = await recordOneTurn(sim);

    expect(text).toBe(REPLY);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
    expect(events.some((event) => event.type === 'warning')).toBe(false);
  });

  it('solves the proof of work in real WebAssembly, and the server accepts it', async () => {
    // The simulator verifies everything our code is responsible for: the base64, the
    // field names, that the challenge is one it issued, that it has not been replayed.
    // It cannot verify the hash itself — that algorithm is inside DeepSeek's module.
    sim = await startDeepSeekSim({ token: TOKEN, reply: 'ok' });
    const { text } = await recordOneTurn(sim);

    expect(text).toBe('ok');
    const completion = sim.requests.find((r) => r.path === '/api/v0/chat/completion');
    const header = completion?.headers['x-ds-pow-response'];
    expect(typeof header).toBe('string');
    expect(JSON.parse(Buffer.from(header as string, 'base64').toString('utf8'))).toMatchObject({
      algorithm: 'DeepSeekHashV1',
      target_path: '/api/v0/chat/completion',
    });
  });

  it('mints a fresh challenge per turn instead of reusing the header', async () => {
    // The simulator spends a challenge on use. A declaration that cached the header
    // would pass a unit test and fail in production on the second message.
    sim = await startDeepSeekSim({ token: TOKEN, reply: 'one' });
    const state = memoryStateStore();
    const first = await recordOneTurn(sim, 'first', state);
    const second = await recordOneTurn(sim, 'second', state);

    expect(first.text).toBe('one');
    expect(second.text).toBe('one');
    expect(sim.requests.filter((r) => r.path.endsWith('create_pow_challenge'))).toHaveLength(2);
  });

  it('creates one session and reuses it for the second message', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: 'x' });
    const state = memoryStateStore();
    await recordOneTurn(sim, 'first', state);
    await recordOneTurn(sim, 'second', state);

    expect(sim.sessions).toHaveLength(1);
    expect(state.get()['sessionId']).toBe(sim.sessions[0]);
  });

  it('sends null for the first parent_message_id and the real id for the second', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: 'x' });
    const state = memoryStateStore();
    await recordOneTurn(sim, 'first', state);
    await recordOneTurn(sim, 'second', state);

    const completions = sim.requests.filter((r) => r.path === '/api/v0/chat/completion');
    expect(JSON.parse(completions[0]!.body).parent_message_id).toBeNull();
    expect(JSON.parse(completions[1]!.body).parent_message_id).toBe('1001');
  });

  it('carries reasoning on its own channel', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: 'Ответ', reasoning: 'Размышляю' });
    const { events, text } = await recordOneTurn(sim);

    const reasoning = events
      .filter((e): e is Extract<UMSEvent, { type: 'reasoning.delta' }> => e.type === 'reasoning.delta')
      .map((e) => e.text)
      .join('');
    expect(reasoning).toBe('Размышляю');
    expect(text).toBe('Ответ');
  });

  it('reads a provider that streams response/content instead of fragments', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: 'plain path', contentOnly: true });
    expect((await recordOneTurn(sim)).text).toBe('plain path');
  });

  it('turns an expired session into the declared error, with an action', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const state = memoryStateStore({ sessionId: 'sim-session-does-not-exist' });
    await expect(recordOneTurn(sim, 'hello', state)).rejects.toMatchObject({
      omni: { code: 'upstream_unavailable', retryable: 'same-account' },
    });
  });

  it('turns a bad token into auth_expired, naming the command that fixes it', async () => {
    sim = await startDeepSeekSim({ token: 'a-different-token' });
    const error = await failureOf(recordOneTurn(sim));
    expect(error.omni.code).toBe('auth_expired');
    expect(error.omni.message).toMatch(/omniproxy auth add deepseek-web/);
  });

  it('recognises the quota envelope hidden inside a 200', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, quotaExhausted: true });
    const error = await failureOf(recordOneTurn(sim));
    expect(error.omni.code).toBe('quota_exhausted');
    expect(error.omni.retryable).toBe('other-account');
  });

  it('classifies a 429 as worth trying another account', async () => {
    sim = await startDeepSeekSim({
      token: TOKEN,
      failCompletionWith: { attempt: 1, status: 429 },
    });
    const error = await failureOf(recordOneTurn(sim));
    expect(error.omni.code).toBe('rate_limit');
    expect(error.omni.retryable).toBe('other-account');
  });
});

/* ─────────────────────────────── recording the traffic ─────────────────────────────── */

describe('what the recorder writes down', () => {
  it('records every exchange of the flow, in order', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: REPLY });
    const { bundle } = await recordOneTurn(sim);

    // Four, not three: the proof-of-work module is fetched through the engine's own
    // client, so it lands in the capture like everything else. That is what makes the
    // bundle replayable — a transform that reached the network on its own would leave
    // a hole in the recording exactly where the anti-bot work happens.
    expect(bundle.entries.map((entry) => new URL(entry.request.url).pathname)).toEqual([
      '/api/v0/chat/create_pow_challenge',
      '/api/v0/chat_session/create',
      '/static/pow/sha3_wasm_bg.wasm',
      '/api/v0/chat/completion',
    ]);
    expect(bundle.providerId).toBe('deepseek-web');
    expect(bundle.scenario).toBe('chat-stream');
  });

  it('is unsanitized by construction, and holds the live token to prove it', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const { bundle } = await recordOneTurn(sim);

    expect(bundle.sanitized).toBe(false);
    expect(JSON.stringify(bundle)).toContain(TOKEN);
  });

  it('cuts the stream into frames with the times they arrived', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: REPLY, frameDelayMs: 2 });
    const { bundle } = await recordOneTurn(sim);

    const stream = bundle.entries.at(-1)!;
    const frames = stream.response.frames ?? [];
    expect(frames.length).toBeGreaterThan(3);
    expect(frames.every((frame) => frame.at !== null)).toBe(true);
    // Monotonic: a frame cannot land before the one before it. This is the property a
    // HAR file cannot carry at all, and the reason a live recorder is worth having.
    const times = frames.map((frame) => frame.at as number);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(frames.at(-1)!.data).toBe('[DONE]');
  });

  it('does not change what the caller receives', async () => {
    // A recorder that buffered the stream would turn a streaming provider into a batch
    // one, and the only symptom would be a user saying it feels slow.
    sim = await startDeepSeekSim({ token: TOKEN, reply: REPLY });
    const recorded = await recordOneTurn(sim);

    const declaration = await declarationFor(sim.url);
    const direct: UMSEvent[] = [];
    for await (const event of executeFlow({
      declaration,
      http: fetchHttpClient(),
      transforms: new TransformRegistry(),
      transformContext: defaultTransformContext(),
      state: memoryStateStore(),
      auth: { token: TOKEN },
      env: { DEEPSEEK_WASM_URL: `${sim.url}${simWasmPath()}` },
      request: { model: 'deepseek-chat', prompt: 'Скажи что-нибудь' },
    })) {
      direct.push(event);
    }

    expect(recorded.events).toEqual(direct);
  });

  it('records a request that failed, because that is the one worth having', async () => {
    sim = await startDeepSeekSim({ token: 'wrong' });
    const { bundle } = await recordOneTurn(sim).catch((error: unknown) => {
      void error;
      return { bundle: undefined };
    });
    // The flow threw, so the bundle is only reachable through the recorder itself;
    // this test asserts the shape of what a failed recording produces instead.
    expect(bundle).toBeUndefined();

    const recording = recordingHttpClient(fetchHttpClient(), {
      providerId: 'deepseek-web',
      scenario: 'auth-failure',
    });
    await recording.client.request({
      method: 'POST',
      url: `${sim.url}/api/v0/chat/create_pow_challenge`,
      headers: { authorization: 'Bearer definitely-not-the-token' },
      body: '{}',
    });
    expect(recording.bundle().entries[0]!.response.status).toBe(401);
  });
});

/* ──────────────────────── sanitize, analyze, and the fixture gate ──────────────────────── */

describe('the recorded bundle through the rest of the pipeline', () => {
  it('sanitizes the live token out and leaves the flow intact', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: REPLY });
    const { bundle } = await recordOneTurn(sim);

    const { bundle: clean } = sanitizeBundle(bundle);
    const serialized = JSON.stringify(clean);

    expect(clean.sanitized).toBe(true);
    expect(serialized).not.toContain(TOKEN);
    expect(findResidualSecretShapes(`${JSON.stringify(clean, null, 2)}\n`)).toEqual([]);
    // The session id is not a secret and must survive, or the analyzer has nothing
    // left to trace and the fixture is useless.
    expect(serialized).toContain(sim.sessions[0]!);
  });

  it('gives one value one placeholder, so the dependency graph survives redaction', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const { bundle } = await recordOneTurn(sim);
    const { bundle: clean } = sanitizeBundle(bundle);

    const placeholders = clean.entries
      .map((entry) => entry.request.headers.find(([name]) => name === 'authorization')?.[1])
      .filter((value): value is string => value !== undefined);

    expect(placeholders).toHaveLength(3);
    expect(new Set(placeholders).size).toBe(1);
  });

  it('recovers the flow: session created, then spent in the completion body', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: REPLY });
    const { bundle } = await recordOneTurn(sim);
    const analysis = analyzeBundle(sanitizeBundle(bundle).bundle);

    const kinds = analysis.flow.map((step) => step.classification);
    expect(kinds).toContain('session');
    // A POST that streams back is the call carrying user input: `send`, not `stream`.
    expect(kinds).toContain('send');
    // The WASM module is an asset, so it is set aside rather than proposed as a step.
    expect(analysis.noise.map((step) => step.classification)).toEqual(['static']);

    // The session id has to be traced out of the create response and into the body of
    // the completion request. Without that link the analyzer has no flow to report and
    // a generated declaration would have no `{{state.sessionId}}` to write.
    const sessionEntry = analysis.flow.find((step) => step.classification === 'session')!;
    const sendEntry = analysis.flow.find((step) => step.classification === 'send')!;
    const link = analysis.links.find(
      (candidate) => candidate.from === sessionEntry.index && candidate.to === sendEntry.index,
    );
    expect(link, 'the session id must be traced from its response into the next request').toBeDefined();
    expect(link!.sourcePath).toMatch(/chat_session|biz_data/);
    expect(link!.targetPath).toMatch(/chat_session_id/);
  });

  it('refuses to write an unsanitized bundle into fixtures', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const { bundle } = await recordOneTurn(sim);

    await expect(
      writeFixture(bundle, path.join(process.cwd(), 'never-written.json')),
    ).rejects.toBeInstanceOf(FixtureRefused);
  });
});

/* ──────────────────────────────────── replay ──────────────────────────────────── */

describe('replaying a recorded bundle', () => {
  it('produces the same answer the live run did, with no network at all', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: REPLY });
    const live = await recordOneTurn(sim);
    const { bundle: clean } = sanitizeBundle(live.bundle);
    const simUrl = sim.url;
    await sim.close();
    sim = undefined;
    // The module cache would otherwise answer from the live run and the replayed
    // download would go unused — a green test that proved nothing.
    clearWasmCache();

    // The same declaration and the same wasm URL as the live run: replay matches on
    // method and path, and pointing it somewhere else would be testing a different
    // flow than the one that was recorded.
    const declaration = await declarationFor(simUrl);
    const replay = replayHttpClient(clean);
    const events: UMSEvent[] = [];
    for await (const event of executeFlow({
      declaration,
      http: replay,
      transforms: new TransformRegistry(),
      // No network in this context at all: if the flow tried to fetch the WASM it
      // would fail loudly rather than quietly reaching out during a test.
      // A real WebAssembly instantiation, from bytes that came out of the capture.
      // No network: the engine fetches the module through its own HTTP client, which
      // here is the replay client, so the download is part of what was recorded.
      transformContext: defaultTransformContext(),
      state: memoryStateStore(),
      auth: { token: 'not-needed-for-replay' },
      env: { DEEPSEEK_WASM_URL: `${simUrl}${simWasmPath()}` },
      request: { model: 'deepseek-chat', prompt: 'Скажи что-нибудь' },
    })) {
      events.push(event);
    }

    expect(textOf(events)).toBe(REPLY);
    // Nothing left over: the declaration asked for exactly what was recorded, which is
    // the property that makes a capture a contract rather than a souvenir.
    expect(replay.report().unused).toEqual([]);
  });

  it('refuses to invent a response the capture does not contain', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const { bundle } = await recordOneTurn(sim);
    const replay = replayHttpClient(bundle);

    await replay.request({
      method: 'POST',
      url: 'https://chat.deepseek.com/api/v0/chat/create_pow_challenge',
      headers: {},
      body: '{}',
    });
    await expect(
      replay.request({
        method: 'GET',
        url: 'https://chat.deepseek.com/api/v0/nothing/like/this',
        headers: {},
      }),
    ).rejects.toBeInstanceOf(ReplayError);
  });

  it('does not answer the same exchange twice', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const { bundle } = await recordOneTurn(sim);
    const replay = replayHttpClient(bundle);
    const url = 'https://chat.deepseek.com/api/v0/chat/create_pow_challenge';

    await replay.request({ method: 'POST', url, headers: {}, body: '{}' });
    await expect(replay.request({ method: 'POST', url, headers: {}, body: '{}' })).rejects.toThrow(
      /no unused POST/,
    );
  });
});
