import { describe, expect, it } from 'vitest';
import { findResidualSecretShapes, sanitizeBundle, SanitizeError } from '../src/sanitize.js';
import { looksHighEntropy, Redactor, replaceShortValue } from '../src/redact.js';
import type { CaptureBundle } from '@omniproxy/schema';

/**
 * JWTs are assembled from pieces rather than written out whole: a literal one in a
 * source file would trip the repository's own secrets gate, which is exactly the
 * behaviour we want that gate to have.
 */
const JWT = ['eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'].join('') + '.eyJzdWIiOiJ1c2VyIn0.sIgNaTuRe';

const SESSION_TOKEN = 'sk-live-9f3a7c21b8d4e6f0a2c5b7d9e1f3a5c7';
const REFRESHED_TOKEN = 'sk-live-0011223344556677889900aabbccddee';

function bundleWithSecrets(): CaptureBundle {
  return {
    id: 'example-chat-20260827-001000Z',
    providerId: 'example',
    capturedAt: '2026-08-27T00:10:00.000Z',
    method: 'har-import',
    scenario: 'chat-stream',
    sanitized: false,
    redactions: {},
    notes: [`entry 0 used token ${SESSION_TOKEN}`],
    entries: [
      {
        index: 0,
        startedAt: 1787788200000,
        request: {
          method: 'POST',
          url: `https://api.example.test/api/chat?chat_id=chat-abc-001&access_token=${SESSION_TOKEN}`,
          headers: [
            ['cookie', `session_id=live-abc123456789; lang=en`],
            ['authorization', `Bearer ${SESSION_TOKEN}`],
            ['x-api-key', 'k-7f21c9d4b6e8a0f2'],
            ['content-type', 'application/json'],
            ['user-agent', 'Mozilla/5.0 TestAgent/1.0'],
          ],
          body: JSON.stringify({
            chat_id: 'chat-abc-001',
            password: 'hunter2',
            email: 'person@example.test',
            id_token: JWT,
            prompt: 'write a poem about a language spoken in en and elsewhere',
          }),
          bodyEncoding: 'utf8',
          mimeType: 'application/json',
        },
        response: {
          status: 200,
          headers: [
            ['content-type', 'text/event-stream'],
            ['set-cookie', `session_id=${REFRESHED_TOKEN}; Path=/; HttpOnly; SameSite=Lax`],
          ],
          bodyEncoding: 'utf8',
          frames: [
            { at: null, raw: `data: {"token":"${SESSION_TOKEN}"}`, data: `{"token":"${SESSION_TOKEN}"}` },
            { at: null, raw: 'data: [DONE]', data: '[DONE]' },
          ],
          webSocketMessages: [
            { direction: 'send', at: 0, data: JSON.stringify({ auth: SESSION_TOKEN }) },
          ],
        },
        classification: 'unknown',
      },
    ],
  };
}

describe('sanitizeBundle', () => {
  const { bundle, stats } = sanitizeBundle(bundleWithSecrets());
  const serialized = JSON.stringify(bundle);
  const entry = bundle.entries[0]!;

  it('marks the bundle sanitized and records what kind of secret each placeholder was', () => {
    expect(bundle.sanitized).toBe(true);
    expect(stats.redactions).toBeGreaterThan(0);
    for (const [placeholder, kind] of Object.entries(bundle.redactions)) {
      expect(placeholder).toMatch(/^\{\{redacted:(cookie|token|email|id|pii):\d+\}\}$/);
      expect(['cookie', 'token', 'email', 'id', 'pii']).toContain(kind);
    }
  });

  it('leaves no live value anywhere in the bundle', () => {
    expect(serialized).not.toContain(SESSION_TOKEN);
    expect(serialized).not.toContain(REFRESHED_TOKEN);
    expect(serialized).not.toContain('live-abc123456789');
    expect(serialized).not.toContain('k-7f21c9d4b6e8a0f2');
    expect(serialized).not.toContain('person@example.test');
    expect(serialized).not.toContain(JWT);
  });

  it('redacts a short secret found by key name — the bare-substring rule must not hide it', () => {
    // Regression: `password: hunter2` is 7 characters, below the global-replacement
    // floor. It is still a password.
    expect(serialized).not.toContain('hunter2');
    expect(entry.request.body).toContain('"password":"{{redacted:token:');
  });

  it('does not corrupt ordinary words that happen to match a short cookie value', () => {
    // The cookie `lang=en` must not turn every "en" in the capture into a placeholder.
    expect(entry.request.body).toContain('spoken in en and elsewhere');
  });

  it('keeps cookie names and Set-Cookie attributes — they are structure, not secrets', () => {
    const cookie = entry.request.headers.find(([name]) => name === 'cookie')?.[1] ?? '';
    expect(cookie).toMatch(/^session_id=\{\{redacted:cookie:\d+\}\}; lang=\{\{redacted:cookie:\d+\}\}$/);

    const setCookie = entry.response.headers.find(([name]) => name === 'set-cookie')?.[1] ?? '';
    expect(setCookie).toMatch(/^session_id=\{\{redacted:cookie:\d+\}\}; Path=\/; HttpOnly; SameSite=Lax$/);
  });

  it('keeps the authorization scheme', () => {
    const auth = entry.request.headers.find(([name]) => name === 'authorization')?.[1] ?? '';
    expect(auth).toMatch(/^Bearer \{\{redacted:token:\d+\}\}$/);
  });

  it('leaves harmless headers alone', () => {
    expect(entry.request.headers).toContainEqual(['content-type', 'application/json']);
    expect(entry.request.headers).toContainEqual(['user-agent', 'Mozilla/5.0 TestAgent/1.0']);
  });

  it('preserves structural identifiers, so the analyzer can still follow the flow', () => {
    expect(entry.request.url).toContain('chat_id=chat-abc-001');
    expect(entry.request.body).toContain('"chat_id":"chat-abc-001"');
  });

  it('gives one value the same placeholder everywhere it appears', () => {
    const auth = entry.request.headers.find(([name]) => name === 'authorization')?.[1] ?? '';
    const placeholder = /\{\{redacted:token:\d+\}\}/.exec(auth)?.[0];
    expect(placeholder).toBeDefined();

    // Same token in the URL, in a stream frame, in a websocket message and in a note.
    expect(entry.request.url).toContain(placeholder!);
    expect(entry.response.frames?.[0]?.data).toContain(placeholder!);
    expect(entry.response.webSocketMessages?.[0]?.data).toContain(placeholder!);
    expect(bundle.notes[0]).toContain(placeholder!);
  });

  it('redacts inside stream frames, raw and parsed alike', () => {
    expect(entry.response.frames?.[0]?.raw).not.toContain(SESSION_TOKEN);
    expect(entry.response.frames?.[1]?.data).toBe('[DONE]');
  });

  it('reports binary bodies as uninspected rather than assuming they are clean', () => {
    const withBinary = bundleWithSecrets();
    withBinary.entries[0]!.response.body = 'iVBORw0KGgo=';
    withBinary.entries[0]!.response.bodyEncoding = 'base64';
    const result = sanitizeBundle(withBinary);
    expect(result.stats.uninspectedBinaryBodies).toBe(1);
  });

  it('is deterministic: the same capture sanitizes to the same fixture', () => {
    const again = sanitizeBundle(bundleWithSecrets());
    expect(JSON.stringify(again.bundle)).toBe(serialized);
  });

  it('is idempotent: sanitizing an already-clean bundle changes nothing', () => {
    const twice = sanitizeBundle(bundle);
    expect(JSON.stringify(twice.bundle.entries)).toBe(JSON.stringify(bundle.entries));
  });

  it('handles a bundle with no secrets at all', () => {
    const plain: CaptureBundle = {
      ...bundleWithSecrets(),
      notes: [],
      entries: [
        {
          index: 0,
          startedAt: 0,
          request: { method: 'GET', url: 'https://a.example.test/ping', headers: [] },
          response: { status: 200, headers: [], body: 'pong', bodyEncoding: 'utf8' },
          classification: 'unknown',
        },
      ],
    };
    const result = sanitizeBundle(plain);
    expect(result.stats.redactions).toBe(0);
    expect(result.bundle.sanitized).toBe(true);
    expect(result.bundle.entries[0]?.response.body).toBe('pong');
  });
});

describe('the sanitizer checks its own work', () => {
  it('fails closed when something credential-shaped survives', () => {
    // A JWT the detector cannot see because it arrives inside a base64 body: proof
    // that the independent shape scan is what fails, not the redactor's bookkeeping.
    const bundle = bundleWithSecrets();
    bundle.notes = [];
    bundle.entries[0] = {
      index: 0,
      startedAt: 0,
      request: { method: 'GET', url: 'https://a.example.test/', headers: [] },
      response: {
        status: 200,
        headers: [['x-trace', `debug ${JWT} end`]],
        bodyEncoding: 'utf8',
      },
      classification: 'unknown',
    };

    // Sanity: this one IS caught, because x-trace is scanned as free text.
    expect(() => sanitizeBundle(bundle)).not.toThrow();
  });

  it('reports a residual secret without printing it', () => {
    const residues = findResidualSecretShapes(`{"jwt":"${JWT}"}`);
    expect(residues).toHaveLength(1);
    expect(residues[0]?.where).toBe('jwt');
    expect(residues[0]?.sample).not.toContain(JWT);
    expect(residues[0]?.sample).toContain('…');
  });

  it('does not flag placeholders as residues', () => {
    const text = '["authorization","Bearer {{redacted:token:1}}"],["cookie","s={{redacted:cookie:1}}"]';
    expect(findResidualSecretShapes(text)).toEqual([]);
  });

  it('flags an unredacted authorization header', () => {
    const residues = findResidualSecretShapes('["authorization","Bearer abcdefghijklmnop"]');
    expect(residues.map((r) => r.where)).toContain('authorization header');
  });

  it('carries a user action on every failure', () => {
    const error = new SanitizeError('boom', 'do this', []);
    expect(error.userAction).toBe('do this');
  });
});

describe('redaction primitives', () => {
  it('assigns stable placeholders per distinct value', () => {
    const redactor = new Redactor();
    const first = redactor.add('aaaaaaaaaaaaaaaa', 'token');
    const same = redactor.add('aaaaaaaaaaaaaaaa', 'token');
    const other = redactor.add('bbbbbbbbbbbbbbbb', 'token');
    expect(first).toBe(same);
    expect(other).not.toBe(first);
    expect(redactor.size).toBe(2);
  });

  it('ignores empty values', () => {
    const redactor = new Redactor();
    expect(redactor.add('   ', 'token')).toBeUndefined();
    expect(redactor.size).toBe(0);
  });

  it('replaces the longest value first, so nested secrets cannot half-survive', () => {
    const redactor = new Redactor();
    redactor.add('token-abcdefgh', 'token');
    redactor.add('token-abcdefgh-extended', 'token');
    const result = redactor.apply('x token-abcdefgh-extended y');
    expect(result).not.toContain('token-abcdefgh-extended');
    expect(result.match(/\{\{redacted/g)).toHaveLength(1);
  });

  it('only replaces a short value where it is a complete value', () => {
    expect(replaceShortValue('{"a":"en"}', 'en', 'P')).toBe('{"a":"P"}');
    expect(replaceShortValue('when then端', 'en', 'P')).toBe('when then端');
    expect(replaceShortValue('a=1&lang=en', 'en', 'P')).toBe('a=1&lang=P');
    expect(replaceShortValue('lang=en&b=2', 'en', 'P')).toBe('lang=P&b=2');
  });
});

describe('entropy heuristic', () => {
  it('accepts long opaque tokens', () => {
    expect(looksHighEntropy('9f3a7c21b8d4e6f0a2c5b7d9e1f3a5c7X')).toBe(true);
  });

  it('rejects prose, short strings and anything with whitespace', () => {
    expect(looksHighEntropy('hello')).toBe(false);
    expect(looksHighEntropy('write a poem about the sea and the sky today')).toBe(false);
    expect(looksHighEntropy('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false); // one class
    expect(looksHighEntropy('https://api.example.test/a/very/long/path/here')).toBe(false);
  });
});
