import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { CaptureBundle, CaptureEntry } from '@omniproxy/schema';
import { draftDeclaration } from '../src/draft.js';

/**
 * The declaration drafter.
 *
 * Two kinds of test here, and the second kind matters more.
 *
 * The first checks that what the recording *did* show comes out right: the endpoints,
 * the flow order, the value that was traced from one response into the next request.
 *
 * The second checks that what the recording did *not* show comes out as a TODO rather
 * than as something plausible. That is the whole discipline of §12.1, and it is easy
 * to lose here: a generator that fills in a sensible-looking default produces a file
 * indistinguishable from a verified one, and the mistake surfaces weeks later as a
 * provider that has "always been broken".
 */

const bundle = makeBundle([
  entry(0, 'POST', 'https://chat.example.test/api/v0/chat/create_pow_challenge', {
    requestBody: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
    responseBody: JSON.stringify({
      data: { biz_data: { challenge: { salt: 'abc', difficulty: 144000 } } },
    }),
  }),
  entry(1, 'POST', 'https://chat.example.test/api/v0/chat_session/create', {
    requestBody: '{}',
    responseBody: JSON.stringify({ data: { biz_data: { id: 'session-4f2a9c7e1b3d' } } }),
  }),
  entry(2, 'POST', 'https://chat.example.test/api/v0/chat/completion', {
    requestHeaders: [['x-ds-pow-response', 'eyJhbGciOiJIUzI1NiJ9eyJzYWx0IjoiYWJjIn0abcdef']],
    requestBody: JSON.stringify({
      chat_session_id: 'session-4f2a9c7e1b3d',
      parent_message_id: null,
      prompt: 'привет',
      model: 'deepseek_chat',
      thinking_enabled: false,
    }),
    mimeType: 'text/event-stream',
    frames: [
      { at: 1, raw: 'data: {"p":"response/fragments","o":"APPEND","v":{"type":"RESPONSE","content":"hi"}}', data: '{"p":"response/fragments","o":"APPEND","v":{"type":"RESPONSE","content":"hi"}}' },
      { at: 2, raw: 'data: {"v":" there"}', data: '{"v":" there"}' },
    ],
  }),
]);

describe('what the drafter reads out of a recording', () => {
  it('produces a declaration that validates as YAML', () => {
    const { yaml } = draftDeclaration(bundle);
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    expect(parsed['schemaVersion']).toBe(1);
    expect(parsed['id']).toBe('example');
  });

  it('starts at needs-capture, because raising a status is a decision', () => {
    const parsed = parseYaml(draftDeclaration(bundle).yaml) as Record<string, unknown>;
    expect(parsed['status']).toBe('needs-capture');
  });

  it('takes the channel base from the host that was actually recorded', () => {
    const parsed = parseYaml(draftDeclaration(bundle).yaml) as any;
    expect(parsed.channels[0].base).toBe('https://chat.example.test');
  });

  it('recovers the flow in the order the calls happened', () => {
    const parsed = parseYaml(draftDeclaration(bundle).yaml) as any;
    expect(parsed.flow.prepare[0].request.path).toBe('/api/v0/chat/create_pow_challenge');
    expect(parsed.flow.createSession.request.path).toBe('/api/v0/chat_session/create');
    expect(parsed.flow.send.request.path).toBe('/api/v0/chat/completion');
  });

  it('traces the session id from the response that made it into the request that used it', () => {
    // This link is the reason createSession is a step at all. Without it the drafter
    // would be guessing that a POST returning an id is a session.
    const { yaml, notes } = draftDeclaration(bundle);
    const parsed = parseYaml(yaml) as any;
    expect(parsed.flow.createSession.extract.sessionId).toBe('$.data.biz_data.id');
    expect(parsed.flow.send.request.json.chat_session_id).toBe('{{state.sessionId}}');
    expect(notes.join(' ')).toMatch(/traced from/);
  });

  it('turns the recorded prompt into a placeholder', () => {
    const parsed = parseYaml(draftDeclaration(bundle).yaml) as any;
    expect(parsed.flow.send.request.json.prompt).toBe('{{req.prompt}}');
  });

  it('reads a recorded null parent id as the first turn, not as a constant', () => {
    const parsed = parseYaml(draftDeclaration(bundle).yaml) as any;
    expect(parsed.flow.send.request.json.parent_message_id).toBe(
      '{{state.parentMessageId|null-if-empty}}',
    );
  });

  it('keeps body fields it has no opinion about exactly as recorded', () => {
    const parsed = parseYaml(draftDeclaration(bundle).yaml) as any;
    expect(parsed.flow.send.request.json.thinking_enabled).toBe(false);
  });

  it('recognises json-patch framing from the frames themselves', () => {
    const { yaml } = draftDeclaration(bundle);
    const parsed = parseYaml(yaml) as any;
    expect(parsed.flow.send.stream.format).toBe('json-patch');
    // The sticky path is the detail a reader must know and cannot see in one frame.
    expect(yaml).toMatch(/sticky/);
  });

  it('quotes a header value that YAML would read as a number', () => {
    // `20241129.1` is a string to HTTP and a float to YAML. Getting this wrong makes
    // the drafter emit a file that fails its own schema.
    const withVersion = makeBundle([
      entry(0, 'POST', 'https://x.test/send', {
        requestHeaders: [['x-app-version', '20241129.1']],
        requestBody: '{"prompt":"hi"}',
      }),
    ]);
    const parsed = parseYaml(draftDeclaration(withVersion).yaml) as any;
    expect(parsed.channels[0].fingerprint.static['x-app-version']).toBe('20241129.1');
  });

  it('picks up a model name that is plainly in the body', () => {
    const parsed = parseYaml(draftDeclaration(bundle).yaml) as any;
    expect(parsed.models[0].native).toBe('deepseek_chat');
  });
});

describe('what the drafter refuses to invent', () => {
  it('never bakes in a per-request header, however authoritative it looks', () => {
    // The recorded proof-of-work blob is valid for one request and expires. Writing it
    // down produces a header that looks like a fact and 403s forever.
    const { yaml } = draftDeclaration(bundle);
    const parsed = parseYaml(yaml) as any;

    expect(parsed.flow.send.request.headers['x-ds-pow-response']).toBe('{{vars.TODO}}');
    expect(yaml).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(yaml).toMatch(/this header changed per request/);
    // The shape is described so a reader can choose a transform; the value is not.
    expect(yaml).toMatch(/base64, \d+ characters/);
  });

  it('keeps an unexplained call instead of dropping it', () => {
    // Dropping it would be the worst failure available: the draft would look complete
    // and the provider would answer 403, because the step that mints the token is gone.
    const { yaml, notes } = draftDeclaration(bundle);
    expect(yaml).toMatch(/what is this call for\?/);
    expect(notes.join(' ')).toMatch(/usually anti-bot work/);
  });

  it('marks the stream routes as unknown rather than guessing the fragment types', () => {
    expect(draftDeclaration(bundle).yaml).toMatch(/which fragment type feeds which channel/);
  });

  it('does not pretend to know the error shapes a successful recording never showed', () => {
    const { yaml } = draftDeclaration(bundle);
    expect(yaml).toMatch(/a successful recording contains no failures/);
  });

  it('leaves the context budget unmeasured', () => {
    const parsed = parseYaml(draftDeclaration(bundle).yaml) as any;
    expect(parsed.context.measured).toBeUndefined();
    expect(draftDeclaration(bundle).yaml).toMatch(/guess wearing a fact's clothes/);
  });

  it('says what is left to do, every time', () => {
    const { todos } = draftDeclaration(bundle);
    expect(todos).toContain('read every TODO(capture) comment in the file');
    expect(todos.join(' ')).toMatch(/raise status only once it has actually answered/);
  });
});

describe('recordings that do not support a draft', () => {
  it('says so when nothing in the capture carries a prompt', () => {
    const onlyGets = makeBundle([
      entry(0, 'GET', 'https://x.test/api/models', { responseBody: '{"models":[]}' }),
    ]);
    expect(draftDeclaration(onlyGets).todos.join(' ')).toMatch(/record a scenario where you/);
  });

  it('says so when the recording spans several hosts', () => {
    const split = makeBundle([
      entry(0, 'POST', 'https://a.test/send', { requestBody: '{"prompt":"hi"}' }),
      entry(1, 'POST', 'https://b.test/send', { requestBody: '{"prompt":"hi"}' }),
    ]);
    const { yaml, todos } = draftDeclaration(split);
    expect(todos.join(' ')).toMatch(/several hosts/);
    expect(yaml).toMatch(/TODO\(capture\): several hosts were recorded/);
  });

  it('describes a non-streamed answer as a response block, not an invented stream', () => {
    const oneShot = makeBundle([
      entry(0, 'POST', 'https://x.test/generate', {
        requestBody: '{"prompt":"hi"}',
        responseBody: '{"text":"hello"}',
        mimeType: 'application/json',
      }),
    ]);
    const { yaml } = draftDeclaration(oneShot);
    expect(yaml).toMatch(/The recorded response was one body, not a stream/);
    expect(yaml).toMatch(/text: \$\.TODO/);
  });

  it('reproduces a non-JSON body verbatim and asks a human to templatise it', () => {
    const formPost = makeBundle([
      entry(0, 'POST', 'https://x.test/send', {
        requestBody: 'prompt=hello&stream=1',
        mimeType: 'application/json',
      }),
    ]);
    expect(draftDeclaration(formPost).yaml).toMatch(/the recorded body was not JSON/);
  });

  it('reports auth as none when no credential was recorded, and says what that means', () => {
    const anonymous = makeBundle([
      entry(0, 'POST', 'https://x.test/send', { requestBody: '{"prompt":"hi"}' }),
    ]);
    const { yaml } = draftDeclaration(anonymous);
    expect(parseYaml(yaml).auth.kind).toBe('none');
    expect(yaml).toMatch(/the recording was of a logged-out session/);
  });

  it('reads a cookie-and-bearer recording as cookie+bearer', () => {
    const both = makeBundle([
      entry(0, 'POST', 'https://x.test/send', {
        requestHeaders: [
          ['authorization', 'Bearer live-token-value'],
          ['cookie', 'sid=abc'],
        ],
        requestBody: '{"prompt":"hi"}',
      }),
    ]);
    const parsed = parseYaml(draftDeclaration(both).yaml) as any;
    expect(parsed.auth.kind).toBe('cookie+bearer');
    expect(parsed.auth.present.headers.authorization).toBe('Bearer {{auth.token}}');
    expect(parsed.auth.present.headers.cookie).toBe('{{auth.cookieHeader}}');
    // The live token itself never reaches the file.
    expect(draftDeclaration(both).yaml).not.toContain('live-token-value');
  });
});

/* ──────────────────────────────────── fixtures ──────────────────────────────────── */

interface EntryOptions {
  requestHeaders?: [string, string][];
  requestBody?: string;
  responseBody?: string;
  mimeType?: string;
  frames?: { at: number | null; raw: string; data?: string }[];
  status?: number;
}

function entry(index: number, method: string, url: string, options: EntryOptions = {}): CaptureEntry {
  return {
    index,
    startedAt: 1_700_000_000_000 + index * 100,
    durationMs: 50,
    request: {
      method,
      url,
      headers: [
        ['accept', '*/*'],
        ['content-type', 'application/json'],
        ...(options.requestHeaders ?? []),
      ],
      ...(options.requestBody !== undefined
        ? { body: options.requestBody, bodyEncoding: 'utf8' as const }
        : {}),
    },
    response: {
      status: options.status ?? 200,
      headers: [['content-type', options.mimeType ?? 'application/json']],
      body: options.responseBody ?? '{}',
      bodyEncoding: 'utf8',
      mimeType: options.mimeType ?? 'application/json',
      ...(options.frames ? { frames: options.frames } : {}),
    },
    classification: 'unknown',
  };
}

function makeBundle(entries: CaptureEntry[]): CaptureBundle {
  return {
    id: 'test-bundle',
    providerId: 'example',
    capturedAt: '2026-08-27T10:00:00.000Z',
    method: 'cdp',
    scenario: 'chat-stream',
    sanitized: true,
    entries,
    redactions: {},
    notes: [],
  };
}
