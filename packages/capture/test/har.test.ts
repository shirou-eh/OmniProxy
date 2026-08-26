import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { headerValue, headerValues } from '@omniproxy/schema';
import { beforeAll, describe, expect, it } from 'vitest';
import { HarImportError, importHar } from '../src/har.js';
import type { CaptureBundle } from '@omniproxy/schema';

const fixturePath = fileURLToPath(new URL('./fixtures/devtools-sse.har', import.meta.url));

describe('importHar', () => {
  let har: unknown;
  let bundle: CaptureBundle;

  beforeAll(() => {
    har = JSON.parse(readFileSync(fixturePath, 'utf8'));
    bundle = importHar(har, {
      providerId: 'example',
      scenario: 'chat-stream',
      source: 'devtools-sse.har',
    });
  });

  it('keeps every entry, in order — filtering is the analyzer\'s job, not the importer\'s', () => {
    const harEntryCount = (har as { log: { entries: unknown[] } }).log.entries.length;
    expect(bundle.entries).toHaveLength(harEntryCount);
    expect(bundle.entries.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5]);
    // The telemetry beacon survives import; PR-3 is what decides to ignore it.
    expect(bundle.entries[3]?.request.url).toContain('telemetry.example.test');
  });

  it('marks the bundle as unsanitized, because it still holds live values', () => {
    expect(bundle.sanitized).toBe(false);
    expect(bundle.method).toBe('har-import');
    expect(bundle.source).toBe('devtools-sse.har');
  });

  it('takes the capture time from the first entry, not from the import', () => {
    expect(bundle.capturedAt).toBe('2026-08-27T00:10:00.000Z');
    expect(bundle.id).toBe('example-chat-stream-20260827-001000Z');
  });

  it('reassembles the SSE response into frames', () => {
    const frames = bundle.entries[1]?.response.frames;
    expect(frames).toBeDefined();
    expect(frames).toHaveLength(4);
    expect(frames?.[0]?.data).toBe('{"delta":"Hel"}');
    expect(frames?.[1]?.data).toBe('{"delta":"lo"}\n{"delta":"!"}');
    expect(frames?.[2]?.data).toBeUndefined(); // : keep-alive
    expect(frames?.[3]?.data).toBe('[DONE]');
    // A HAR has no per-frame timings; claiming otherwise would be an invention.
    expect(frames?.every((f) => f.at === null)).toBe(true);
  });

  it('does not try to frame a non-streaming response', () => {
    expect(bundle.entries[0]?.response.frames).toBeUndefined();
  });

  it('preserves header order and repeated headers', () => {
    const responseHeaders = bundle.entries[0]?.response.headers ?? [];
    expect(headerValues(responseHeaders, 'set-cookie')).toEqual([
      'session_id=s-1234; Path=/; HttpOnly',
      'csrf=c-5678; Path=/',
    ]);

    const requestHeaders = bundle.entries[0]?.request.headers ?? [];
    expect(requestHeaders.map(([name]) => name)).toEqual([
      'content-type',
      'origin',
      'user-agent',
    ]);
  });

  it('drops HTTP/2 pseudo-headers but keeps the protocol', () => {
    const requestHeaders = bundle.entries[0]?.request.headers ?? [];
    expect(requestHeaders.some(([name]) => name.startsWith(':'))).toBe(false);
    expect(bundle.entries[0]?.request.httpVersion).toBe('h2');
  });

  it('carries request bodies through untouched', () => {
    expect(bundle.entries[0]?.request.body).toBe('{"title":"New chat"}');
    expect(bundle.entries[0]?.request.mimeType).toBe('application/json');
  });

  it('flags a base64 body instead of corrupting it', () => {
    const response = bundle.entries[2]?.response;
    expect(response?.bodyEncoding).toBe('base64');
    expect(response?.body).toBe('iVBORw0KGgo=');
    expect(response?.frames).toBeUndefined();
  });

  it('maps websocket messages with direction and relative timing', () => {
    const messages = bundle.entries[4]?.response.webSocketMessages;
    expect(messages).toHaveLength(2);
    expect(messages?.[0]?.direction).toBe('send');
    expect(messages?.[0]?.at).toBe(500);
    expect(messages?.[1]?.direction).toBe('receive');
    expect(messages?.[1]?.at).toBe(1250);
  });

  it('notes a body the HAR omitted rather than letting it look empty', () => {
    // The most common way a capture turns out useless: exported without content.
    expect(bundle.notes).toHaveLength(1);
    expect(bundle.notes[0]).toContain('entry 5');
    expect(bundle.notes[0]).toContain('Save all as HAR with content');
    expect(bundle.entries[5]?.response.body).toBeUndefined();
  });

  it('records timings from the HAR', () => {
    expect(bundle.entries[0]?.startedAt).toBe(Date.parse('2026-08-27T00:10:00.000Z'));
    expect(bundle.entries[0]?.durationMs).toBe(143.5);
  });

  it('leaves every entry unclassified', () => {
    expect(bundle.entries.every((e) => e.classification === 'unknown')).toBe(true);
  });

  it('is deterministic — the same file imports to the same bundle', () => {
    const again = importHar(har, { providerId: 'example', scenario: 'chat-stream' });
    expect(again.entries).toEqual(bundle.entries);
    expect(again.id).toBe(bundle.id);
  });
});

describe('importHar failure modes', () => {
  it('rejects a file that is not a HAR, and says what to do about it', () => {
    expect(() => importHar({ nope: true }, { providerId: 'x', scenario: 'y' })).toThrow(
      HarImportError,
    );

    try {
      importHar({ nope: true }, { providerId: 'x', scenario: 'y' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HarImportError);
      // Invariant I-2: no error reaches a person without a concrete next step.
      expect((error as HarImportError).userAction).toContain('Save all as HAR with content');
    }
  });

  it('accepts a HAR with no entries at all', () => {
    const empty = importHar({ log: { version: '1.2', entries: [] } }, {
      providerId: 'x',
      scenario: 'y',
      capturedAt: '2026-08-27T00:00:00.000Z',
    });
    expect(empty.entries).toEqual([]);
    expect(empty.notes).toEqual([]);
  });

  it('ignores unknown HAR fields instead of failing on them', () => {
    const bundle = importHar(
      {
        log: {
          entries: [
            {
              startedDateTime: '2026-08-27T00:00:00.000Z',
              _somethingChromeInvented: { deep: true },
              request: { method: 'GET', url: 'https://a.example.test/', headers: [] },
              response: { status: 200, headers: [], content: {} },
            },
          ],
        },
      },
      { providerId: 'x', scenario: 'y' },
    );
    expect(bundle.entries).toHaveLength(1);
  });
});

describe('header helpers', () => {
  it('finds a header case-insensitively', () => {
    expect(headerValue([['Content-Type', 'application/json']], 'content-type')).toBe(
      'application/json',
    );
    expect(headerValue([], 'content-type')).toBeUndefined();
  });
});
