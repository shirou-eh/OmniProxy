import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  builtinTransforms,
  clearWasmCache,
  defaultTransformContext,
  solveDeepSeekPow,
  TransformError,
  TransformRegistry,
  type TransformContext,
  type WasmPowInstance,
} from '../src/transforms.js';

/** A context with every source of nondeterminism pinned, so assertions can be exact. */
function fixedContext(overrides: Partial<TransformContext> = {}): TransformContext {
  return {
    now: () => 1_700_000_000_000,
    uuid: () => '11111111-2222-4333-8444-555555555555',
    randomBytes: (size) => Buffer.alloc(size, 0xab),
    ...overrides,
  };
}

const ctx = fixedContext();
const run = (name: string, args: Record<string, unknown> = {}) =>
  new TransformRegistry().run(name, args, ctx);

describe('the transform registry', () => {
  it('lists what a declaration is allowed to name', () => {
    const names = new TransformRegistry().names();
    expect(names).toContain('deepseek-pow-v0');
    expect(names).toContain('sha256');
    expect(names).toEqual([...names].sort());
  });

  it('refuses an unknown transform and says what exists', async () => {
    await expect(run('rm -rf')).rejects.toThrow(TransformError);
    await expect(run('rm -rf')).rejects.toThrow(/no such transform/);
    // The list of alternatives lives on userAction, where a CLI can print it as the
    // next step rather than burying it in an exception message.
    const error = await run('rm -rf').then(
      () => undefined,
      (thrown: unknown) => thrown as TransformError,
    );
    expect(error?.userAction).toMatch(/Available: /);
    expect(error?.userAction).toMatch(/deepseek-pow-v0/);
  });

  it('accepts user-supplied transforms and lets them shadow built-ins', async () => {
    // ADR-0003: a third-party provider module may bring its own signing code.
    const registry = new TransformRegistry({ 'my-sign': () => 'signed', sha256: () => 'shadowed' });
    expect(registry.has('my-sign')).toBe(true);
    await expect(registry.run('my-sign', {}, ctx)).resolves.toBe('signed');
    await expect(registry.run('sha256', { value: 'x' }, ctx)).resolves.toBe('shadowed');
  });
});

describe('the built-in transforms', () => {
  it('takes identifiers and clocks from the context, never from the ambient world', async () => {
    await expect(run('uuid-v4')).resolves.toBe('11111111-2222-4333-8444-555555555555');
    await expect(run('unix-ms')).resolves.toBe('1700000000000');
    await expect(run('unix-s')).resolves.toBe('1700000000');
    await expect(run('iso-now')).resolves.toBe('2023-11-14T22:13:20.000Z');
    await expect(run('random-hex', { bytes: 4 })).resolves.toBe('abababab');
  });

  it('defaults random-hex to 16 bytes and rejects impossible sizes', async () => {
    await expect(run('random-hex')).resolves.toHaveLength(32);
    await expect(run('random-hex', { bytes: 0 })).rejects.toThrow(TransformError);
    await expect(run('random-hex', { bytes: 5000 })).rejects.toThrow(TransformError);
    await expect(run('random-hex', { bytes: 1.5 })).rejects.toThrow(TransformError);
  });

  it('encodes', async () => {
    await expect(run('base64', { value: 'привет' })).resolves.toBe(
      Buffer.from('привет').toString('base64'),
    );
    await expect(run('base64url', { value: '??>>' })).resolves.toBe(
      Buffer.from('??>>').toString('base64url'),
    );
    await expect(run('hex', { value: 'ab' })).resolves.toBe('6162');
    await expect(run('json-stringify', { value: { a: 1 } })).resolves.toBe('{"a":1}');
    await expect(run('json-stringify', {})).resolves.toBe('null');
    await expect(run('url-encode-form', { value: { a: '1 2', b: { c: 3 } } })).resolves.toBe(
      'a=1+2&b=%7B%22c%22%3A3%7D',
    );
    await expect(run('url-encode-form', { value: 'nope' })).rejects.toThrow(TransformError);
  });

  it('digests, honouring the encoding argument', async () => {
    const expected = createHash('sha256').update('abc').digest('hex');
    await expect(run('sha256', { value: 'abc' })).resolves.toBe(expected);
    await expect(run('sha256', { value: 'abc', encoding: 'base64' })).resolves.toBe(
      createHash('sha256').update('abc').digest('base64'),
    );
    await expect(run('sha256', { value: 'abc', encoding: 'nonsense' })).resolves.toBe(expected);
    await expect(run('sha1', { value: 'abc' })).resolves.toBe(
      createHash('sha1').update('abc').digest('hex'),
    );
    await expect(run('md5', { value: 'abc' })).resolves.toBe(
      createHash('md5').update('abc').digest('hex'),
    );
    await expect(run('hmac-sha256', { key: 'k', data: 'd' })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('stringifies structured arguments rather than digesting "[object Object]"', async () => {
    await expect(run('sha256', { value: { a: 1 } })).resolves.toBe(
      createHash('sha256').update('{"a":1}').digest('hex'),
    );
  });

  it('names the missing argument when one is absent', async () => {
    await expect(run('sha256', {})).rejects.toThrow(/missing argument "value"/);
    await expect(run('hmac-sha256', { key: 'k' })).rejects.toThrow(/missing argument "data"/);
  });

  it('reads a JWT claim without verifying it', async () => {
    const token = `x.${Buffer.from(JSON.stringify({ sub: 'u1', n: 5 })).toString('base64url')}.y`;
    await expect(run('jwt-decode-claim', { token, claim: 'sub' })).resolves.toBe('u1');
    await expect(run('jwt-decode-claim', { token, claim: 'n' })).resolves.toBe('5');
    await expect(run('jwt-decode-claim', { token, claim: 'nope' })).rejects.toThrow(/no claim/);
    await expect(run('jwt-decode-claim', { token: 'notajwt', claim: 'sub' })).rejects.toThrow(
      /not a JWT/,
    );
    await expect(
      run('jwt-decode-claim', { token: 'a.bm90LWpzb24.c', claim: 'sub' }),
    ).rejects.toThrow(/not JSON/);
  });
});

/* ───────────────────────────── the DeepSeek proof of work ───────────────────────────── */

/**
 * A stand-in for the real solver that speaks the same wasm-bindgen ABI: a bump
 * allocator over linear memory, a shadow stack, an i32 status and an f64 answer
 * written at the stack pointer. It solves nothing — it records what it was handed,
 * which is exactly what needs testing: the pointer arithmetic is the part that breaks
 * silently, and the real module cannot be downloaded in CI.
 */
function fakeWasm(answer = 12345, status = 1) {
  const memory = { buffer: new ArrayBuffer(65536) };
  let bump = 1024;
  let stack = 32768;
  const seen: { challenge?: string; prefix?: string; difficulty?: number; sp?: number } = {};

  const instance: WasmPowInstance = {
    memory,
    __wbindgen_export_0(size: number) {
      const ptr = bump;
      bump += size;
      return ptr;
    },
    __wbindgen_add_to_stack_pointer(delta: number) {
      stack += delta;
      return stack;
    },
    wasm_solve(
      sp: number,
      challengePtr: number,
      challengeLen: number,
      prefixPtr: number,
      prefixLen: number,
      difficulty: number,
    ) {
      const decoder = new TextDecoder();
      seen.challenge = decoder.decode(new Uint8Array(memory.buffer, challengePtr, challengeLen));
      seen.prefix = decoder.decode(new Uint8Array(memory.buffer, prefixPtr, prefixLen));
      seen.difficulty = difficulty;
      seen.sp = sp;
      const view = new DataView(memory.buffer);
      view.setInt32(sp, status, true);
      view.setFloat64(sp + 8, answer, true);
    },
  };

  return { instance, seen };
}

const challenge = {
  algorithm: 'DeepSeekHashV1',
  challenge: 'c0ffee',
  salt: 'salty',
  difficulty: 144000,
  expire_at: 1_700_000_123_000,
  signature: 'sig-1',
};

function wasmContext(fake: ReturnType<typeof fakeWasm>, bytes = new Uint8Array([0, 97, 115, 109])) {
  let fetches = 0;
  const context = fixedContext({
    fetchBytes: async () => {
      fetches += 1;
      return bytes;
    },
    instantiateWasm: async () => fake.instance,
  });
  return { context, fetchCount: () => fetches };
}

describe('deepseek-pow-v0', () => {
  beforeEach(() => clearWasmCache());

  it('feeds the solver exactly what the original code did', async () => {
    const fake = fakeWasm();
    const { context } = wasmContext(fake);

    const answer = await solveDeepSeekPow(challenge, 'https://cdn.test/pow.wasm', context);

    expect(answer).toBe(12345);
    expect(fake.seen.challenge).toBe('c0ffee');
    // The prefix format is `${salt}_${expire_at}_` — getting it wrong yields a
    // plausible-looking header that the server rejects with a generic error.
    expect(fake.seen.prefix).toBe('salty_1700000123000_');
    expect(fake.seen.difficulty).toBe(144000);
  });

  it('returns the header value the provider expects, not the raw answer', async () => {
    const fake = fakeWasm();
    const { context } = wasmContext(fake);

    const header = await builtinTransforms['deepseek-pow-v0']!(
      { challenge, wasmUrl: 'https://cdn.test/pow.wasm', targetPath: '/api/v0/chat/completion' },
      context,
    );

    expect(JSON.parse(Buffer.from(header as string, 'base64').toString('utf8'))).toEqual({
      algorithm: 'DeepSeekHashV1',
      challenge: 'c0ffee',
      salt: 'salty',
      answer: 12345,
      signature: 'sig-1',
      target_path: '/api/v0/chat/completion',
    });
  });

  it('truncates a fractional answer, because the field is an integer', async () => {
    const { context } = wasmContext(fakeWasm(999.9));
    await expect(solveDeepSeekPow(challenge, 'https://cdn.test/pow.wasm', context)).resolves.toBe(
      999,
    );
  });

  it('fails loudly when the solver reports no answer', async () => {
    const { context } = wasmContext(fakeWasm(0, 0));
    await expect(solveDeepSeekPow(challenge, 'https://cdn.test/pow.wasm', context)).rejects.toThrow(
      /returned no answer/,
    );
  });

  it('restores the shadow stack, so a second solve does not drift', async () => {
    const fake = fakeWasm();
    const { context } = wasmContext(fake);
    await solveDeepSeekPow(challenge, 'https://cdn.test/pow.wasm', context);
    const first = fake.seen.sp;
    await solveDeepSeekPow(challenge, 'https://cdn.test/pow.wasm', context);
    expect(fake.seen.sp).toBe(first);
  });

  it('downloads the module once and reuses it', async () => {
    const fake = fakeWasm();
    const { context, fetchCount } = wasmContext(fake);
    await solveDeepSeekPow(challenge, 'https://cdn.test/pow.wasm', context);
    await solveDeepSeekPow(challenge, 'https://cdn.test/pow.wasm', context);
    expect(fetchCount()).toBe(1);
  });

  it('does not cache a failed download, so one bad minute cannot poison the process', async () => {
    let attempts = 0;
    const fake = fakeWasm();
    const context = fixedContext({
      fetchBytes: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
        return new Uint8Array([0]);
      },
      instantiateWasm: async () => fake.instance,
    });

    await expect(solveDeepSeekPow(challenge, 'https://cdn.test/p.wasm', context)).rejects.toThrow(
      /network down/,
    );
    await expect(solveDeepSeekPow(challenge, 'https://cdn.test/p.wasm', context)).resolves.toBe(
      12345,
    );
    expect(attempts).toBe(2);
  });

  it('says so plainly when the context cannot load WebAssembly at all', async () => {
    await expect(solveDeepSeekPow(challenge, 'https://cdn.test/p.wasm', ctx)).rejects.toThrow(
      /cannot load WebAssembly/,
    );
  });

  it('rejects a challenge that is not the object from create_pow_challenge', async () => {
    const { context } = wasmContext(fakeWasm());
    await expect(
      builtinTransforms['deepseek-pow-v0']!(
        { challenge: 'a string', wasmUrl: 'u', targetPath: '/p' },
        context,
      ),
    ).rejects.toThrow(/must be the object from create_pow_challenge/);
  });
});

describe('defaultTransformContext', () => {
  it('supplies real entropy and a real clock', () => {
    const real = defaultTransformContext();
    expect(real.uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(real.randomBytes(8)).toHaveLength(8);
    expect(real.now()).toBeGreaterThan(1_600_000_000_000);
    expect(typeof real.fetchBytes).toBe('function');
    expect(typeof real.instantiateWasm).toBe('function');
  });
});
