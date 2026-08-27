/**
 * A real WebAssembly module, assembled byte by byte, that speaks the wasm-bindgen ABI
 * the DeepSeek proof-of-work solver uses.
 *
 * Why build one instead of stubbing `instantiateWasm` in tests: the part of that code
 * which breaks silently is the pointer arithmetic — a bump allocator, a shadow stack
 * that must be restored, an i32 status and an f64 answer read out of linear memory at
 * hand-computed offsets. A JavaScript fake will happily agree with a wrong offset,
 * because it is the same wrong offset on both sides. A real WebAssembly instance will
 * not: the memory layout is enforced by the runtime, `f64.store` at the wrong address
 * traps, and an unaligned or out-of-bounds access is an error rather than an opinion.
 *
 * What it deliberately does not do is solve the actual hash puzzle. That algorithm
 * lives inside DeepSeek's own module and is not documented anywhere we may rely on
 * (§12.1 — nothing is invented here). This module returns a deterministic answer
 * derived from its inputs, which is enough to exercise every line of our glue and
 * honest about being nothing more.
 */

/* ────────────────────────────── a minimal wasm encoder ────────────────────────────── */

function unsignedLeb(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

function signedLeb(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  for (;;) {
    const byte = remaining & 0x7f;
    remaining >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((remaining === 0 && !signBit) || (remaining === -1 && signBit)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 0x80);
  }
}

/** A section is its id, its byte length, then its content. */
function section(id: number, content: number[]): number[] {
  return [id, ...unsignedLeb(content.length), ...content];
}

/** A vector is its element count followed by the elements. */
function vector(items: number[][]): number[] {
  return [...unsignedLeb(items.length), ...items.flat()];
}

function name(text: string): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  return [...unsignedLeb(bytes.length), ...bytes];
}

const I32 = 0x7f;

const op = {
  end: 0x0b,
  localGet: 0x20,
  globalGet: 0x23,
  globalSet: 0x24,
  i32Store: 0x36,
  f64Store: 0x39,
  i32Const: 0x41,
  i32Add: 0x6a,
  i32And: 0x71,
  f64ConvertI32S: 0xb7,
} as const;

/**
 * Globals: 0 is the bump-allocator cursor, 1 is the shadow stack pointer. Both start
 * where wasm-bindgen's own output puts them — the heap low in memory, the stack at the
 * top growing down — because our glue calls `__wbindgen_add_to_stack_pointer(-16)` and
 * expects the result to be a usable address.
 */
const HEAP_START = 1024;
const STACK_START = 65536;

function buildModule(): Uint8Array {
  const types = vector([
    [0x60, ...vector([[I32], [I32]]), ...vector([[I32]])], // (i32, i32) -> i32
    [0x60, ...vector([[I32]]), ...vector([[I32]])], // (i32) -> i32
    [0x60, ...vector([[I32], [I32], [I32], [I32], [I32], [I32]]), ...vector([])], // 6x i32 -> ()
  ]);

  const functions = vector([[0], [1], [2]]);

  // One page. The allocator never frees, and one request needs a few hundred bytes.
  const memories = vector([[0x00, ...unsignedLeb(1)]]);

  const globals = vector([
    [I32, 0x01, op.i32Const, ...signedLeb(HEAP_START), op.end],
    [I32, 0x01, op.i32Const, ...signedLeb(STACK_START), op.end],
  ]);

  const exports = vector([
    [...name('memory'), 0x02, 0x00],
    [...name('__wbindgen_export_0'), 0x00, 0x00],
    [...name('__wbindgen_add_to_stack_pointer'), 0x00, 0x01],
    [...name('wasm_solve'), 0x00, 0x02],
  ]);

  // __wbindgen_export_0(size, align) -> ptr : bump, rounded up to 8 bytes.
  const alloc = [
    op.globalGet, 0x00,
    op.globalGet, 0x00,
    op.localGet, 0x00,
    op.i32Add,
    op.i32Const, ...signedLeb(7),
    op.i32Add,
    op.i32Const, ...signedLeb(-8),
    op.i32And,
    op.globalSet, 0x00,
    op.end,
  ];

  // __wbindgen_add_to_stack_pointer(delta) -> sp
  const addToStack = [
    op.globalGet, 0x01,
    op.localGet, 0x00,
    op.i32Add,
    op.globalSet, 0x01,
    op.globalGet, 0x01,
    op.end,
  ];

  // wasm_solve(sp, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)
  // Writes status=1 at [sp] and the answer as f64 at [sp+8], exactly where the glue
  // in `solveDeepSeekPow` reads them.
  const solve = [
    op.localGet, 0x00,
    op.i32Const, ...signedLeb(1),
    op.i32Store, 0x02, 0x00,
    op.localGet, 0x00,
    op.localGet, 0x02,
    op.localGet, 0x04,
    op.i32Add,
    op.localGet, 0x05,
    op.i32Add,
    op.f64ConvertI32S,
    op.f64Store, 0x03, 0x08,
    op.end,
  ];

  const body = (code: number[]): number[] => {
    const withLocals = [0x00, ...code];
    return [...unsignedLeb(withLocals.length), ...withLocals];
  };

  const codes = vector([body(alloc), body(addToStack), body(solve)]);

  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...section(1, types),
    ...section(3, functions),
    ...section(5, memories),
    ...section(6, globals),
    ...section(7, exports),
    ...section(10, codes),
  ]);
}

let cached: Uint8Array | undefined;

/** The module bytes, as the real one would be served over HTTP. */
export function powWasmBytes(): Uint8Array {
  cached ??= buildModule();
  return cached;
}

/**
 * What the module computes, so a caller can assert on it without reimplementing the
 * arithmetic. `challenge` and `prefix` are the two strings the glue writes into linear
 * memory; the answer depends on both, which is what makes a mixed-up pointer visible.
 */
export function expectedAnswer(challenge: string, prefix: string, difficulty: number): number {
  const encoder = new TextEncoder();
  return encoder.encode(challenge).length + encoder.encode(prefix).length + difficulty;
}
