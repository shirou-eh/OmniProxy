import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

/**
 * The transform registry — ADR-0002 level 2.
 *
 * A declaration cannot compute. When a provider needs a value that must be derived —
 * a signature, a nonce, a proof of work — the declaration names a transform and passes
 * it data. The transform itself is ordinary code here: reviewed, unit-tested, shared
 * by every provider that needs it.
 *
 * This is the seam that keeps the declarative approach honest. Without it, one
 * computed header would drag an entire provider into a code adapter, and with it the
 * auth, the capability model and the stream mapping — everything that can otherwise
 * be fixed by editing YAML at 3am.
 *
 * Everything a transform touches comes through `TransformContext`. No transform reads
 * the clock, the environment or the network on its own, or record/replay would be
 * impossible and every test would be a coin flip.
 */

export interface TransformContext {
  now(): number;
  uuid(): string;
  randomBytes(size: number): Buffer;
  /** Fetches bytes (the PoW WASM module). Absent when the engine runs offline. */
  fetchBytes?(url: string): Promise<Uint8Array>;
  /** Instantiates a WebAssembly module. Injected so the ABI can be tested offline. */
  instantiateWasm?(bytes: Uint8Array): Promise<WasmPowInstance>;
}

/** The exports `lib/pow.js` relies on, named exactly as wasm-bindgen emits them. */
/**
 * Declared locally rather than pulled from lib.dom: this is a Node package, and
 * adding the DOM lib to get one namespace would drag every browser global in with it.
 */
declare const WebAssembly: {
  compile(bytes: Uint8Array): Promise<unknown>;
  instantiate(module: unknown, imports: Record<string, unknown>): Promise<{ exports: unknown }>;
};

export interface WasmMemory {
  buffer: ArrayBuffer;
}

export interface WasmPowInstance {
  memory: WasmMemory;
  __wbindgen_export_0(size: number, align: number): number;
  __wbindgen_add_to_stack_pointer(delta: number): number;
  wasm_solve(
    stackPointer: number,
    challengePtr: number,
    challengeLen: number,
    prefixPtr: number,
    prefixLen: number,
    difficulty: number,
  ): void;
}

export type Transform = (
  args: Record<string, unknown>,
  ctx: TransformContext,
) => Promise<string> | string;

export class TransformError extends Error {
  override readonly name = 'TransformError';
  constructor(
    readonly transform: string,
    message: string,
    readonly userAction: string,
  ) {
    super(`${transform}: ${message}`);
  }
}

export function defaultTransformContext(): TransformContext {
  return {
    now: () => Date.now(),
    uuid: () => randomUUID(),
    randomBytes: (size) => randomBytes(size),
    fetchBytes: async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    instantiateWasm: async (bytes) => {
      const module = await WebAssembly.compile(bytes);
      const instance = await WebAssembly.instantiate(module, { wbg: {} });
      return instance.exports as unknown as WasmPowInstance;
    },
  };
}

/* ─────────────────────────────── the transforms ─────────────────────────────── */

function text(args: Record<string, unknown>, key: string, transform: string): string {
  const value = args[key];
  if (value === undefined || value === null) {
    throw new TransformError(transform, `missing argument "${key}"`, `Add ${key} under \`with:\`.`);
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function digestEncoding(args: Record<string, unknown>): 'hex' | 'base64' | 'base64url' {
  const encoding = args['encoding'];
  if (encoding === 'base64' || encoding === 'base64url' || encoding === 'hex') return encoding;
  return 'hex';
}

export const builtinTransforms: Record<string, Transform> = {
  'uuid-v4': (_args, ctx) => ctx.uuid(),

  'random-hex': (args, ctx) => {
    const size = Number(args['bytes'] ?? 16);
    if (!Number.isInteger(size) || size <= 0 || size > 1024) {
      throw new TransformError('random-hex', `bad byte count ${String(args['bytes'])}`, 'Use 1..1024.');
    }
    return ctx.randomBytes(size).toString('hex');
  },

  'unix-ms': (_args, ctx) => String(ctx.now()),
  'unix-s': (_args, ctx) => String(Math.floor(ctx.now() / 1000)),
  'iso-now': (_args, ctx) => new Date(ctx.now()).toISOString(),

  base64: (args) => Buffer.from(text(args, 'value', 'base64'), 'utf8').toString('base64'),
  base64url: (args) => Buffer.from(text(args, 'value', 'base64url'), 'utf8').toString('base64url'),
  hex: (args) => Buffer.from(text(args, 'value', 'hex'), 'utf8').toString('hex'),

  'json-stringify': (args) => JSON.stringify(args['value'] ?? null),

  sha256: (args) =>
    createHash('sha256').update(text(args, 'value', 'sha256')).digest(digestEncoding(args)),
  sha1: (args) => createHash('sha1').update(text(args, 'value', 'sha1')).digest(digestEncoding(args)),
  md5: (args) => createHash('md5').update(text(args, 'value', 'md5')).digest(digestEncoding(args)),

  'hmac-sha256': (args) =>
    createHmac('sha256', text(args, 'key', 'hmac-sha256'))
      .update(text(args, 'data', 'hmac-sha256'))
      .digest(digestEncoding(args)),

  'url-encode-form': (args) => {
    const value = args['value'];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TransformError('url-encode-form', 'value must be an object', 'Pass a mapping.');
    }
    const params = new URLSearchParams();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      params.append(key, typeof item === 'string' ? item : JSON.stringify(item));
    }
    return params.toString();
  },

  'jwt-decode-claim': (args) => {
    const token = text(args, 'token', 'jwt-decode-claim');
    const claim = text(args, 'claim', 'jwt-decode-claim');
    const payload = token.split('.')[1];
    if (!payload) {
      throw new TransformError('jwt-decode-claim', 'not a JWT', 'Check the token you passed in.');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new TransformError('jwt-decode-claim', 'payload is not JSON', 'Check the token.');
    }
    const value = (decoded as Record<string, unknown> | null)?.[claim];
    if (value === undefined) {
      throw new TransformError(
        'jwt-decode-claim',
        `no claim "${claim}" in the token`,
        'Check the claim name.',
      );
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  },

  /**
   * DeepSeek Web proof of work, ported from lib/pow.js.
   *
   * Returns the ready-to-send `X-DS-PoW-Response` header value: base64 of the
   * challenge echoed back with the solved answer. Everything about the WASM ABI —
   * the bump allocator, the stack pointer dance, reading an i32 status and an f64
   * answer out of linear memory — is the original code's, because it is the part
   * that was expensive to work out and is known to be correct.
   */
  'deepseek-pow-v0': async (args, ctx) => {
    const challenge = args['challenge'];
    if (challenge === null || typeof challenge !== 'object') {
      throw new TransformError(
        'deepseek-pow-v0',
        'challenge must be the object from create_pow_challenge',
        'Extract it first: `extract: { challenge: $.data.biz_data.challenge }`.',
      );
    }
    const wasmUrl = text(args, 'wasmUrl', 'deepseek-pow-v0');
    const targetPath = text(args, 'targetPath', 'deepseek-pow-v0');

    const answer = await solveDeepSeekPow(challenge as DeepSeekChallenge, wasmUrl, ctx);

    const fields = challenge as DeepSeekChallenge;
    return Buffer.from(
      JSON.stringify({
        algorithm: fields.algorithm,
        challenge: fields.challenge,
        salt: fields.salt,
        answer,
        signature: fields.signature,
        target_path: targetPath,
      }),
      'utf8',
    ).toString('base64');
  },
};

export interface DeepSeekChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
}

const wasmCache = new Map<string, Promise<Uint8Array>>();

export async function solveDeepSeekPow(
  challenge: DeepSeekChallenge,
  wasmUrl: string,
  ctx: TransformContext,
): Promise<number> {
  if (!ctx.fetchBytes || !ctx.instantiateWasm) {
    throw new TransformError(
      'deepseek-pow-v0',
      'this context cannot load WebAssembly',
      'Run the engine with a network-capable context, or inject instantiateWasm in tests.',
    );
  }

  let bytesPromise = wasmCache.get(wasmUrl);
  if (!bytesPromise) {
    bytesPromise = ctx.fetchBytes(wasmUrl);
    wasmCache.set(wasmUrl, bytesPromise);
    // A failed download must not be cached, or one bad minute poisons the process.
    bytesPromise.catch(() => wasmCache.delete(wasmUrl));
  }

  const exports = await ctx.instantiateWasm(await bytesPromise);

  const encoder = new TextEncoder();
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const challengeBytes = encoder.encode(challenge.challenge);
  const prefixBytes = encoder.encode(prefix);

  const challengePtr = exports.__wbindgen_export_0(challengeBytes.length, 1) >>> 0;
  const prefixPtr = exports.__wbindgen_export_0(prefixBytes.length, 1) >>> 0;
  new Uint8Array(exports.memory.buffer, challengePtr, challengeBytes.length).set(challengeBytes);
  new Uint8Array(exports.memory.buffer, prefixPtr, prefixBytes.length).set(prefixBytes);

  const stackPointer = exports.__wbindgen_add_to_stack_pointer(-16);
  exports.wasm_solve(
    stackPointer,
    challengePtr,
    challengeBytes.length,
    prefixPtr,
    prefixBytes.length,
    challenge.difficulty,
  );

  const view = new DataView(exports.memory.buffer);
  const status = view.getInt32(stackPointer, true);
  const answer = view.getFloat64(stackPointer + 8, true);
  exports.__wbindgen_add_to_stack_pointer(16);

  if (status === 0 || !Number.isFinite(answer) || answer <= 0) {
    throw new TransformError(
      'deepseek-pow-v0',
      'the solver returned no answer',
      'The challenge may have expired, or the WASM module changed. Re-run the capture.',
    );
  }

  return Math.floor(answer);
}

/** Only for tests: the module cache is process-wide by design. */
export function clearWasmCache(): void {
  wasmCache.clear();
}

export class TransformRegistry {
  readonly #transforms = new Map<string, Transform>();

  constructor(extra: Record<string, Transform> = {}) {
    for (const [name, transform] of Object.entries(builtinTransforms)) {
      this.#transforms.set(name, transform);
    }
    for (const [name, transform] of Object.entries(extra)) {
      this.#transforms.set(name, transform);
    }
  }

  has(name: string): boolean {
    return this.#transforms.has(name);
  }

  names(): string[] {
    return [...this.#transforms.keys()].sort();
  }

  async run(
    name: string,
    args: Record<string, unknown>,
    ctx: TransformContext,
  ): Promise<string> {
    const transform = this.#transforms.get(name);
    if (!transform) {
      throw new TransformError(
        name,
        'no such transform',
        `Available: ${this.names().join(', ')}. A declaration can only name transforms that exist.`,
      );
    }
    return transform(args, ctx);
  }
}
