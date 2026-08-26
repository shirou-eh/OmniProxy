import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeBundle, findPollGroups, findValueLinks } from '../src/analyze.js';
import { importHar } from '../src/har.js';
import { sanitizeBundle } from '../src/sanitize.js';
import type { CaptureBundle, CaptureEntry } from '@omniproxy/schema';

const har: unknown = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/devtools-sse.har', import.meta.url)), 'utf8'),
);

function analyzed() {
  return analyzeBundle(importHar(har, { providerId: 'example', scenario: 'chat-stream' }));
}

function entry(partial: Partial<CaptureEntry> & { index: number }): CaptureEntry {
  return {
    startedAt: 0,
    request: { method: 'GET', url: 'https://api.example.test/x', headers: [] },
    response: { status: 200, headers: [] },
    classification: 'unknown',
    ...partial,
  };
}

describe('analyzeBundle on the reference capture', () => {
  const result = analyzed();
  const step = (index: number) => result.flow.concat(result.noise).find((s) => s.index === index);

  it('separates the API calls from the noise without deleting anything', () => {
    expect(result.flow.length + result.noise.length).toBe(6);
    // The telemetry beacon and the logo are set aside, not lost.
    expect(result.noise.map((s) => s.index).sort()).toEqual([2, 3]);
  });

  it('names the telemetry beacon and says why', () => {
    expect(step(3)?.classification).toBe('telemetry');
    expect(step(3)?.reasons.join(' ')).toContain('/beacon');
  });

  it('treats an unlinked image as site furniture, not a generated artifact', () => {
    expect(step(2)?.classification).toBe('static');
    expect(step(2)?.reasons.join(' ')).toContain('not linked');
  });

  it('recognises the streaming POST as the send call', () => {
    expect(step(1)?.classification).toBe('send');
    expect(step(1)?.reasons.join(' ')).toContain('streamed response');
  });

  it('recognises the session-creating call by the value it hands to the next request', () => {
    expect(step(0)?.classification).toBe('session');
    expect(step(0)?.reasons.join(' ')).toContain('$.data.id');
  });

  it('finds the chat id flowing from the first response into the second request', () => {
    const link = result.links.find((l) => l.from === 0 && l.to === 1);
    expect(link).toBeDefined();
    expect(link?.sourcePath).toBe('$.data.id');
    expect(link?.targetPath).toBe('url');
    // Analysis output gets pasted into issues: never print a value whole.
    expect(link?.sample).toContain('…');
  });

  it('reports the unclassified call rather than hiding it', () => {
    expect(step(5)?.classification).toBe('unknown');
    expect(result.warnings.join(' ')).toContain('could not be classified');
  });

  it('writes the classification back onto the bundle', () => {
    expect(result.bundle.entries[1]?.classification).toBe('send');
    expect(result.bundle.entries[3]?.classification).toBe('telemetry');
  });
});

describe('analysis survives sanitization', () => {
  it('still links values that were redacted, because placeholders are stable', () => {
    // This is why redaction uses one stable placeholder per value (PR-2): the
    // dependency graph has to survive it, or fixtures would be useless for analysis.
    const raw: CaptureBundle = {
      id: 'x',
      providerId: 'example',
      capturedAt: '2026-08-27T00:00:00.000Z',
      method: 'har-import',
      scenario: 's',
      sanitized: false,
      redactions: {},
      notes: [],
      entries: [
        entry({
          index: 0,
          request: { method: 'POST', url: 'https://api.example.test/session', headers: [] },
          response: {
            status: 200,
            headers: [['content-type', 'application/json']],
            body: '{"token":"tok-9f3a7c21b8d4e6f0a2c5b7d9"}',
            bodyEncoding: 'utf8',
            mimeType: 'application/json',
          },
        }),
        entry({
          index: 1,
          request: {
            method: 'POST',
            url: 'https://api.example.test/chat',
            headers: [['authorization', 'Bearer tok-9f3a7c21b8d4e6f0a2c5b7d9']],
          },
          response: { status: 200, headers: [] },
        }),
      ],
    };

    const before = findValueLinks(raw.entries);
    expect(before).toHaveLength(1);

    const after = findValueLinks(sanitizeBundle(raw).bundle.entries);
    expect(after).toHaveLength(1);
    expect(after[0]?.from).toBe(0);
    expect(after[0]?.to).toBe(1);
    expect(after[0]?.targetPath).toBe('header.authorization');
  });
});

describe('poll detection', () => {
  const polling = [
    entry({
      index: 0,
      request: { method: 'GET', url: 'https://api.example.test/task/7', headers: [] },
      response: { status: 200, headers: [], body: '{"status":"running","progress":10}', bodyEncoding: 'utf8', mimeType: 'application/json' },
    }),
    entry({
      index: 1,
      request: { method: 'GET', url: 'https://api.example.test/task/7', headers: [] },
      response: { status: 200, headers: [], body: '{"status":"running","progress":60}', bodyEncoding: 'utf8', mimeType: 'application/json' },
    }),
  ];

  it('spots a repeated GET whose response keeps changing', () => {
    expect([...findPollGroups(polling)].sort()).toEqual([0, 1]);
    const result = analyzeBundle({
      id: 'p', providerId: 'x', capturedAt: '2026-08-27T00:00:00.000Z', method: 'har-import',
      scenario: 'poll', sanitized: false, redactions: {}, notes: [], entries: polling,
    });
    expect(result.flow.every((s) => s.classification === 'poll')).toBe(true);
  });

  it('does not call a repeated identical response a poll — that is a cache', () => {
    const cached = polling.map((e) => ({
      ...e,
      response: { ...e.response, body: '{"status":"running"}' },
    }));
    expect(findPollGroups(cached).size).toBe(0);
  });
});

describe('classification edge cases', () => {
  const bundle = (entries: CaptureEntry[]): CaptureBundle => ({
    id: 'e', providerId: 'x', capturedAt: '2026-08-27T00:00:00.000Z', method: 'har-import',
    scenario: 's', sanitized: false, redactions: {}, notes: [], entries,
  });

  it('calls a CORS preflight what it is', () => {
    const result = analyzeBundle(bundle([entry({ index: 0, request: { method: 'OPTIONS', url: 'https://a.example.test/api', headers: [] } })]));
    expect(result.noise[0]?.classification).toBe('static');
    expect(result.noise[0]?.reasons[0]).toContain('preflight');
  });

  it('recognises a known telemetry host even on an innocent path', () => {
    const result = analyzeBundle(bundle([entry({
      index: 0,
      request: { method: 'POST', url: 'https://o1.ingest.sentry.io/api/store', headers: [] },
    })]));
    expect(result.noise[0]?.classification).toBe('telemetry');
  });

  it('recognises a multipart upload', () => {
    const result = analyzeBundle(bundle([entry({
      index: 0,
      request: {
        method: 'POST', url: 'https://a.example.test/upload', headers: [],
        body: '--boundary', bodyEncoding: 'utf8', mimeType: 'multipart/form-data; boundary=x',
      },
    })]));
    expect(result.flow[0]?.classification).toBe('upload');
  });

  it('calls a separate SSE endpoint a stream, not a send', () => {
    const result = analyzeBundle(bundle([entry({
      index: 0,
      request: { method: 'GET', url: 'https://a.example.test/events', headers: [] },
      response: { status: 200, headers: [], mimeType: 'text/event-stream', frames: [{ at: null, raw: 'data: hi', data: 'hi' }] },
    })]));
    expect(result.flow[0]?.classification).toBe('stream');
  });

  it('warns when a capture contains nothing but noise', () => {
    const result = analyzeBundle(bundle([entry({
      index: 0,
      request: { method: 'GET', url: 'https://a.example.test/app.js', headers: [] },
      response: { status: 200, headers: [], mimeType: 'application/javascript' },
    })]));
    expect(result.flow).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('recorded before the interesting request');
  });

  it('warns when nothing links, which usually means the bodies are missing', () => {
    const result = analyzeBundle(bundle([
      entry({ index: 0, request: { method: 'POST', url: 'https://a.example.test/one', headers: [] } }),
      entry({ index: 1, request: { method: 'POST', url: 'https://a.example.test/two', headers: [] } }),
    ]));
    expect(result.warnings.join(' ')).toContain('missing response bodies');
  });
});

describe('websocket connections', () => {
  it('calls an upgraded connection a stream, not an unknown', () => {
    const result = analyzeBundle({
      id: 'w', providerId: 'x', capturedAt: '2026-08-27T00:00:00.000Z', method: 'har-import',
      scenario: 'ws', sanitized: false, redactions: {}, notes: [],
      entries: [entry({
        index: 0,
        request: { method: 'GET', url: 'wss://api.example.test/ws', headers: [] },
        response: {
          status: 101,
          headers: [['upgrade', 'websocket']],
          webSocketMessages: [{ direction: 'send', at: 0, data: '{"op":"subscribe"}' }],
        },
      })],
    });
    expect(result.flow[0]?.classification).toBe('stream');
    expect(result.flow[0]?.reasons[0]).toContain('websocket');
  });
});
