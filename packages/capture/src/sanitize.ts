import type {
  CaptureBundle,
  CaptureEntry,
  CaptureFrame,
  HeaderPair,
  RedactionKind,
} from '@omniproxy/schema';
import { captureBundleSchema } from '@omniproxy/schema';
import {
  authorizationCredential,
  collectJsonSecrets,
  findEmails,
  findJwts,
  isSecretHeader,
  isSecretKey,
  looksHighEntropy,
  parseCookieHeader,
  parseSetCookie,
  Redactor,
} from './redact.js';

/**
 * Sanitization — the one step in the pipeline that cannot be switched off.
 *
 * A capture holds live cookies and tokens. Fixtures live in git, get attached to
 * issues and get shared between people, so a fixture carrying a real session is an
 * account handed to a stranger — and unlike most mistakes, that one cannot be taken
 * back. The charter allows the user to override nearly everything in OmniProxy;
 * this is one of the two places it deliberately does not.
 *
 * The pass runs in two phases (see redact.ts) and then checks its own work: after
 * replacement the serialised bundle is scanned again, both for the values we know
 * about and, independently, for anything still *shaped* like a credential. Failing
 * closed there is the difference between a sanitizer and a hope.
 */

export interface SanitizeStats {
  redactions: number;
  byKind: Record<string, number>;
  /** Binary bodies were not inspected; they are reported rather than assumed clean. */
  uninspectedBinaryBodies: number;
}

export interface SanitizeResult {
  bundle: CaptureBundle;
  stats: SanitizeStats;
}

export class SanitizeError extends Error {
  override readonly name = 'SanitizeError';
  constructor(
    message: string,
    readonly userAction: string,
    readonly residues: ResidualSecret[] = [],
  ) {
    super(message);
  }
}

export function sanitizeBundle(bundle: CaptureBundle): SanitizeResult {
  const redactor = new Redactor();
  let uninspectedBinaryBodies = 0;

  const collect = (value: string, kind: RedactionKind): void => {
    redactor.add(value, kind);
  };

  // ── Phase 1: detect, across the whole bundle before anything is replaced ──
  for (const entry of bundle.entries) {
    for (const [name, value] of entry.request.headers) collectFromHeader(name, value, collect);
    for (const [name, value] of entry.response.headers) collectFromHeader(name, value, collect);

    collectFromUrl(entry.request.url, collect);

    if (entry.request.bodyEncoding === 'base64') uninspectedBinaryBodies += 1;
    else if (entry.request.body !== undefined) collectFromText(entry.request.body, collect);

    if (entry.response.bodyEncoding === 'base64') uninspectedBinaryBodies += 1;
    else if (entry.response.body !== undefined) collectFromText(entry.response.body, collect);

    for (const frame of entry.response.frames ?? []) {
      collectFromText(frame.raw, collect);
    }
    for (const message of entry.response.webSocketMessages ?? []) {
      collectFromText(message.data, collect);
    }
  }
  for (const note of bundle.notes) collectFromText(note, collect);

  // ── Phase 2: replace ──
  const entries: CaptureEntry[] = bundle.entries.map((entry) => {
    const request = { ...entry.request };
    request.headers = entry.request.headers.map((pair) => sanitizeHeader(pair, redactor));
    request.url = redactor.apply(sanitizeUrl(entry.request.url, redactor));
    if (request.body !== undefined && request.bodyEncoding !== 'base64') {
      request.body = redactor.apply(request.body);
    }

    const response = { ...entry.response };
    response.headers = entry.response.headers.map((pair) => sanitizeHeader(pair, redactor));
    if (response.body !== undefined && response.bodyEncoding !== 'base64') {
      response.body = redactor.apply(response.body);
    }
    if (entry.response.frames) {
      response.frames = entry.response.frames.map((frame) => sanitizeFrame(frame, redactor));
    }
    if (entry.response.webSocketMessages) {
      response.webSocketMessages = entry.response.webSocketMessages.map((message) => ({
        ...message,
        data: redactor.apply(message.data),
      }));
    }

    return { ...entry, request, response };
  });

  const sanitized: CaptureBundle = {
    ...bundle,
    sanitized: true,
    entries,
    redactions: redactor.toRecord(),
    notes: bundle.notes.map((note) => redactor.apply(note)),
  };

  // ── Phase 3: check our own work, and fail closed if it did not hold ──
  const serialized = JSON.stringify(sanitized);

  const survivors = redactor.findSurviving(serialized);
  if (survivors.length > 0) {
    throw new SanitizeError(
      `Sanitization did not hold: ${survivors.length} known secret value(s) still present.`,
      'This is a bug in OmniProxy, not in your capture. Please report it — and do not commit this bundle.',
      survivors.map((value) => ({ kind: 'token' as const, where: 'known value', sample: mask(value) })),
    );
  }

  const residues = findResidualSecretShapes(serialized);
  if (residues.length > 0) {
    throw new SanitizeError(
      `Sanitization left ${residues.length} value(s) still shaped like a credential.`,
      'Do not commit this bundle. Please report the shape that was missed so the detector can be extended.',
      residues,
    );
  }

  return {
    bundle: captureBundleSchema.parse(sanitized),
    stats: {
      redactions: redactor.size,
      byKind: redactor.countsByKind(),
      uninspectedBinaryBodies,
    },
  };
}

/* ────────────────────────────────── detection ────────────────────────────────── */

function collectFromHeader(
  name: string,
  value: string,
  collect: (value: string, kind: RedactionKind) => void,
): void {
  const lower = name.toLowerCase();

  if (lower === 'cookie') {
    for (const pair of parseCookieHeader(value)) collect(pair.value, 'cookie');
    return;
  }

  if (lower === 'set-cookie') {
    const parsed = parseSetCookie(value);
    if (parsed) collect(parsed.value, 'cookie');
    return;
  }

  if (lower === 'authorization' || lower === 'proxy-authorization') {
    collect(authorizationCredential(value), 'token');
    return;
  }

  if (isSecretHeader(lower)) {
    collect(value, 'token');
    return;
  }

  collectFromText(value, collect);
}

function collectFromUrl(
  url: string,
  collect: (value: string, kind: RedactionKind) => void,
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    collectFromText(url, collect);
    return;
  }

  for (const [name, value] of parsed.searchParams) {
    if (isSecretKey(name)) collect(value, 'token');
    else collectFromText(value, collect);
  }
}

/** Body / frame / free text: JSON when it parses, pattern matching otherwise. */
function collectFromText(
  text: string,
  collect: (value: string, kind: RedactionKind) => void,
): void {
  for (const jwt of findJwts(text)) collect(jwt, 'token');
  for (const email of findEmails(text)) collect(email, 'email');

  const json = tryParseJson(text);
  if (json !== undefined) {
    collectJsonSecrets(json, undefined, collect);
    return;
  }

  if (looksFormEncoded(text)) {
    for (const part of text.split('&')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = decodeURIComponentSafe(part.slice(0, eq));
      const value = decodeURIComponentSafe(part.slice(eq + 1));
      if (isSecretKey(name)) collect(value, 'token');
      else if (looksHighEntropy(value)) collect(value, 'token');
    }
    return;
  }

  if (looksHighEntropy(text)) collect(text, 'token');
}

/* ───────────────────────────────── replacement ───────────────────────────────── */

/**
 * Headers are rewritten structurally rather than by search: cookie names and
 * Set-Cookie attributes are exactly what a provider declaration has to describe, and
 * a short cookie value must not be replaced by global search (see redact.ts).
 */
function sanitizeHeader([name, value]: HeaderPair, redactor: Redactor): HeaderPair {
  const lower = name.toLowerCase();

  if (lower === 'cookie') {
    const rebuilt = parseCookieHeader(value)
      .map((pair) => `${pair.name}=${redactor.placeholderFor(pair.value) ?? pair.value}`)
      .join('; ');
    return [name, rebuilt === '' ? redactor.apply(value) : rebuilt];
  }

  if (lower === 'set-cookie') {
    const parsed = parseSetCookie(value);
    if (!parsed) return [name, redactor.apply(value)];
    const placeholder = redactor.placeholderFor(parsed.value) ?? parsed.value;
    const attributes = value.slice(value.indexOf(';') === -1 ? value.length : value.indexOf(';'));
    return [name, `${parsed.name}=${placeholder}${attributes}`];
  }

  if (lower === 'authorization' || lower === 'proxy-authorization') {
    const credential = authorizationCredential(value);
    const placeholder = redactor.placeholderFor(credential);
    if (!placeholder) return [name, redactor.apply(value)];
    // Keep the scheme: `Bearer` versus `Basic` is structure, not secret.
    const scheme = value.slice(0, value.length - credential.length);
    return [name, `${scheme}${placeholder}`];
  }

  if (isSecretHeader(lower)) {
    return [name, redactor.placeholderFor(value) ?? redactor.apply(value)];
  }

  return [name, redactor.apply(value)];
}

/** Query parameter values are replaced in place so the URL structure survives. */
function sanitizeUrl(url: string, redactor: Redactor): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  let changed = false;
  for (const [name, value] of [...parsed.searchParams]) {
    const placeholder = redactor.placeholderFor(value);
    if (placeholder) {
      parsed.searchParams.set(name, placeholder);
      changed = true;
    }
  }
  if (!changed) return url;

  // URLSearchParams percent-encodes the braces; put them back so the placeholder
  // stays readable and greppable in the fixture.
  return parsed.toString().replace(/%7B%7Bredacted%3A([a-z]+)%3A(\d+)%7D%7D/g, '{{redacted:$1:$2}}');
}

function sanitizeFrame(frame: CaptureFrame, redactor: Redactor): CaptureFrame {
  const next: CaptureFrame = { ...frame, raw: redactor.apply(frame.raw) };
  if (frame.data !== undefined) next.data = redactor.apply(frame.data);
  if (frame.id !== undefined) next.id = redactor.apply(frame.id);
  return next;
}

/* ──────────────────────────────── verification ──────────────────────────────── */

export interface ResidualSecret {
  kind: RedactionKind;
  where: string;
  /** A masked excerpt. The full value is never put in an error message or a log. */
  sample: string;
}

const RESIDUAL_PATTERNS: { kind: RedactionKind; where: string; pattern: RegExp }[] = [
  { kind: 'token', where: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./g },
  {
    kind: 'email',
    where: 'email address',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: 'token',
    where: 'authorization header',
    pattern: /"(?:authorization|proxy-authorization)"\s*,\s*"(?:Bearer|Basic|Token)\s+(?!\{\{redacted)[^"]{8,}"/gi,
  },
  {
    kind: 'cookie',
    where: 'cookie header',
    pattern: /"cookie"\s*,\s*"[^"]*=(?!\{\{redacted)[A-Za-z0-9+/=._-]{16,}/gi,
  },
];

/**
 * An independent check that does not trust the redactor's bookkeeping: it looks for
 * anything still shaped like a credential in the finished text. This is what the
 * fixture writer calls, and what makes the gate meaningful for bundles produced by
 * some future recorder that has not been written yet.
 */
export function findResidualSecretShapes(text: string): ResidualSecret[] {
  const found: ResidualSecret[] = [];
  for (const { kind, where, pattern } of RESIDUAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      found.push({ kind, where, sample: mask(match[0]) });
    }
  }
  return found;
}

/** Never print a secret, not even when complaining about it. */
function mask(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

/* ────────────────────────────────── helpers ────────────────────────────────── */

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '' || !'{['.includes(trimmed[0] ?? '')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function looksFormEncoded(text: string): boolean {
  return text.includes('=') && !text.includes('\n') && text.length < 8192;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}
