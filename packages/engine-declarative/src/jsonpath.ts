/**
 * A deliberately small JSONPath subset.
 *
 * Supported: `$`, `.key`, `["key"]`, `[0]`, `[*]`, `..key` (recursive descent) and
 * `[?(@.k=='v')]` equality filters.
 *
 * Not supported, and never will be: expressions, arithmetic, scripts, functions.
 * Declarations are data that arrive from captures and from other people (ADR-0002);
 * a path language with an evaluator is a path language with a sandbox escape. The
 * cost of the restriction is that a genuinely exotic response needs a code adapter,
 * which is exactly the boundary that ADR is about.
 */

export type JsonPathSegment =
  | { kind: 'key'; name: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }
  | { kind: 'descend'; name: string }
  | { kind: 'filter'; name: string; equals: string };

export class JsonPathError extends Error {
  override readonly name = 'JsonPathError';
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

const cache = new Map<string, JsonPathSegment[]>();

export function parseJsonPath(path: string): JsonPathSegment[] {
  const cached = cache.get(path);
  if (cached) return cached;

  if (!path.startsWith('$')) {
    throw new JsonPathError(path, 'must start with $');
  }

  const segments: JsonPathSegment[] = [];
  let i = 1;

  while (i < path.length) {
    const char = path[i];

    if (char === '.') {
      if (path[i + 1] === '.') {
        const start = i + 2;
        const end = findIdentifierEnd(path, start);
        if (end === start) throw new JsonPathError(path, 'recursive descent needs a key');
        segments.push({ kind: 'descend', name: path.slice(start, end) });
        i = end;
        continue;
      }
      const start = i + 1;
      const end = findIdentifierEnd(path, start);
      if (end === start) throw new JsonPathError(path, `unexpected "." at ${i}`);
      segments.push({ kind: 'key', name: path.slice(start, end) });
      i = end;
      continue;
    }

    if (char === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) throw new JsonPathError(path, 'unclosed [');
      const inner = path.slice(i + 1, close).trim();
      segments.push(parseBracket(path, inner));
      i = close + 1;
      continue;
    }

    throw new JsonPathError(path, `unexpected character "${char}" at ${i}`);
  }

  cache.set(path, segments);
  return segments;
}

function parseBracket(path: string, inner: string): JsonPathSegment {
  if (inner === '*') return { kind: 'wildcard' };

  if (/^-?\d+$/.test(inner)) return { kind: 'index', index: Number(inner) };

  if (
    (inner.startsWith("'") && inner.endsWith("'")) ||
    (inner.startsWith('"') && inner.endsWith('"'))
  ) {
    return { kind: 'key', name: inner.slice(1, -1) };
  }

  const filter = /^\?\(\s*@\.([A-Za-z0-9_$-]+)\s*==\s*(['"])(.*)\2\s*\)$/.exec(inner);
  if (filter) {
    return { kind: 'filter', name: filter[1] as string, equals: filter[3] as string };
  }

  throw new JsonPathError(path, `unsupported bracket expression [${inner}]`);
}

function findIdentifierEnd(path: string, start: number): number {
  let i = start;
  while (i < path.length && /[A-Za-z0-9_$-]/.test(path[i] as string)) i += 1;
  return i;
}

/** Every match, in document order. */
export function queryJsonPath(root: unknown, path: string): unknown[] {
  const segments = parseJsonPath(path);
  let current: unknown[] = [root];

  for (const segment of segments) {
    const next: unknown[] = [];

    for (const node of current) {
      switch (segment.kind) {
        case 'key': {
          const value = readKey(node, segment.name);
          if (value !== undefined) next.push(value);
          break;
        }
        case 'index': {
          if (Array.isArray(node)) {
            const index = segment.index < 0 ? node.length + segment.index : segment.index;
            if (index >= 0 && index < node.length) next.push(node[index]);
          }
          break;
        }
        case 'wildcard': {
          if (Array.isArray(node)) next.push(...node);
          else if (isRecord(node)) next.push(...Object.values(node));
          break;
        }
        case 'descend': {
          collectDescendants(node, segment.name, next);
          break;
        }
        case 'filter': {
          const candidates = Array.isArray(node) ? node : isRecord(node) ? Object.values(node) : [];
          for (const candidate of candidates) {
            const value = readKey(candidate, segment.name);
            if (value !== undefined && String(value) === segment.equals) next.push(candidate);
          }
          break;
        }
      }
    }

    current = next;
    if (current.length === 0) return [];
  }

  return current;
}

/** The first match, or undefined. This is what declarations use almost everywhere. */
export function selectJsonPath(root: unknown, path: string): unknown {
  return queryJsonPath(root, path)[0];
}

function readKey(node: unknown, name: string): unknown {
  if (!isRecord(node)) return undefined;
  return Object.prototype.hasOwnProperty.call(node, name) ? node[name] : undefined;
}

function collectDescendants(node: unknown, name: string, into: unknown[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDescendants(item, name, into);
    return;
  }
  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    if (key === name) into.push(value);
    collectDescendants(value, name, into);
  }
}

function isRecord(node: unknown): node is Record<string, unknown> {
  return node !== null && typeof node === 'object' && !Array.isArray(node);
}
