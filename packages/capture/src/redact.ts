import type { RedactionKind } from '@omniproxy/schema';

/**
 * Secret detection and stable replacement.
 *
 * Two phases, deliberately separated:
 *
 *  1. **Detect.** Walk headers, URLs and bodies collecting the exact secret strings,
 *     each with the kind of secret it is.
 *  2. **Replace.** Substitute those literal strings everywhere they appear.
 *
 * Doing it this way has three consequences that matter:
 *
 *  - Bodies keep their original formatting byte for byte. Re-serialising parsed JSON
 *    would quietly change whitespace and key order, and the whole point of a fixture
 *    is that it is what the provider actually sent.
 *  - The same value always becomes the same placeholder, everywhere. That preserves
 *    the dependency graph the analyzer needs: "the id from response A appears in
 *    request B" still holds after redaction, because both became placeholder N.
 *  - Nothing is redacted twice or partially.
 *
 * The detection policy is asymmetric on purpose: aggressive by name and by shape
 * (a header called `authorization`, anything shaped like a JWT), conservative by
 * entropy (32+ characters, no whitespace, token charset only). Over-redaction
 * destroys the structure that makes a capture useful; under-redaction leaks an
 * account. The entropy rule is where those two risks meet, so it is the one kept tight.
 */

/** Headers whose entire value is a credential. */
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-session-token',
  'x-access-token',
  'x-ds-pow-response',
]);

/** JSON keys and query parameters whose value is a credential regardless of shape. */
const SECRET_KEY_PATTERN =
  /^(.*_)?(token|secret|password|passwd|pwd|api_?key|auth|authorization|credential|signature|sig|cookie|session_?key|refresh_?token|access_?token|id_?token|bearer)(_.*)?$/i;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const TOKEN_CHARSET = /^[A-Za-z0-9+/=._~-]+$/;
const MIN_ENTROPY_LENGTH = 32;

export interface Redaction {
  placeholder: string;
  kind: RedactionKind;
  /** Whether this value may be replaced by literal search across the whole bundle. */
  global: boolean;
}

/**
 * Below this length a value is redacted only where it was found (a cookie value, a
 * header) and never by global search. `lang=en` is a cookie value too, and replacing
 * every "en" in the capture would destroy it.
 */
export const MIN_GLOBAL_REPLACE_LENGTH = 8;

const PLACEHOLDER_PATTERN = /^\{\{redacted:[a-z]+:\d+\}\}$/;

/** Whether a value is already a placeholder produced by an earlier sanitization. */
export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value.trim());
}

/**
 * Collects secrets and hands out stable placeholders. One instance per bundle, so
 * numbering is deterministic in first-appearance order — the same capture sanitizes
 * to the same fixture every time, which is what makes fixtures diffable.
 */
export class Redactor {
  readonly #byValue = new Map<string, Redaction>();
  readonly #counters = new Map<RedactionKind, number>();

  /** Registers a value as secret. Returns its placeholder; idempotent per value. */
  add(value: string, kind: RedactionKind): string | undefined {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    // Never redact a redaction. Sanitizing an already-sanitized bundle has to be a
    // no-op: without this the second pass treats every placeholder as a fresh secret,
    // renumbers it and corrupts the fixture.
    if (isPlaceholder(trimmed)) return trimmed;

    const existing = this.#byValue.get(trimmed);
    if (existing) return existing.placeholder;

    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    const placeholder = `{{redacted:${kind}:${next}}}`;
    this.#byValue.set(trimmed, {
      placeholder,
      kind,
      global: trimmed.length >= MIN_GLOBAL_REPLACE_LENGTH,
    });
    return placeholder;
  }

  /** Placeholder for an already-registered value, for in-place structural rewrites. */
  placeholderFor(value: string): string | undefined {
    return this.#byValue.get(value.trim())?.placeholder;
  }

  get size(): number {
    return this.#byValue.size;
  }

  /** placeholder -> kind, for the bundle's audit record. Values are never stored. */
  toRecord(): Record<string, RedactionKind> {
    const record: Record<string, RedactionKind> = {};
    for (const { placeholder, kind } of this.#byValue.values()) {
      record[placeholder] = kind;
    }
    return record;
  }

  countsByKind(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const { kind } of this.#byValue.values()) {
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
    return counts;
  }

  /**
   * Replaces every known secret in a string. Longest values first, so a secret that
   * contains another secret cannot be half-replaced.
   */
  apply(text: string): string {
    if (this.#byValue.size === 0) return text;
    let result = text;
    for (const [value, redaction] of this.#sortedByLengthDesc()) {
      if (redaction.global) {
        if (result.includes(value)) result = result.split(value).join(redaction.placeholder);
        continue;
      }
      // A short value is replaced only where it is unambiguously a whole value: a
      // quoted JSON string, or a complete form field. `password=hunter2` must not
      // survive, and `lang=en` must not turn every "en" in the capture into a
      // placeholder. Both are handled by refusing to match a bare substring.
      result = replaceShortValue(result, value, redaction.placeholder);
    }
    return result;
  }

  /** Values that survived replacement — used by the verification pass. */
  findSurviving(text: string): string[] {
    const survivors: string[] = [];
    for (const [value, redaction] of this.#byValue) {
      if (redaction.global) {
        if (text.includes(value)) survivors.push(value);
        continue;
      }
      if (replaceShortValue(text, value, redaction.placeholder) !== text) {
        survivors.push(value);
      }
    }
    return survivors;
  }

  #sortedByLengthDesc(): [string, Redaction][] {
    return [...this.#byValue.entries()].sort((a, b) => b[0].length - a[0].length);
  }
}

/**
 * Replaces a short secret only where it is delimited as a complete value: a quoted
 * JSON string (including one escaped inside another string), or a whole form field.
 * Never a bare substring — that is the difference between redacting `lang=en` and
 * corrupting every word containing "en".
 */
export function replaceShortValue(text: string, value: string, placeholder: string): string {
  let result = text
    .split(`"${value}"`)
    .join(`"${placeholder}"`)
    .split(`\\"${value}\\"`)
    .join(`\\"${placeholder}\\"`);

  const formField = new RegExp(`(?<==)${escapeRegExp(value)}(?=&|$)`, 'g');
  result = result.replace(formField, placeholder);

  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ────────────────────────────── detection helpers ────────────────────────────── */

export function isSecretHeader(name: string): boolean {
  return SECRET_HEADERS.has(name.toLowerCase());
}

export function isSecretKey(name: string): boolean {
  return SECRET_KEY_PATTERN.test(name);
}

/**
 * A credential-shaped opaque string. Conservative by design — see the note at the top
 * of this file about why this specific rule is the tight one.
 */
export function looksHighEntropy(value: string): boolean {
  if (value.length < MIN_ENTROPY_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (!TOKEN_CHARSET.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((pattern) => pattern.test(value)).length;
  return classes >= 2;
}

/** Splits a `Cookie:` header into pairs, preserving names (they are structure). */
export function parseCookieHeader(value: string): { name: string; value: string }[] {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return { name: part, value: '' };
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    })
    .filter((pair) => pair.value !== '');
}

/**
 * `Set-Cookie` is `name=value; Path=/; HttpOnly`. Only the value is secret — the name
 * and the attributes are exactly what a provider declaration needs to describe.
 */
export function parseSetCookie(header: string): { name: string; value: string } | undefined {
  const firstPart = header.split(';')[0];
  if (!firstPart) return undefined;
  const eq = firstPart.indexOf('=');
  if (eq === -1) return undefined;
  const value = firstPart.slice(eq + 1).trim();
  if (value === '') return undefined;
  return { name: firstPart.slice(0, eq).trim(), value };
}

/** `Bearer abc123` -> `abc123`. Returns the whole value when there is no scheme. */
export function authorizationCredential(value: string): string {
  const space = value.indexOf(' ');
  if (space === -1) return value;
  const scheme = value.slice(0, space).toLowerCase();
  const known = ['bearer', 'basic', 'digest', 'token', 'jwt'];
  return known.includes(scheme) ? value.slice(space + 1).trim() : value;
}

export function findJwts(text: string): string[] {
  return text.match(JWT_PATTERN) ?? [];
}

export function findEmails(text: string): string[] {
  return text.match(EMAIL_PATTERN) ?? [];
}

/**
 * Walks parsed JSON collecting secret string values: by key name, by JWT shape, or by
 * entropy. Arrays inherit the key of their parent, so `{"tokens": ["a","b"]}` is
 * treated the way a reader would expect.
 */
export function collectJsonSecrets(
  node: unknown,
  key: string | undefined,
  into: (value: string, kind: RedactionKind) => void,
): void {
  if (typeof node === 'string') {
    if (key !== undefined && isSecretKey(key)) {
      into(node, 'token');
      return;
    }
    for (const jwt of findJwts(node)) into(jwt, 'token');
    for (const email of findEmails(node)) into(email, 'email');
    if (looksHighEntropy(node)) into(node, 'token');
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) collectJsonSecrets(item, key, into);
    return;
  }

  if (node !== null && typeof node === 'object') {
    for (const [childKey, child] of Object.entries(node)) {
      collectJsonSecrets(child, childKey, into);
    }
  }
}
