import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { StreamSpec } from '@omniproxy/schema';
import { describe, expect, it } from 'vitest';
import { createFramer, type FrameEvent } from '../src/framing.js';

/**
 * Golden parity: the declarative json-patch framer against the DeepSeek parser that
 * has been in production in `legacy/server.js`.
 *
 * The whole rewrite rests on one claim — that a declaration plus generic code can do
 * what the hand-written adapter did. This is the test that either supports the claim
 * or destroys it (risk R-15). It is worth its awkwardness: the oracle is not a set of
 * expectations I derived by reading the legacy code and hoping, it is the legacy code,
 * loaded and executed. `rebuildFragmentText` and `applyResponsePatchOperations` decide
 * what a fragment means; the loop around them is transcribed from the same file.
 */

const require = createRequire(import.meta.url);
const legacyPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../legacy/server.js',
);

interface LegacyInternals {
  rebuildFragmentText(fragments: unknown[]): { responseText: string; thinkText: string };
  applyResponsePatchOperations(ops: unknown, append: (value: unknown) => void): boolean;
  isDeepSeekModelErrorEvent(event: unknown): boolean;
}

const legacy = (require(legacyPath) as { __test: LegacyInternals }).__test;

interface ParsedStream {
  content: string;
  reasoningContent: string;
  messageId: string | null;
  finishReason: string | null;
}

/**
 * `readDeepSeekResponse` from legacy/server.js, transcribed verbatim around the
 * legacy functions it calls. It is not exported (it closes over the session), so this
 * is the closest an oracle can get without changing the code being compared against.
 */
function legacyParse(chunks: string[]): ParsedStream {
  let buffer = '';
  let lastPath: string | null = null;
  const fragments: Record<string, unknown>[] = [];
  let fullContent = '';
  let reasoningContent = '';
  let newMessageId: string | null = null;
  let finishReason: string | null = null;

  const rebuildFragmentState = () => {
    const { responseText, thinkText } = legacy.rebuildFragmentText(fragments);
    if (responseText) fullContent = responseText;
    reasoningContent = thinkText;
  };

  const appendFragments = (value: unknown) => {
    const incoming = Array.isArray(value) ? value : [value];
    for (const fragment of incoming) {
      if (fragment && typeof fragment === 'object') {
        fragments.push({ ...(fragment as Record<string, unknown>) });
      }
    }
    rebuildFragmentState();
  };

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  for (const chunk of chunks) {
    buffer += decoder.decode(encoder.encode(chunk), { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const d = JSON.parse(line.slice(6)) as Record<string, any>;
        if (d['response_message_id'] !== undefined && !newMessageId) {
          newMessageId = String(d['response_message_id']);
        }
        if (d['finish_reason']) finishReason = d['finish_reason'];
        if (d['p'] !== undefined) lastPath = d['p'];
        if (d['v'] && typeof d['v'] === 'object' && d['v'].response) {
          if (d['v'].response.message_id !== undefined) {
            newMessageId = String(d['v'].response.message_id);
          }
          if (d['v'].response.content !== undefined) fullContent = d['v'].response.content;
          if (Array.isArray(d['v'].response.fragments)) {
            fragments.length = 0;
            appendFragments(d['v'].response.fragments);
          }
          if (d['v'].response.finish_reason !== undefined) {
            finishReason = d['v'].response.finish_reason;
          }
        }
        if (lastPath === 'response/fragments' && d['v'] !== undefined) appendFragments(d['v']);
        if (lastPath === 'response' && d['v'] !== undefined) {
          legacy.applyResponsePatchOperations(d['v'], appendFragments);
        }
        if (
          lastPath === 'response/fragments/-1/content' &&
          d['v'] !== undefined &&
          typeof d['v'] !== 'object'
        ) {
          if (fragments.length > 0) {
            const last = fragments[fragments.length - 1] as Record<string, unknown>;
            last['content'] = `${last['content'] || ''}${d['v']}`;
            rebuildFragmentState();
          }
        }
        if (lastPath === 'response/content' && d['v'] !== undefined && typeof d['v'] !== 'object') {
          fullContent += d['v'];
        }
        if (lastPath === 'response/finish_reason' && d['v'] !== undefined) finishReason = d['v'];
        if (lastPath === 'response/status' && d['v'] !== undefined && d['v'] !== 'FINISHED') {
          finishReason = d['v'];
        }
      } catch {
        // legacy swallows unparsable frames
      }
    }
  }

  return { content: fullContent, reasoningContent, messageId: newMessageId, finishReason };
}

const spec: StreamSpec = { format: 'json-patch' };

/** The same stream through the new engine, collapsed to the same four values. */
function enginePar(chunks: string[]): ParsedStream {
  const framer = createFramer(spec);
  const events: FrameEvent[] = [];
  for (const chunk of chunks) events.push(...framer.push(chunk));
  events.push(...framer.end());

  let content = '';
  let reasoningContent = '';
  let messageId: string | null = null;
  let finishReason: string | null = null;

  for (const event of events) {
    if (event.kind === 'text') content += event.text;
    else if (event.kind === 'reasoning') reasoningContent += event.text;
    else if (event.kind === 'messageId' && messageId === null) messageId = event.id;
    else if (event.kind === 'finish') finishReason = event.reason;
  }

  return { content, reasoningContent, messageId, finishReason };
}

function stream(...frames: unknown[]): string[] {
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`);
}

/* ─────────────────────────────── the recorded shapes ─────────────────────────────── */

const scenarios: Record<string, string[]> = {
  'a plain answer, fragment by fragment': stream(
    { response_message_id: 101 },
    { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'Пр' } },
    { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'ивет' } },
    { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: ', мир!' } },
    { p: 'response/finish_reason', v: 'stop' },
  ),

  'the sticky path, which is how DeepSeek actually streams': stream(
    { response_message_id: 202 },
    { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '' } },
    { p: 'response/fragments/-1/content', v: 'The ' },
    { v: 'quick ' },
    { v: 'brown ' },
    { v: 'fox' },
    { p: 'response/finish_reason', v: 'stop' },
  ),

  'thinking then answering': stream(
    { response_message_id: 303 },
    { p: 'response/fragments', o: 'APPEND', v: { type: 'THINK', content: 'Let me think.' } },
    { p: 'response/fragments/-1/content', v: ' Still thinking.' },
    { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'Answer: 42' } },
    { p: 'response/finish_reason', v: 'stop' },
  ),

  'a search fragment, which counts as output': stream(
    { p: 'response/fragments', o: 'APPEND', v: { type: 'SEARCH', content: '[1] example.com' } },
    { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: ' answer' } },
  ),

  'a batch of operations against the response path': stream(
    { response_message_id: 404 },
    {
      p: 'response',
      v: [
        { p: 'fragments', o: 'APPEND', v: { type: 'THINK', content: 'hmm' } },
        { p: 'fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'result' } },
        { p: 'other', o: 'SET', v: 'ignored' },
      ],
    },
  ),

  'the whole-response form': stream({
    v: {
      response: {
        message_id: 505,
        fragments: [
          { type: 'THINK', content: 'reasoned' },
          { type: 'RESPONSE', content: 'assembled' },
        ],
        finish_reason: 'stop',
      },
    },
  }),

  'content on the response path with no fragments at all': stream(
    { p: 'response/content', v: 'plain ' },
    { v: 'accumulated ' },
    { v: 'text' },
    { p: 'response/finish_reason', v: 'stop' },
  ),

  'a status that is not FINISHED': stream(
    { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'partial' } },
    { p: 'response/status', v: 'CONTENT_FILTER' },
  ),

  'a top-level finish reason': stream(
    { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'done' } },
    { finish_reason: 'length' },
  ),

  'fragments without a content string, which must be skipped': stream(
    { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'kept' } },
    { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE' } },
    { p: 'response/fragments', o: 'APPEND', v: { type: 'UNKNOWN_KIND', content: 'dropped' } },
  ),

  'unparsable frames mixed into a good stream': [
    'data: {"p":"response/fragments","o":"APPEND","v":{"type":"RESPONSE","content":"a"}}\n\n',
    'data: <html>rate limited</html>\n\n',
    'data: {"p":"response/fragments","o":"APPEND","v":{"type":"RESPONSE","content":"b"}}\n\n',
  ],

  'an empty stream': [],

  'a keep-alive with no useful content': stream({}, {}, {}),
};

describe('the declarative engine reproduces the legacy DeepSeek parser', () => {
  for (const [name, chunks] of Object.entries(scenarios)) {
    it(name, () => {
      expect(enginePar(chunks)).toEqual(legacyParse(chunks));
    });
  }

  it('agrees on every chunk boundary, not just on whole frames', () => {
    // A stream arrives in whatever pieces the socket felt like. Both parsers must be
    // insensitive to that, and the only way to know is to try every split.
    const whole = scenarios['the sticky path, which is how DeepSeek actually streams']!.join('');
    const expected = legacyParse([whole]);

    for (let size = 1; size <= 40; size += 1) {
      const pieces: string[] = [];
      for (let index = 0; index < whole.length; index += size) {
        pieces.push(whole.slice(index, index + size));
      }
      expect(enginePar(pieces), `engine, chunk size ${size}`).toEqual(expected);
      expect(legacyParse(pieces), `legacy, chunk size ${size}`).toEqual(expected);
    }
  });

  it('agrees on a long stream assembled from random fragment sizes', () => {
    const sentence = 'Съешь ещё этих мягких французских булок, да выпей чаю. 🍞';
    const frames: unknown[] = [
      { response_message_id: 909 },
      { p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '' } },
      { p: 'response/fragments/-1/content', v: '' },
    ];
    for (const character of [...sentence]) frames.push({ v: character });
    frames.push({ p: 'response/finish_reason', v: 'stop' });

    const chunks = stream(...frames);
    const result = enginePar(chunks);
    expect(result).toEqual(legacyParse(chunks));
    expect(result.content).toBe(sentence);
  });
});

describe('where the engine deliberately goes beyond the legacy parser', () => {
  it('reports an upstream error event that legacy only recorded internally', () => {
    const framer = createFramer(spec);
    const events = framer.push('data: {"type":"error","content":"too many requests"}\n\n');
    expect(events).toContainEqual({ kind: 'upstreamError', message: 'too many requests' });
    // The legacy loop had the same information — it is what isDeepSeekModelErrorEvent
    // is for — but the caller had to look for it in a returned field.
    expect(legacy.isDeepSeekModelErrorEvent({ type: 'error', content: 'too many requests' })).toBe(
      true,
    );
  });

  it('says when the provider rewrote text it had already sent', () => {
    const framer = createFramer(spec);
    framer.push('data: {"p":"response/fragments","o":"APPEND","v":{"type":"RESPONSE","content":"first"}}\n\n');
    const events = framer.push(
      `data: ${JSON.stringify({ v: { response: { fragments: [{ type: 'RESPONSE', content: 'second' }] } } })}\n\n`,
    );
    expect(events.some((e) => e.kind === 'warning' && e.code === 'stream_rewritten')).toBe(true);
    // Legacy replaced the text silently: the client saw "firstsecond" or a jump,
    // with nothing in the logs to explain it.
  });
});
