import { afterEach, describe, expect, it } from 'vitest';
import { startDeepSeekSim, simWasmPath, type DeepSeekSim } from '../src/deepseek.js';
import { expectedAnswer, powWasmBytes } from '../src/pow-wasm.js';

/**
 * Tests for the simulator itself.
 *
 * A test double that is wrong is worse than no test double: everything downstream
 * agrees with it, and the agreement is mistaken for evidence. So the simulator is
 * held to the same standard as the code it stands in for — in particular it must
 * *refuse* the things the real service refuses, or a declaration that gets them wrong
 * would sail through the pipeline test and fail on a user's first request.
 */

/**
 * `lib: ES2023` has no WebAssembly — it lives in the DOM lib, and pulling that in to
 * get one namespace would drag every browser global along with it. The same local
 * declaration appears in the engine's transforms for the same reason.
 */
declare const WebAssembly: {
  compile(bytes: Uint8Array): Promise<unknown>;
  instantiate(
    module: unknown,
    imports: Record<string, unknown>,
  ): Promise<{ exports: Record<string, unknown> }>;
};

let sim: DeepSeekSim | undefined;

afterEach(async () => {
  await sim?.close();
  sim = undefined;
});

const TOKEN = 'sim-token';

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, json: safeJson(text), response };
}

function safeJson(text: string): Record<string, any> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

/** Mints a challenge and returns the header value a correct client would send. */
async function solvedHeader(base: string, overrides: Record<string, unknown> = {}) {
  const challenge = (
    await post(`${base}/api/v0/chat/create_pow_challenge`, { target_path: '/api/v0/chat/completion' })
  ).json?.['data']['biz_data']['challenge'];

  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer: 12345,
      signature: challenge.signature,
      target_path: '/api/v0/chat/completion',
      ...overrides,
    }),
  ).toString('base64');
}

describe('the DeepSeek simulator', () => {
  it('refuses everything without a token, before looking at anything else', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const result = await post(
      `${sim.url}/api/v0/chat/create_pow_challenge`,
      { target_path: '/api/v0/chat/completion' },
      { authorization: 'Bearer nope' },
    );
    expect(result.status).toBe(401);
    expect(result.json?.['code']).toBe(40100);
  });

  it('issues a challenge only for the path it was asked for', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const good = await post(`${sim.url}/api/v0/chat/create_pow_challenge`, {
      target_path: '/api/v0/chat/completion',
    });
    expect(good.status).toBe(200);
    const challenge = good.json?.['data']['biz_data']['challenge'];
    expect(challenge).toMatchObject({ algorithm: 'DeepSeekHashV1' });
    expect(typeof challenge.salt).toBe('string');
    expect(typeof challenge.signature).toBe('string');
    expect(challenge.expire_at).toBeGreaterThan(Date.now());

    const bad = await post(`${sim.url}/api/v0/chat/create_pow_challenge`, {
      target_path: '/api/v0/something/else',
    });
    expect(bad.status).toBe(400);
  });

  it('answers a session create with both id shapes legacy reads', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const result = await post(`${sim.url}/api/v0/chat_session/create`, {});
    const bizData = result.json?.['data']['biz_data'];
    expect(bizData.id).toBe(bizData.chat_session.id);
    expect(sim.sessions).toEqual([bizData.id]);
  });

  it('rejects a completion with no proof of work at all', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const result = await post(`${sim.url}/api/v0/chat/completion`, { prompt: 'hi' });
    expect(result.status).toBe(403);
    expect(result.json?.['msg']).toMatch(/missing X-DS-PoW-Response/);
  });

  it('rejects a tampered proof of work, field by field', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const session = (await post(`${sim.url}/api/v0/chat_session/create`, {})).json?.['data'][
      'biz_data'
    ].id;

    const cases: [Record<string, unknown>, RegExp][] = [
      [{ salt: 'wrong' }, /salt/],
      [{ signature: 'wrong' }, /signature/],
      [{ algorithm: 'MD5' }, /algorithm/],
      [{ target_path: '/elsewhere' }, /target_path/],
      [{ answer: 0 }, /positive number/],
      [{ answer: 'twelve' }, /positive number/],
      [{ challenge: 'never-issued' }, /unknown or already used/],
    ];

    for (const [override, expected] of cases) {
      const header = await solvedHeader(sim.url, override);
      const result = await post(
        `${sim.url}/api/v0/chat/completion`,
        { chat_session_id: session, parent_message_id: null, prompt: 'hi' },
        { 'x-ds-pow-response': header },
      );
      expect(result.status, JSON.stringify(override)).toBe(403);
      expect(result.json?.['msg']).toMatch(expected);
    }
  });

  it('spends a challenge on use, so a cached header fails the second time', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const session = (await post(`${sim.url}/api/v0/chat_session/create`, {})).json?.['data'][
      'biz_data'
    ].id;
    const header = await solvedHeader(sim.url);
    const body = { chat_session_id: session, parent_message_id: null, prompt: 'hi' };

    const first = await post(`${sim.url}/api/v0/chat/completion`, body, {
      'x-ds-pow-response': header,
    });
    expect(first.status).toBe(200);

    const second = await post(`${sim.url}/api/v0/chat/completion`, body, {
      'x-ds-pow-response': header,
    });
    expect(second.status).toBe(403);
    expect(second.json?.['msg']).toMatch(/already used/);
  });

  it('rejects an unknown session, a missing prompt and a missing parent field', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const base = sim.url;
    const session = (await post(`${base}/api/v0/chat_session/create`, {})).json?.['data'][
      'biz_data'
    ].id;

    const send = async (body: unknown) =>
      post(`${base}/api/v0/chat/completion`, body, {
        'x-ds-pow-response': await solvedHeader(base),
      });

    expect((await send({ chat_session_id: 'gone', parent_message_id: null, prompt: 'x' })).status).toBe(404);
    expect((await send({ chat_session_id: session, parent_message_id: null, prompt: '' })).status).toBe(400);
    // Present-but-null is right; absent is a different request, and the real service
    // tells them apart. A declaration that drops the key must not pass here.
    expect((await send({ chat_session_id: session, prompt: 'x' })).status).toBe(400);
  });

  it('streams json-patch frames with a sticky path', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, reply: 'abcdefgh' });
    const session = (await post(`${sim.url}/api/v0/chat_session/create`, {})).json?.['data'][
      'biz_data'
    ].id;
    const result = await post(
      `${sim.url}/api/v0/chat/completion`,
      { chat_session_id: session, parent_message_id: null, prompt: 'hi' },
      { 'x-ds-pow-response': await solvedHeader(sim.url) },
    );

    expect(result.response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const frames = result.text
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => block.slice(6));

    expect(frames.at(-1)).toBe('[DONE]');
    const parsed = frames.slice(0, -1).map((frame) => JSON.parse(frame) as Record<string, unknown>);
    // Most frames carry no path: that is the sticky-path behaviour a parser must
    // handle, and a simulator that repeated the path everywhere would hide the bug.
    expect(parsed.filter((frame) => frame['p'] === undefined).length).toBeGreaterThan(1);
    expect(parsed.some((frame) => frame['p'] === 'response/fragments')).toBe(true);
    expect(parsed.some((frame) => frame['response_message_id'] !== undefined)).toBe(true);
  });

  it('serves the proof-of-work module without asking for a token', async () => {
    sim = await startDeepSeekSim({ token: TOKEN });
    const response = await fetch(`${sim.url}${simWasmPath()}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/wasm');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(powWasmBytes());
  });

  it('can be told to fail a specific attempt', async () => {
    sim = await startDeepSeekSim({ token: TOKEN, failCompletionWith: { attempt: 1, status: 429 } });
    const session = (await post(`${sim.url}/api/v0/chat_session/create`, {})).json?.['data'][
      'biz_data'
    ].id;
    const body = { chat_session_id: session, parent_message_id: null, prompt: 'hi' };

    expect(
      (await post(`${sim.url}/api/v0/chat/completion`, body, {
        'x-ds-pow-response': await solvedHeader(sim.url),
      })).status,
    ).toBe(429);
    expect(
      (await post(`${sim.url}/api/v0/chat/completion`, body, {
        'x-ds-pow-response': await solvedHeader(sim.url),
      })).status,
    ).toBe(200);
  });
});

/* ─────────────────────────────── the WebAssembly module ─────────────────────────────── */

describe('the hand-built proof-of-work module', () => {
  it('compiles and exports exactly the wasm-bindgen names our glue calls', async () => {
    const module = await WebAssembly.compile(powWasmBytes());
    const instance = await WebAssembly.instantiate(module, { wbg: {} });
    expect(Object.keys(instance.exports).sort()).toEqual([
      '__wbindgen_add_to_stack_pointer',
      '__wbindgen_export_0',
      'memory',
      'wasm_solve',
    ]);
  });

  it('allocates without overlapping, and aligns to eight bytes', async () => {
    const exports = await instantiate();
    const first = exports.__wbindgen_export_0(6, 1);
    const second = exports.__wbindgen_export_0(6, 1);
    expect(second).toBeGreaterThanOrEqual(first + 6);
    expect(second % 8).toBe(0);
  });

  it('moves the shadow stack and puts it back', async () => {
    const exports = await instantiate();
    const before = exports.__wbindgen_add_to_stack_pointer(0);
    const sp = exports.__wbindgen_add_to_stack_pointer(-16);
    expect(sp).toBe(before - 16);
    expect(exports.__wbindgen_add_to_stack_pointer(16)).toBe(before);
  });

  it('writes an i32 status and an f64 answer where the glue reads them', async () => {
    const exports = await instantiate();
    const encoder = new TextEncoder();
    const challenge = encoder.encode('c0ffee');
    const prefix = encoder.encode('salty_1700000000000_');

    const challengePtr = exports.__wbindgen_export_0(challenge.length, 1) >>> 0;
    const prefixPtr = exports.__wbindgen_export_0(prefix.length, 1) >>> 0;
    new Uint8Array(exports.memory.buffer, challengePtr, challenge.length).set(challenge);
    new Uint8Array(exports.memory.buffer, prefixPtr, prefix.length).set(prefix);

    const sp = exports.__wbindgen_add_to_stack_pointer(-16);
    exports.wasm_solve(sp, challengePtr, challenge.length, prefixPtr, prefix.length, 144000);

    const view = new DataView(exports.memory.buffer);
    expect(view.getInt32(sp, true)).toBe(1);
    expect(view.getFloat64(sp + 8, true)).toBe(
      expectedAnswer('c0ffee', 'salty_1700000000000_', 144000),
    );
  });

  it('gives a different answer when the pointers are swapped', async () => {
    // The point of a real module rather than a JavaScript fake: a mixed-up pointer is
    // visible here. Both strings have different lengths, so the answer moves.
    const exports = await instantiate();
    const encoder = new TextEncoder();
    const a = encoder.encode('short');
    const b = encoder.encode('a much longer prefix');
    const pa = exports.__wbindgen_export_0(a.length, 1) >>> 0;
    const pb = exports.__wbindgen_export_0(b.length, 1) >>> 0;
    new Uint8Array(exports.memory.buffer, pa, a.length).set(a);
    new Uint8Array(exports.memory.buffer, pb, b.length).set(b);

    const view = new DataView(exports.memory.buffer);
    const sp = exports.__wbindgen_add_to_stack_pointer(-16);
    exports.wasm_solve(sp, pa, a.length, pb, b.length, 0);
    const correct = view.getFloat64(sp + 8, true);
    exports.wasm_solve(sp, pa, b.length, pb, a.length, 0);
    expect(view.getFloat64(sp + 8, true)).toBe(correct);

    exports.wasm_solve(sp, pa, a.length, pb, a.length, 0);
    expect(view.getFloat64(sp + 8, true)).not.toBe(correct);
  });
});

interface PowExports {
  memory: { buffer: ArrayBuffer };
  __wbindgen_export_0(size: number, align: number): number;
  __wbindgen_add_to_stack_pointer(delta: number): number;
  wasm_solve(
    sp: number,
    challengePtr: number,
    challengeLen: number,
    prefixPtr: number,
    prefixLen: number,
    difficulty: number,
  ): void;
}

async function instantiate(): Promise<PowExports> {
  const module = await WebAssembly.compile(powWasmBytes());
  const instance = await WebAssembly.instantiate(module, { wbg: {} });
  return instance.exports as unknown as PowExports;
}
