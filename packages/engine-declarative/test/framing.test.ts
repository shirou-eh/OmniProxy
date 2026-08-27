import type { StreamSpec } from '@omniproxy/schema';
import { describe, expect, it } from 'vitest';
import { createFramer, type FrameEvent } from '../src/framing.js';

const encoder = new TextEncoder();

/** Feeds a stream in one go and returns everything the framer produced. */
function drain(spec: StreamSpec, ...chunks: string[]): FrameEvent[] {
  const framer = createFramer(spec);
  const events: FrameEvent[] = [];
  for (const chunk of chunks) events.push(...framer.push(chunk));
  events.push(...framer.end());
  return events;
}

function textOf(events: FrameEvent[]): string {
  return events
    .filter((event): event is Extract<FrameEvent, { kind: 'text' }> => event.kind === 'text')
    .map((event) => event.text)
    .join('');
}

function reasoningOf(events: FrameEvent[]): string {
  return events
    .filter((event): event is Extract<FrameEvent, { kind: 'reasoning' }> => event.kind === 'reasoning')
    .map((event) => event.text)
    .join('');
}

/** Splits text into byte-level chunks, to exercise the reassembly boundaries. */
function byteChunks(text: string, size: number): string[] {
  const bytes = encoder.encode(text);
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (let index = 0; index < bytes.length; index += size) {
    out.push(decoder.decode(bytes.subarray(index, index + size), { stream: true }));
  }
  out.push(decoder.decode());
  return out;
}

/* ────────────────────────────────────── sse ────────────────────────────────────── */

const sseSpec: StreamSpec = {
  format: 'sse',
  doneWhen: { data: '[DONE]' },
  map: {
    text: '$.choices[0].delta.content',
    reasoning: '$.choices[0].delta.reasoning_content',
    finish: '$.choices[0].finish_reason',
    messageId: '$.id',
    usage: '$.usage',
  },
};

describe('sse framing', () => {
  it('maps each data frame through the declared paths', () => {
    const events = drain(
      sseSpec,
      'data: {"id":"m1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    );

    expect(textOf(events)).toBe('Hello world');
    expect(events).toContainEqual({ kind: 'messageId', id: 'm1' });
    expect(events).toContainEqual({ kind: 'finish', reason: 'stop' });
  });

  it('reassembles frames split across chunk boundaries', () => {
    const stream = 'data: {"choices":[{"delta":{"content":"abcdef"}}]}\n\n';
    for (const size of [1, 3, 7, 13]) {
      expect(textOf(drain(sseSpec, ...stream.split('').reduce<string[]>((acc, char, index) => {
        const bucket = Math.floor(index / size);
        acc[bucket] = (acc[bucket] ?? '') + char;
        return acc;
      }, [])))).toBe('abcdef');
    }
  });

  it('keeps multi-byte characters intact when the decoder streams them', () => {
    const stream = 'data: {"choices":[{"delta":{"content":"привет 🌍"}}]}\n\n';
    expect(textOf(drain(sseSpec, ...byteChunks(stream, 5)))).toBe('привет 🌍');
  });

  it('tolerates CRLF line endings and a missing space after data:', () => {
    const events = drain(sseSpec, 'data:{"choices":[{"delta":{"content":"x"}}]}\r\n\r\n');
    expect(textOf(events)).toBe('x');
  });

  it('ignores comments, event: lines and blank frames', () => {
    const events = drain(
      sseSpec,
      ': keep-alive\n\nevent: ping\ndata: {"choices":[{"delta":{"content":"y"}}]}\n\n',
    );
    expect(textOf(events)).toBe('y');
    expect(events.filter((e) => e.kind === 'warning')).toEqual([]);
  });

  it('stops mapping after the done sentinel', () => {
    const events = drain(
      sseSpec,
      'data: [DONE]\n\ndata: {"choices":[{"delta":{"content":"late"}}]}\n\n',
    );
    expect(textOf(events)).toBe('');
  });

  it('warns about an unparsable frame rather than crashing or hiding it', () => {
    const events = drain(sseSpec, 'data: not json\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
    expect(textOf(events)).toBe('ok');
    expect(events.some((e) => e.kind === 'warning' && e.code === 'unparsable_frame')).toBe(true);
  });

  it('flushes a final frame that arrived without its trailing newline', () => {
    expect(textOf(drain(sseSpec, 'data: {"choices":[{"delta":{"content":"tail"}}]}'))).toBe('tail');
  });

  it('emits nothing for an empty delta, so an empty string is not a text event', () => {
    const events = drain(sseSpec, 'data: {"choices":[{"delta":{"content":""}}]}\n\n');
    expect(events).toEqual([]);
  });

  it('separates reasoning from text', () => {
    const events = drain(
      sseSpec,
      'data: {"choices":[{"delta":{"reasoning_content":"hmm","content":"answer"}}]}\n\n',
    );
    expect(reasoningOf(events)).toBe('hmm');
    expect(textOf(events)).toBe('answer');
  });

  it('passes usage through untouched', () => {
    const events = drain(sseSpec, 'data: {"usage":{"total_tokens":7}}\n\n');
    expect(events).toContainEqual({ kind: 'usage', usage: { total_tokens: 7 } });
  });

  it('emits nothing at all when the declaration has no map', () => {
    expect(drain({ format: 'sse' }, 'data: {"a":1}\n\n')).toEqual([]);
  });
});

/* ───────────────────────────────────── ndjson ───────────────────────────────────── */

describe('ndjson framing', () => {
  const spec: StreamSpec = { format: 'ndjson', map: { text: '$.text' } };

  it('reads one object per line', () => {
    expect(textOf(drain(spec, '{"text":"a"}\n{"text":"b"}\n'))).toBe('ab');
  });

  it('holds a partial line until it completes', () => {
    const framer = createFramer(spec);
    expect(framer.push('{"text":"a"}\n{"tex')).toHaveLength(1);
    expect(textOf(framer.push('t":"b"}\n'))).toBe('b');
  });

  it('flushes the last line without a trailing newline', () => {
    expect(textOf(drain(spec, '{"text":"only"}'))).toBe('only');
  });
});

describe('plain framing', () => {
  it('passes bytes straight through', () => {
    expect(textOf(drain({ format: 'plain' }, 'raw ', 'text'))).toBe('raw text');
  });

  it('does not emit an event for an empty chunk', () => {
    expect(drain({ format: 'plain' }, '')).toEqual([]);
  });
});

describe('unimplemented formats', () => {
  it('refuses clearly instead of failing later at runtime', () => {
    expect(() => createFramer({ format: 'websocket' })).toThrow(/not executed by the declarative engine/);
    expect(() => createFramer({ format: 'poll' })).toThrow(/flow.poll/);
  });
});

/* ─────────────────────────────────── json-patch ─────────────────────────────────── */

const patchSpec: StreamSpec = { format: 'json-patch', doneWhen: { data: '[DONE]' } };

function frame(object: unknown): string {
  return `data: ${JSON.stringify(object)}\n\n`;
}

describe('json-patch framing', () => {
  it('assembles fragments appended one at a time', () => {
    const events = drain(
      patchSpec,
      frame({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'Hel' } }),
      frame({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'lo' } }),
    );
    expect(textOf(events)).toBe('Hello');
  });

  it('honours the sticky path — a frame with no p continues the previous one', () => {
    // This is the detail that cannot be guessed from a response body, only recorded.
    const events = drain(
      patchSpec,
      frame({ p: 'response/fragments/-1/content', v: 'a' }),
      frame({ v: 'b' }),
      frame({ v: 'c' }),
    );
    expect(textOf(events)).toBe('');

    const withFragment = drain(
      patchSpec,
      frame({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '' } }),
      frame({ p: 'response/fragments/-1/content', v: 'a' }),
      frame({ v: 'b' }),
      frame({ v: 'c' }),
    );
    expect(textOf(withFragment)).toBe('abc');
  });

  it('routes THINK fragments to reasoning and RESPONSE to text', () => {
    const events = drain(
      patchSpec,
      frame({ p: 'response/fragments', o: 'APPEND', v: { type: 'THINK', content: 'думаю' } }),
      frame({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'ответ' } }),
    );
    expect(reasoningOf(events)).toBe('думаю');
    expect(textOf(events)).toBe('ответ');
  });

  it('applies a batch of operations sent against the response path', () => {
    const events = drain(
      patchSpec,
      frame({
        p: 'response',
        v: [
          { p: 'fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'one' } },
          { p: 'fragments', o: 'APPEND', v: { type: 'RESPONSE', content: ' two' } },
          { p: 'ignored', o: 'SET', v: 'nope' },
        ],
      }),
    );
    expect(textOf(events)).toBe('one two');
  });

  it('accepts the whole-response form and the message id inside it', () => {
    const events = drain(
      patchSpec,
      frame({
        v: {
          response: {
            message_id: 42,
            fragments: [{ type: 'RESPONSE', content: 'from response' }],
            finish_reason: 'stop',
          },
        },
      }),
    );
    expect(textOf(events)).toBe('from response');
    expect(events).toContainEqual({ kind: 'messageId', id: '42' });
    expect(events).toContainEqual({ kind: 'finish', reason: 'stop' });
  });

  it('falls back to response/content when no fragments ever arrive', () => {
    const events = drain(
      patchSpec,
      frame({ p: 'response/content', v: 'plain ' }),
      frame({ v: 'text' }),
    );
    expect(textOf(events)).toBe('plain text');
  });

  it('reports the message id once, not on every frame that mentions it', () => {
    const events = drain(
      patchSpec,
      frame({ response_message_id: 7 }),
      frame({ response_message_id: 7 }),
    );
    expect(events.filter((e) => e.kind === 'messageId')).toEqual([{ kind: 'messageId', id: '7' }]);
  });

  it('surfaces an upstream error event', () => {
    const events = drain(patchSpec, frame({ type: 'error', content: 'model overloaded' }));
    expect(events).toContainEqual({ kind: 'upstreamError', message: 'model overloaded' });
  });

  it('reads a finish reason from the top level, the sticky path and the status', () => {
    expect(drain(patchSpec, frame({ finish_reason: 'stop' }))).toContainEqual({
      kind: 'finish',
      reason: 'stop',
    });
    expect(drain(patchSpec, frame({ p: 'response/finish_reason', v: 'length' }))).toContainEqual({
      kind: 'finish',
      reason: 'length',
    });
    // FINISHED is the ordinary end of a response and is not a reason to stop early.
    expect(drain(patchSpec, frame({ p: 'response/status', v: 'FINISHED' }))).toEqual([]);
    expect(drain(patchSpec, frame({ p: 'response/status', v: 'CONTENT_FILTER' }))).toContainEqual({
      kind: 'finish',
      reason: 'CONTENT_FILTER',
    });
  });

  it('emits only the tail that has not been sent yet', () => {
    const framer = createFramer(patchSpec);
    expect(textOf(framer.push(frame({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'abc' } })))).toBe('abc');
    expect(textOf(framer.push(frame({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'def' } })))).toBe('def');
  });

  it('warns loudly when the provider rewrites text it already sent', () => {
    const framer = createFramer(patchSpec);
    framer.push(frame({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'first' } }));
    const events = framer.push(
      frame({ v: { response: { fragments: [{ type: 'RESPONSE', content: 'completely different' }] } } }),
    );
    expect(events.some((e) => e.kind === 'warning' && e.code === 'stream_rewritten')).toBe(true);
    expect(textOf(events)).toBe('completely different');
  });

  it('honours custom field names and routes for a provider that is not DeepSeek', () => {
    const spec: StreamSpec = {
      format: 'json-patch',
      patch: {
        pathField: 'path',
        valueField: 'value',
        opField: 'op',
        typeField: 'type',
        routes: { OUT: 'text', SCRATCH: 'reasoning' },
      },
    };
    const events = drain(
      spec,
      `data: ${JSON.stringify({ path: 'response/fragments', op: 'APPEND', value: { type: 'OUT', content: 'hi' } })}\n\n`,
      `data: ${JSON.stringify({ path: 'response/fragments', op: 'APPEND', value: { type: 'SCRATCH', content: 'why' } })}\n\n`,
    );
    expect(textOf(events)).toBe('hi');
    expect(reasoningOf(events)).toBe('why');
  });

  it('survives a truncated final frame, which is what a dropped connection looks like', () => {
    const framer = createFramer(patchSpec);
    framer.push(frame({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: 'kept' } }));
    framer.push('data: {"p":"response/fragm');
    expect(() => framer.end()).not.toThrow();
    expect(textOf(drain(patchSpec, frame({ p: 'response/content', v: 'x' }), 'data: {"broken'))).toBe('x');
  });

  it('ignores frames that are not objects', () => {
    expect(drain(patchSpec, 'data: null\n\ndata: 42\n\ndata: "text"\n\n')).toEqual([]);
  });
});
