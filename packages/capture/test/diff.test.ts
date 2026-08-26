import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyVolatileFields, diffCaptures } from '../src/diff.js';
import { importHar } from '../src/har.js';
import type { CaptureBundle } from '@omniproxy/schema';

const har: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/devtools-sse.har', import.meta.url)), 'utf8'),
);

function firstRun(): CaptureBundle {
  return importHar(har, { providerId: 'example', scenario: 'chat-stream' });
}

/** A second run of the same scenario: same calls, different ids and text. */
function secondRun(): CaptureBundle {
  const bundle: CaptureBundle = JSON.parse(JSON.stringify(firstRun()));
  const rewrite = (text: string): string =>
    text.replace(/chat-abc-001/g, 'chat-def-002').replace(/"hi"/g, '"hello there"');

  bundle.entries = bundle.entries.map((entry) => ({
    ...entry,
    request: {
      ...entry.request,
      url: rewrite(entry.request.url),
      ...(entry.request.body === undefined ? {} : { body: rewrite(entry.request.body) }),
    },
    response: {
      ...entry.response,
      ...(entry.response.body === undefined ? {} : { body: rewrite(entry.response.body) }),
    },
  }));
  return bundle;
}

describe('diffCaptures', () => {
  const diff = diffCaptures(firstRun(), secondRun());
  const forEntry = (index: number) => diff.entries.find((e) => e.index === index);

  it('matches the two runs call for call', () => {
    expect(diff.entries).toHaveLength(6);
    expect(diff.entries.every((e) => e.matchedWith !== undefined)).toBe(true);
    expect(diff.unmatchedInA).toEqual([]);
    expect(diff.unmatchedInB).toEqual([]);
  });

  it('finds the query parameter that changes between runs', () => {
    expect(forEntry(1)?.volatileFields).toContain('request.query.chat_id');
  });

  it('finds the body field that changes, by path', () => {
    expect(forEntry(1)?.volatileFields).toContain('request.body.messages[0].content');
  });

  it('leaves constant calls alone — a constant is not a variable', () => {
    // Entry 0 posts {"title":"New chat"} both times.
    expect(forEntry(0)?.volatileFields).toEqual([]);
  });

  it('writes the volatility back onto the bundle for the draft generator', () => {
    const applied = applyVolatileFields(firstRun(), diff);
    expect(applied.entries[1]?.volatileFields).toContain('request.query.chat_id');
    expect(applied.entries[0]?.volatileFields).toBeUndefined();
  });
});

describe('diffCaptures on inputs that do not belong together', () => {
  it('says so when the providers differ', () => {
    const other = { ...firstRun(), providerId: 'somewhere-else' };
    expect(diffCaptures(firstRun(), other).warnings.join(' ')).toContain('different providers');
  });

  it('says so when the scenarios differ', () => {
    const other = { ...firstRun(), scenario: 'image-generate' };
    expect(diffCaptures(firstRun(), other).warnings.join(' ')).toContain('Different scenarios');
  });

  it('warns when the two captures are identical, instead of implying everything is constant', () => {
    expect(diffCaptures(firstRun(), firstRun()).warnings.join(' ')).toContain('Nothing differs');
  });

  it('reports calls present in only one run', () => {
    const shorter = firstRun();
    shorter.entries = shorter.entries.slice(0, 3);
    const diff = diffCaptures(firstRun(), shorter);
    expect(diff.unmatchedInA).toEqual([3, 4, 5]);
    expect(diff.entries[3]?.notes[0]).toContain('no matching call');
  });
});

describe('field-level comparison', () => {
  const base = (overrides: Partial<CaptureBundle['entries'][number]['request']>): CaptureBundle => ({
    id: 'x',
    providerId: 'p',
    capturedAt: '2026-08-27T00:00:00.000Z',
    method: 'har-import',
    scenario: 's',
    sanitized: false,
    redactions: {},
    notes: [],
    entries: [
      {
        index: 0,
        startedAt: 0,
        request: { method: 'POST', url: 'https://a.example.test/x', headers: [], ...overrides },
        response: { status: 200, headers: [] },
        classification: 'unknown',
      },
    ],
  });

  it('finds a changed header', () => {
    const diff = diffCaptures(
      base({ headers: [['x-request-id', 'aaaa-1111']] }),
      base({ headers: [['x-request-id', 'bbbb-2222']] }),
    );
    expect(diff.entries[0]?.volatileFields).toEqual(['request.headers.x-request-id']);
  });

  it('finds a changed path segment', () => {
    const diff = diffCaptures(
      base({ url: 'https://a.example.test/task/111' }),
      base({ url: 'https://a.example.test/task/222' }),
    );
    expect(diff.entries[0]?.volatileFields).toEqual(['request.path[2]']);
  });

  it('reports a changed array length once, not per element', () => {
    const diff = diffCaptures(
      base({ body: '{"items":[1,2]}', bodyEncoding: 'utf8' }),
      base({ body: '{"items":[1,2,3]}', bodyEncoding: 'utf8' }),
    );
    expect(diff.entries[0]?.volatileFields).toEqual(['request.body.items[]']);
  });

  it('does not pretend to diff a binary body', () => {
    const diff = diffCaptures(
      base({ body: 'AAAA', bodyEncoding: 'base64' }),
      base({ body: 'BBBB', bodyEncoding: 'base64' }),
    );
    expect(diff.entries[0]?.volatileFields).toEqual(['request.body(binary)']);
  });

  it('falls back to the whole body when it is not JSON', () => {
    const diff = diffCaptures(
      base({ body: 'plain one', bodyEncoding: 'utf8' }),
      base({ body: 'plain two', bodyEncoding: 'utf8' }),
    );
    expect(diff.entries[0]?.volatileFields).toEqual(['request.body']);
  });
});
