import type { ProviderDeclaration, UMSEvent } from '@omniproxy/schema';
import { describe, expect, it } from 'vitest';
import {
  buildRequest,
  DeclarationExecutionError,
  executeFlow,
  matchErrorRule,
  pickChannel,
  resolveModel,
  type EngineRequest,
} from '../src/executor.js';
import { parseDeclaration } from '../src/loader.js';
import { memoryStateStore, type HttpClient, type HttpRequest } from '../src/ports.js';
import { TransformRegistry, type TransformContext } from '../src/transforms.js';
import { deepseekYaml, minimalYaml, nonStreamedYaml } from './fixtures.js';

/* ─────────────────────────────── the test doubles ─────────────────────────────── */

interface Reply {
  status?: number;
  body?: string;
  /** Streamed chunks. When present the reply answers `stream()`. */
  chunks?: string[];
}

/**
 * An HTTP client that answers from a script and records what it was asked.
 *
 * Nothing in these tests reaches the network. That is not only about speed: an engine
 * that cannot be driven entirely from a script cannot be replayed from a capture
 * either, and replay is the whole maintenance story for twenty providers.
 */
class ScriptedHttp implements HttpClient {
  readonly sent: HttpRequest[] = [];
  #replies: Reply[];

  constructor(replies: Reply[]) {
    this.#replies = [...replies];
  }

  #next(request: HttpRequest): Reply {
    this.sent.push(request);
    const reply = this.#replies.shift();
    if (!reply) throw new Error(`no scripted reply left for ${request.method} ${request.url}`);
    return reply;
  }

  async request(request: HttpRequest) {
    const reply = this.#next(request);
    return { status: reply.status ?? 200, headers: {}, body: reply.body ?? '{}' };
  }

  async stream(request: HttpRequest) {
    const reply = this.#next(request);
    const chunks = reply.chunks ?? (reply.body === undefined ? [] : [reply.body]);
    const encoder = new TextEncoder();
    return {
      status: reply.status ?? 200,
      headers: {},
      stream: (async function* () {
        for (const chunk of chunks) yield encoder.encode(chunk);
      })(),
    };
  }
}

const transformContext: TransformContext = {
  now: () => 1_700_000_000_000,
  uuid: () => '11111111-2222-4333-8444-555555555555',
  randomBytes: (size) => Buffer.alloc(size, 7),
  fetchBytes: async () => new Uint8Array([0]),
  instantiateWasm: async () => {
    const memory = { buffer: new ArrayBuffer(4096) };
    let bump = 512;
    let stack = 2048;
    return {
      memory,
      __wbindgen_export_0: (size: number) => {
        const ptr = bump;
        bump += size;
        return ptr;
      },
      __wbindgen_add_to_stack_pointer: (delta: number) => (stack += delta),
      wasm_solve: (sp: number) => {
        const view = new DataView(memory.buffer);
        view.setInt32(sp, 1, true);
        view.setFloat64(sp + 8, 4242, true);
      },
    };
  },
};

interface RunOptions {
  declaration?: ProviderDeclaration;
  request?: Partial<EngineRequest>;
  state?: Record<string, unknown>;
  auth?: Record<string, unknown>;
}

async function run(replies: Reply[], options: RunOptions = {}) {
  const declaration = options.declaration ?? parseDeclaration(deepseekYaml);
  const http = new ScriptedHttp(replies);
  const state = memoryStateStore(options.state ?? {});
  const events: UMSEvent[] = [];

  const iterator = executeFlow({
    declaration,
    http,
    transforms: new TransformRegistry(),
    transformContext,
    state,
    auth: options.auth ?? { token: 'tok-1' },
    request: { model: 'deepseek-chat', prompt: 'привет', ...options.request },
  });

  for await (const event of iterator) events.push(event);
  return { events, http, state, sent: http.sent };
}

function textOf(events: UMSEvent[]): string {
  return events
    .filter((e): e is Extract<UMSEvent, { type: 'text.delta' }> => e.type === 'text.delta')
    .map((e) => e.text)
    .join('');
}

/** The three replies a successful DeepSeek turn needs: challenge, session, stream. */
function happyPath(chunks: string[]): Reply[] {
  return [
    { body: JSON.stringify({ data: { biz_data: { challenge: challengeBody } } }) },
    { body: JSON.stringify({ data: { biz_data: { id: 'sess-42' } } }) },
    { chunks },
  ];
}

const challengeBody = {
  algorithm: 'DeepSeekHashV1',
  challenge: 'ch',
  salt: 's',
  difficulty: 1,
  expire_at: 1,
  signature: 'sig',
};

const answerStream = [
  'data: {"response_message_id":77}\n\n',
  'data: {"p":"response/fragments","o":"APPEND","v":{"type":"RESPONSE","content":"Привет"}}\n\n',
  'data: {"p":"response/fragments","o":"APPEND","v":{"type":"RESPONSE","content":", мир"}}\n\n',
  'data: {"p":"response/finish_reason","v":"stop"}\n\n',
];

/* ──────────────────────────────────── the flow ──────────────────────────────────── */

describe('executeFlow', () => {
  it('runs prepare, createSession, vars and send, in that order', async () => {
    const { events, sent } = await run(happyPath(answerStream));

    expect(sent.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/v0/chat/create_pow_challenge',
      '/api/v0/chat_session/create',
      '/api/v0/chat/completion',
    ]);
    expect(events[0]).toEqual({
      type: 'start',
      provider: 'deepseek-web',
      channel: 'web',
      model: 'deepseek_chat',
    });
    expect(textOf(events)).toBe('Привет, мир');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('computes vars after the extraction they depend on', async () => {
    // The proof of work needs the challenge, so it cannot be computed before it
    // arrives. Getting this order wrong produces a header the server rejects.
    const { sent } = await run(happyPath(answerStream));
    const header = sent[2]!.headers['x-ds-pow-response']!;
    expect(JSON.parse(Buffer.from(header, 'base64').toString('utf8'))).toMatchObject({
      challenge: 'ch',
      answer: 4242,
      target_path: '/api/v0/chat/completion',
    });
  });

  it('sends the auth header, the fingerprint headers and the step headers together', async () => {
    const { sent } = await run(happyPath(answerStream));
    expect(sent[2]!.headers).toMatchObject({
      authorization: 'Bearer tok-1',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'x-client-locale': 'en_US',
      'content-type': 'application/json',
    });
  });

  it('persists the session id, and skips createSession when it already has one', async () => {
    const first = await run(happyPath(answerStream));
    expect(first.state.get()['sessionId']).toBe('sess-42');

    const second = await run(
      [{ body: JSON.stringify({ data: { biz_data: { challenge: challengeBody } } }) }, { chunks: answerStream }],
      { state: { sessionId: 'sess-42' } },
    );
    expect(second.sent.map((request) => new URL(request.url).pathname)).toEqual([
      '/api/v0/chat/create_pow_challenge',
      '/api/v0/chat/completion',
    ]);
  });

  it('remembers the message id as the next parent', async () => {
    const { state, events } = await run(happyPath(answerStream));
    expect(state.get()['parentMessageId']).toBe('77');
    // The id is upstream bookkeeping, not something a client asked for.
    expect(events.some((event) => event.type === 'text.delta' && event.text.includes('77'))).toBe(
      false,
    );
  });

  it('sends the body the declaration describes', async () => {
    const { sent } = await run(happyPath(answerStream), { state: { parentMessageId: 5 } });
    expect(JSON.parse(sent[2]!.body!)).toEqual({
      chat_session_id: 'sess-42',
      parent_message_id: 5,
      prompt: 'привет',
      thinking_enabled: false,
    });
  });

  it('sends an explicit null for a value that is legitimately absent', async () => {
    // The first message of a conversation has no parent. Refusing to build the
    // request would be wrong, and so would sending an empty string.
    const { sent } = await run(happyPath(answerStream));
    expect(JSON.parse(sent[2]!.body!).parent_message_id).toBeNull();
  });

  it("merges a model's extra fields into the send body", async () => {
    const { sent } = await run(happyPath(answerStream), {
      request: { model: 'deepseek-reasoner' },
    });
    expect(JSON.parse(sent[2]!.body!)).toMatchObject({ thinking_enabled: true });
  });

  it('reassembles multi-byte text split across transport chunks', async () => {
    const whole = answerStream.join('');
    const bytes = new TextEncoder().encode(whole);
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    for (let index = 0; index < bytes.length; index += 3) {
      chunks.push(decoder.decode(bytes.subarray(index, index + 3), { stream: true }));
    }
    const { events } = await run(happyPath(chunks));
    expect(textOf(events)).toBe('Привет, мир');
  });

  it('separates reasoning from the answer', async () => {
    const { events } = await run(
      happyPath([
        'data: {"p":"response/fragments","o":"APPEND","v":{"type":"THINK","content":"считаю"}}\n\n',
        'data: {"p":"response/fragments","o":"APPEND","v":{"type":"RESPONSE","content":"42"}}\n\n',
      ]),
    );
    expect(events).toContainEqual({ type: 'reasoning.delta', text: 'считаю' });
    expect(textOf(events)).toBe('42');
  });

  it('warns when a stream produced no text at all', async () => {
    const { events } = await run(happyPath(['data: {"p":"response/status","v":"FINISHED"}\n\n']));
    expect(events).toContainEqual({
      type: 'warning',
      code: 'empty_response',
      message: expect.stringContaining('streamed no text'),
    });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('translates an upstream error frame into an error event with an action', async () => {
    const { events } = await run(happyPath(['data: {"type":"error","content":"overloaded"}\n\n']));
    const error = events.find((event) => event.type === 'error');
    expect(error).toMatchObject({
      type: 'error',
      error: { code: 'upstream_unavailable', retryable: 'other-account' },
    });
  });

  it('streams a plain sse provider through the declared map', async () => {
    const { events } = await run(
      [{ chunks: ['data: {"delta":"he"}\n\n', 'data: {"delta":"llo"}\n\n'] }],
      { declaration: parseDeclaration(minimalYaml), request: { model: 'tiny-1' } },
    );
    expect(textOf(events)).toBe('hello');
  });

  it('maps a non-streamed response through the same map', async () => {
    // Some providers answer in one JSON body. The engine must not require a stream
    // to exist, or every such provider becomes a code adapter.
    const declaration = parseDeclaration(nonStreamedYaml);
    expect(declaration.flow.send!.stream).toBeUndefined();

    const { events, state } = await run(
      [{ body: JSON.stringify({ text: 'one shot', id: 'm9', reason: 'stop' }) }],
      { declaration, request: { model: 'tiny-1' } },
    );

    expect(textOf(events)).toBe('one shot');
    expect(state.get()['parentMessageId']).toBe('m9');
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });
});

/* ─────────────────────────────────── failures ─────────────────────────────────── */

describe('what happens when something is wrong', () => {
  it('refuses an unknown model instead of quietly substituting one', async () => {
    // A client that asked for one model and silently got another has been lied to,
    // and finds out weeks later when the answers are subtly wrong.
    await expect(run(happyPath(answerStream), { request: { model: 'gpt-4o' } })).rejects.toThrow(
      /unknown model alias/,
    );
  });

  it('says which path stopped matching when the provider changes shape', async () => {
    const error = await capture(
      run([{ body: JSON.stringify({ data: { biz_data: {} } }) }]),
    );
    expect(error.omni.code).toBe('upstream_schema_changed');
    expect(error.message).toMatch(/\$\.data\.biz_data\.challenge matched nothing/);
    expect(error.omni.userAction).toMatch(/omniproxy capture analyze/);
  });

  it('explains a non-JSON response as what it usually is', async () => {
    const error = await capture(run([{ body: '<html>Just a moment…</html>' }]));
    expect(error.omni.code).toBe('upstream_schema_changed');
    expect(error.omni.userAction).toMatch(/anti-bot challenge page|expired session/);
  });

  it('applies the declared error rules, including one that matches a 200 body', async () => {
    const authError = await capture(run([{ status: 401, body: '{}' }]));
    expect(authError.omni.code).toBe('auth_expired');
    expect(authError.omni.message).toMatch(/omniproxy auth add deepseek-web/);

    const quota = await capture(run([{ status: 200, body: '{"code":40303}' }]));
    expect(quota.omni.code).toBe('quota_exhausted');
    expect(quota.omni.retryable).toBe('other-account');
  });

  it('falls back to a sensible classification for an undeclared status', async () => {
    const error = await capture(run([{ status: 503, body: 'upstream down' }]));
    expect(error.omni.code).toBe('upstream_unavailable');
    expect(error.omni.retryable).toBe('same-account');
  });

  it('classifies a 429 on the stream as a rate limit worth another account', async () => {
    const error = await capture(
      run([
        { body: JSON.stringify({ data: { biz_data: { challenge: challengeBody } } }) },
        { body: JSON.stringify({ data: { biz_data: { id: 's' } } }) },
        { status: 429, chunks: ['too many'] },
      ]),
    );
    expect(error.omni.code).toBe('rate_limit');
    expect(error.omni.retryable).toBe('other-account');
  });

  it('never sends a request to a host the declaration does not list', async () => {
    // A shared declaration must not be able to post your cookies somewhere else.
    const declaration = parseDeclaration(
      deepseekYaml.replace(
        '        path: /api/v0/chat/create_pow_challenge',
        '        url: https://evil.test/collect',
      ),
    );
    const http = new ScriptedHttp([{ body: '{}' }]);
    const iterator = executeFlow({
      declaration,
      http,
      transforms: new TransformRegistry(),
      transformContext,
      state: memoryStateStore(),
      auth: { token: 'tok-1' },
      request: { model: 'deepseek-chat', prompt: 'x' },
    });

    await expect(drain(iterator)).rejects.toThrow(/host evil\.test is not allowed/);
    expect(http.sent).toEqual([]);
  });

  it('allows a host the declaration listed on purpose', () => {
    const declaration = parseDeclaration(deepseekYaml);
    expect(declaration.allowedHosts).toContain('cdn.deepseek.test');
  });

  it('names the placeholder that was empty rather than sending an empty string', async () => {
    const declaration = parseDeclaration(
      deepseekYaml.replace("prompt: '{{req.prompt}}'", "prompt: '{{extracted.nothing}}'"),
    );
    const error = await capture(run(happyPath(answerStream), { declaration }));
    expect(error.message).toMatch(/unresolved template placeholders: extracted\.nothing/);
    expect(error.omni.userAction).toMatch(/order of your flow steps/);
  });

  it('refuses a declaration with no flow.send, and says what to add', async () => {
    const declaration = parseDeclaration(`
schemaVersion: 1
id: sendless
status: needs-capture
channels:
  - id: web
    kind: web-http
    base: https://sendless.test
auth:
  kind: none
flow: {}
models:
  - alias: tiny-1
    native: tiny-1
`);
    const error = await capture(run([], { declaration, request: { model: 'tiny-1' } }));
    expect(error.omni.code).toBe('not_implemented');
    expect(error.omni.userAction).toMatch(/Add a flow\.send step/);
  });
});

/* ──────────────────────────────── the pure helpers ──────────────────────────────── */

describe('pickChannel', () => {
  const declaration = parseDeclaration(deepseekYaml);

  it('picks the first executable channel when none is named', () => {
    expect(pickChannel(declaration).id).toBe('web');
  });

  it('picks a named channel', () => {
    expect(pickChannel(declaration, 'web').id).toBe('web');
  });

  it('lists the alternatives when the name is wrong', () => {
    expect(() => pickChannel(declaration, 'mobile')).toThrow(/no channel "mobile"/);
    expect(capturedAction(() => pickChannel(declaration, 'mobile'))).toMatch(/Available channels: web/);
  });

  it('refuses a provider whose only channel this engine cannot run', () => {
    const browserOnly = parseDeclaration(
      deepseekYaml.replace('    kind: web-http', '    kind: web-browser'),
    );
    expect(() => pickChannel(browserOnly)).toThrow(/no HTTP channel to execute/);
    expect(capturedAction(() => pickChannel(browserOnly))).toMatch(/Browser and local-process/);
  });
});

describe('resolveModel', () => {
  const declaration = parseDeclaration(deepseekYaml);

  it('resolves an alias to the provider name', () => {
    expect(resolveModel(declaration, 'deepseek-chat')).toEqual({
      alias: 'deepseek-chat',
      native: 'deepseek_chat',
    });
  });

  it('carries the extra body fields along', () => {
    expect(resolveModel(declaration, 'deepseek-reasoner').extra).toEqual({ thinking_enabled: true });
  });

  it('throws with the list of aliases that do exist', () => {
    expect(() => resolveModel(declaration, 'nope')).toThrow(/unknown model alias "nope"/);
    expect(capturedAction(() => resolveModel(declaration, 'nope'))).toMatch(
      /Available: deepseek-chat, deepseek-reasoner/,
    );
  });
});

describe('matchErrorRule', () => {
  const rules = parseDeclaration(deepseekYaml).errors;

  it('matches on status', () => {
    expect(matchErrorRule(rules, 401, '')?.as).toBe('auth_expired');
    expect(matchErrorRule(rules, 429, '')?.as).toBe('rate_limit');
  });

  it('matches on a JSON path and value inside a 200', () => {
    expect(matchErrorRule(rules, 200, '{"code":40303}')?.as).toBe('quota_exhausted');
    expect(matchErrorRule(rules, 200, '{"code":0}')).toBeUndefined();
  });

  it('does not match when the body is not JSON at all', () => {
    expect(matchErrorRule(rules, 200, '<html>')).toBeUndefined();
  });

  it('returns nothing when no rule applies', () => {
    expect(matchErrorRule(rules, 500, '')).toBeUndefined();
    expect(matchErrorRule([], 401, '')).toBeUndefined();
  });

  it('matches on a body substring', () => {
    const rule = matchErrorRule(
      [{ match: { bodyContains: 'Just a moment' }, as: 'challenge', retryable: 'no' }],
      200,
      '<title>Just a moment…</title>',
    );
    expect(rule?.as).toBe('challenge');
  });

  it('takes the first matching rule, so order in the file is meaningful', () => {
    const ordered = [
      { match: { status: 403 }, as: 'challenge' as const, retryable: 'no' as const },
      { match: { status: 403 }, as: 'auth_expired' as const, retryable: 'no' as const },
    ];
    expect(matchErrorRule(ordered, 403, '')?.as).toBe('challenge');
  });
});

describe('buildRequest', () => {
  const declaration = parseDeclaration(deepseekYaml);
  const channel = declaration.channels[0]!;
  const context = {
    req: { prompt: 'hi' },
    auth: { token: 't' },
    state: { sessionId: 's1' },
    vars: { pow: 'p' },
    extracted: {},
    env: {},
    channel: { id: 'web', base: channel.base ?? '' },
    now: { unixMs: 0, unixS: 0, iso: '1970-01-01T00:00:00.000Z' },
  };

  it('joins the channel base and the step path', () => {
    const request = buildRequest(
      { method: 'GET', path: '/api/x' },
      channel,
      declaration,
      context,
      'test',
    );
    expect(request.url).toBe('https://chat.deepseek.test/api/x');
  });

  it('honours an absolute url over the base', () => {
    const request = buildRequest(
      { method: 'GET', url: 'https://cdn.deepseek.test/f.wasm' },
      channel,
      declaration,
      context,
      'test',
    );
    expect(request.url).toBe('https://cdn.deepseek.test/f.wasm');
  });

  it('appends query parameters, encoded', () => {
    const request = buildRequest(
      { method: 'GET', path: '/s', query: { q: '{{req.prompt}} there', n: '2' } },
      channel,
      declaration,
      context,
      'test',
    );
    expect(new URL(request.url).searchParams.get('q')).toBe('hi there');
    expect(new URL(request.url).searchParams.get('n')).toBe('2');
  });

  it('builds a form body and sets the content type', () => {
    const request = buildRequest(
      { method: 'POST', path: '/f', form: { a: '{{state.sessionId}}', b: 'x y' } },
      channel,
      declaration,
      context,
      'test',
    );
    expect(request.body).toBe('a=s1&b=x+y');
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('passes a raw body through the template', () => {
    const request = buildRequest(
      { method: 'POST', path: '/r', body: 'session={{state.sessionId}}' },
      channel,
      declaration,
      context,
      'test',
    );
    expect(request.body).toBe('session=s1');
    expect(request.headers['content-type']).toBeUndefined();
  });

  it('carries the declared header order, which is fingerprint material', () => {
    const ordered = parseDeclaration(
      deepseekYaml.replace(
        '      impersonate: true',
        '      impersonate: true\n      headerOrder: [host, user-agent, accept]',
      ),
    );
    const request = buildRequest(
      { method: 'GET', path: '/x' },
      ordered.channels[0]!,
      ordered,
      context,
      'test',
    );
    expect(request.headerOrder).toEqual(['host', 'user-agent', 'accept']);
  });

  it('lowercases header names so a declaration cannot send two of the same', () => {
    const request = buildRequest(
      { method: 'GET', path: '/x', headers: { 'X-Custom': '1', 'x-custom': '2' } },
      channel,
      declaration,
      context,
      'test',
    );
    expect(request.headers['x-custom']).toBe('2');
    expect(Object.keys(request.headers).filter((k) => k.toLowerCase() === 'x-custom')).toHaveLength(1);
  });

  it('lets a step header override the fingerprint default', () => {
    const request = buildRequest(
      { method: 'GET', path: '/x', headers: { 'x-client-locale': 'ru_RU' } },
      channel,
      declaration,
      context,
      'test',
    );
    expect(request.headers['x-client-locale']).toBe('ru_RU');
  });

  it('passes the timeout through', () => {
    const request = buildRequest(
      { method: 'GET', path: '/x', timeoutMs: 5000 },
      channel,
      declaration,
      context,
      'test',
    );
    expect(request.timeoutMs).toBe(5000);
  });
});

/* ──────────────────────────────────── helpers ──────────────────────────────────── */

/** The action a synchronous failure tells the user to take. */
function capturedAction(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DeclarationExecutionError) return error.omni.userAction;
    throw error;
  }
  throw new Error('expected a failure, and it succeeded');
}

async function drain(iterator: AsyncGenerator<UMSEvent>): Promise<UMSEvent[]> {
  const events: UMSEvent[] = [];
  for await (const event of iterator) events.push(event);
  return events;
}

async function capture(promise: Promise<unknown>): Promise<DeclarationExecutionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DeclarationExecutionError) return error;
    throw error;
  }
  throw new Error('expected the flow to fail, and it succeeded');
}
