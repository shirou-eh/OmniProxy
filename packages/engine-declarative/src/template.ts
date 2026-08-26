/**
 * `{{path | modifier}}` substitution.
 *
 * Reading only. No expressions, no function calls, no arithmetic — a declaration is
 * data (ADR-0002), and the moment a config language can compute, it is a program
 * nobody reviewed. Anything that must be computed goes through a named transform from
 * the registry, which is code someone wrote, tested and can read.
 *
 * A template that resolves to nothing is not silently empty: it is reported, because
 * an upstream call built from a missing session id fails in a way that takes an hour
 * to understand, while "unresolved {{state.sessionId}}" takes a second.
 */

export interface TemplateContext {
  req?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  state?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  job?: Record<string, unknown>;
  channel?: Record<string, unknown>;
  extracted?: Record<string, unknown>;
  now?: { unixMs: number; unixS: number; iso: string };
}

export class TemplateError extends Error {
  override readonly name = 'TemplateError';
  constructor(
    message: string,
    readonly template: string,
    readonly userAction: string,
  ) {
    super(message);
  }
}

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

/** Roots a template may read. Anything else is a mistake worth failing on. */
const ROOTS = new Set([
  'req',
  'auth',
  'state',
  'vars',
  'env',
  'job',
  'channel',
  'extracted',
  'now',
]);

export interface RenderResult {
  value: string;
  /** Placeholders that resolved to nothing. */
  unresolved: string[];
}

/** Renders a template to a string. `{{x}}` alone with a non-string value stringifies. */
export function renderTemplate(template: string, context: TemplateContext): RenderResult {
  const unresolved: string[] = [];

  const value = template.replace(PLACEHOLDER, (_match, expression: string) => {
    const resolved = resolveExpression(expression, context, template);
    if (resolved === undefined || resolved === null) {
      unresolved.push(expression.trim());
      return '';
    }
    return typeof resolved === 'string' ? resolved : stringify(resolved);
  });

  return { value, unresolved };
}

/**
 * Renders a value that is exactly one placeholder to the underlying value, keeping
 * its type. `"{{req.messages}}"` has to stay an array, or a declaration could never
 * pass structured data through to a provider that wants it (`native-messages`).
 */
export function renderValue(input: unknown, context: TemplateContext): {
  value: unknown;
  unresolved: string[];
} {
  const unresolved: string[] = [];

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const whole = /^\{\{([^{}]+)\}\}$/.exec(node);
      if (whole) {
        const resolved = resolveExpression(whole[1] as string, context, node);
        if (resolved === undefined) {
          unresolved.push((whole[1] as string).trim());
          return undefined;
        }
        return resolved;
      }
      const rendered = renderTemplate(node, context);
      unresolved.push(...rendered.unresolved);
      return rendered.value;
    }

    if (Array.isArray(node)) return node.map(walk);

    if (node !== null && typeof node === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const rendered = walk(child);
        // A field whose only content was an unresolved placeholder is dropped rather
        // than sent as null: providers reject nulls far more often than missing keys.
        if (rendered !== undefined) result[key] = rendered;
      }
      return result;
    }

    return node;
  };

  return { value: walk(input), unresolved };
}

function resolveExpression(
  expression: string,
  context: TemplateContext,
  template: string,
): unknown {
  const [pathPart, ...modifierParts] = expression.split('|').map((part) => part.trim());
  if (!pathPart) throw new TemplateError('empty placeholder', template, 'Remove the empty {{}}.');

  let value = readPath(pathPart, context, template);

  for (const modifier of modifierParts) {
    value = applyModifier(modifier, value, template);
  }

  return value;
}

function readPath(path: string, context: TemplateContext, template: string): unknown {
  const segments = path.split('.').filter((segment) => segment !== '');
  const root = segments[0];
  if (root === undefined) return undefined;

  if (!ROOTS.has(root)) {
    throw new TemplateError(
      `unknown template root "${root}"`,
      template,
      `Templates may read: ${[...ROOTS].join(', ')}.`,
    );
  }

  let current: unknown = (context as Record<string, unknown>)[root];

  for (const segment of segments.slice(1)) {
    if (current === null || current === undefined) return undefined;

    const arrayMatch = /^([A-Za-z0-9_$-]*)\[(\d+)\]$/.exec(segment);
    if (arrayMatch) {
      const [, name, indexText] = arrayMatch;
      if (name) current = readMember(current, name);
      if (!Array.isArray(current)) return undefined;
      current = current[Number(indexText)];
      continue;
    }

    current = readMember(current, segment);
  }

  return current;
}

function readMember(node: unknown, name: string): unknown {
  if (node === null || typeof node !== 'object') return undefined;
  return (node as Record<string, unknown>)[name];
}

/** A closed list. Extending it is a code change with a test, never a config change. */
function applyModifier(modifier: string, value: unknown, template: string): unknown {
  if (modifier.startsWith('default:')) {
    const fallback = modifier.slice('default:'.length);
    return value === undefined || value === null || value === '' ? fallback : value;
  }

  if (modifier.startsWith('slice:')) {
    const limit = Number(modifier.slice('slice:'.length));
    if (!Number.isFinite(limit)) {
      throw new TemplateError(`slice needs a number: ${modifier}`, template, 'Use slice:1000.');
    }
    return typeof value === 'string' ? value.slice(0, limit) : value;
  }

  switch (modifier) {
    case 'json':
      return JSON.stringify(value ?? null);
    case 'base64':
      return Buffer.from(stringify(value ?? ''), 'utf8').toString('base64');
    case 'base64url':
      return Buffer.from(stringify(value ?? ''), 'utf8').toString('base64url');
    case 'urlencode':
      return encodeURIComponent(stringify(value ?? ''));
    case 'int': {
      const parsed = Number.parseInt(stringify(value ?? ''), 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    case 'number': {
      const parsed = Number(stringify(value ?? ''));
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    case 'bool':
      return value === true || value === 'true' || value === 1 || value === '1';
    case 'upper':
      return stringify(value ?? '').toUpperCase();
    case 'lower':
      return stringify(value ?? '').toLowerCase();
    case 'trim':
      return stringify(value ?? '').trim();
    default:
      throw new TemplateError(
        `unknown template modifier "${modifier}"`,
        template,
        'Supported: json, base64, base64url, urlencode, int, number, bool, upper, lower, trim, default:<value>, slice:<n>.',
      );
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
