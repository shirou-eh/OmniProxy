import type { OmniError, UMSEvent } from '@omniproxy/schema';
import { describe, expect, it } from 'vitest';
import {
  flattenRequest,
  isChatRequest,
  OllamaRequestError,
  parseChatRequest,
  parseGenerateRequest,
  toUniversal,
  toUniversalTools,
  universalParams,
  wantsStream,
} from '../src/request.js';
import {
  approxTokens,
  buildOllamaResponse,
  ollamaDoneReason,
  toOllamaError,
  toOllamaStream,
  type OllamaOptions,
  type OllamaRecord,
} from '../src/response.js';

/**
 * The Ollama dialect.
 *
 * Two of its habits are the opposite of every other protocol here, and both have their
 * own group below because getting either wrong is a silent break rather than an error:
 * `stream` defaults to true, and the wire format is NDJSON rather than SSE.
 */

const identity = { model: 'deepseek-chat', createdAt: '2026-08-27T12:00:00.000Z' };

const collected = (overrides: Record<string, unknown> = {}) => ({
  text: 'Hello.',
  reasoning: '',
  finishReason: 'stop' as const,
  warnings: [] as { code: string; message: string }[],
  ...overrides,
});

const options = (overrides: Partial<OllamaOptions> = {}): OllamaOptions => ({
  toolsOffered: false,
  endpoint: 'chat',
  ...overrides,
});

async function* stream(...events: UMSEvent[]): AsyncGenerator<UMSEvent> {
  for (const event of events) yield event;
}

async function records(generator: AsyncGenerator<string>): Promise<OllamaRecord[]> {
  const lines: string[] = [];
  for await (const chunk of generator) lines.push(chunk);

  // Parsed the way a client parses it: split on newlines, one object per line.
  const joined = lines.join('');
  return joined
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as OllamaRecord);
}

/* ────────────────────────────── the two habits ────────────────────────────── */

describe('streaming defaults to on, unlike everyone else', () => {
  it('streams when the field is missing', () => {
    // A client that omits it is asking for a stream, because that is the default it
    // was written against. Copying another dialect's default breaks all of them.
    expect(wantsStream(parseChatRequest(chat()))).toBe(true);
  });

  it('streams when it is explicitly true, and does not when false', () => {
    expect(wantsStream(parseChatRequest({ ...chat(), stream: true }))).toBe(true);
    expect(wantsStream(parseChatRequest({ ...chat(), stream: false }))).toBe(false);
  });
});

describe('the stream is NDJSON', () => {
  it('writes one JSON object per line, with no data: prefix', async () => {
    const chunks: string[] = [];
    for await (const chunk of toOllamaStream(
      stream({ type: 'text.delta', text: 'a' }, { type: 'done', finishReason: 'stop' }),
      identity,
      options(),
    )) {
      chunks.push(chunk);
    }

    for (const chunk of chunks) {
      expect(chunk.startsWith('data: ')).toBe(false);
      expect(chunk.endsWith('\n')).toBe(true);
      // Exactly one newline: a record spread over several lines is a parse error on
      // every one of them.
      expect(chunk.split('\n')).toHaveLength(2);
      expect(() => JSON.parse(chunk)).not.toThrow();
    }
  });

  it('always ends with a done record, so a client stops reading', async () => {
    const parsed = await records(
      toOllamaStream(
        stream({ type: 'text.delta', text: 'hi' }, { type: 'done', finishReason: 'stop' }),
        identity,
        options(),
      ),
    );
    expect(parsed.slice(0, -1).every((record) => record.done === false)).toBe(true);
    expect(parsed.at(-1)?.done).toBe(true);
    expect(parsed.at(-1)?.done_reason).toBe('stop');
  });

  it('ends a failed stream with a done record too, not with a closed socket', async () => {
    // A client waiting for `done` waits forever otherwise.
    const failure: OmniError = {
      code: 'quota_exhausted',
      message: 'out of messages',
      userAction: 'Add another account.',
      retryable: 'other-account',
    };
    const parsed = await records(
      toOllamaStream(
        stream({ type: 'text.delta', text: 'partial' }, { type: 'error', error: failure }),
        identity,
        options(),
      ),
    );

    const last = parsed.at(-1) as OllamaRecord & { error?: string; action?: string };
    expect(last.done).toBe(true);
    expect(last.done_reason).toBe('error');
    expect(last.error).toBe('out of messages');
    expect(last.action).toBe('Add another account.');
  });
});

/* ────────────────────────────── reading a request ────────────────────────────── */

function chat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

describe('parseChatRequest and parseGenerateRequest', () => {
  it('accepts a minimal chat request', () => {
    expect(parseChatRequest(chat()).model).toBe('deepseek-chat');
  });

  it('accepts a minimal generate request', () => {
    const request = parseGenerateRequest({ model: 'm', prompt: 'hi' });
    expect(isChatRequest(request)).toBe(false);
  });

  it('rejects a request with no model', () => {
    expect(() => parseChatRequest({ messages: [] })).toThrow(OllamaRequestError);
    expect(() => parseGenerateRequest({ prompt: 'hi' })).toThrow(OllamaRequestError);
  });

  it('rejects an empty message list', () => {
    expect(() => parseChatRequest(chat({ messages: [] }))).toThrow(OllamaRequestError);
  });

  it('keeps fields it does not act on', () => {
    expect(parseChatRequest(chat({ keep_alive: '5m' })).keep_alive).toBe('5m');
  });
});

describe('toUniversal', () => {
  it('reads a chat conversation', () => {
    const universal = toUniversal(
      parseChatRequest(
        chat({
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
          ],
        }),
      ),
    );
    expect(universal.map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('reads a generate request, system field and all', () => {
    const universal = toUniversal(
      parseGenerateRequest({ model: 'm', prompt: 'go', system: 'Be terse.' }),
    );
    expect(universal.map((message) => message.role)).toEqual(['system', 'user']);
    expect(universal[1]?.content).toEqual([{ type: 'text', text: 'go' }]);
  });

  it('reads tool calls whose arguments came as an object', () => {
    // Ollama carries arguments structured, where OpenAI carries a string.
    const universal = toUniversal(
      parseChatRequest(
        chat({
          messages: [
            { role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: { a: 1 } } }] },
          ],
        }),
      ),
    );
    expect(universal[0]?.content[0]).toEqual({ type: 'tool_call', name: 'f', args: '{"a":1}' });
  });

  it('names an image and its size instead of carrying it', () => {
    const universal = toUniversal(
      parseChatRequest(chat({ messages: [{ role: 'user', content: 'look', images: ['x'.repeat(20)] }] })),
    );
    expect(universal[0]?.content[1]).toEqual({
      type: 'image',
      url: '20 base64 characters, not sent',
    });
  });

  it('reads a tool-result message', () => {
    const universal = toUniversal(
      parseChatRequest(chat({ messages: [{ role: 'tool', content: '18C' }] })),
    );
    expect(universal[0]?.role).toBe('tool');
  });

  it('skips a message with nothing in it', () => {
    const universal = toUniversal(
      parseChatRequest(chat({ messages: [{ role: 'user', content: '' }, { role: 'user', content: 'real' }] })),
    );
    expect(universal).toHaveLength(1);
  });
});

describe('universalParams', () => {
  it('lifts the knobs out of the options block', () => {
    expect(
      universalParams(
        parseChatRequest(
          chat({ options: { temperature: 0.4, top_p: 0.9, top_k: 30, num_predict: 256, stop: 'END' } }),
        ),
      ),
    ).toEqual({ temperature: 0.4, topP: 0.9, topK: 30, maxTokens: 256, stop: ['END'] });
  });

  it('treats num_predict: -1 as no budget rather than as a budget of -1', () => {
    expect(universalParams(parseChatRequest(chat({ options: { num_predict: -1 } })))).toEqual({});
  });

  it('is empty when there is no options block', () => {
    expect(universalParams(parseChatRequest(chat()))).toEqual({});
  });
});

describe('flattenRequest', () => {
  it('produces the shape the model was taught to read', () => {
    const flat = flattenRequest(
      parseChatRequest(
        chat({
          messages: [
            { role: 'system', content: 'Be terse.' },
            { role: 'user', content: 'what is 2+2' },
            { role: 'assistant', content: '4' },
          ],
        }),
      ),
    );
    expect(flat.systemPrompt).toBe('Be terse.');
    expect(flat.prompt).toBe('User: what is 2+2\n\nAssistant: 4');
  });
});

describe('toUniversalTools', () => {
  it('reads the OpenAI-shaped declarations Ollama borrowed', () => {
    expect(
      toUniversalTools([{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }]),
    ).toEqual([{ name: 'f', description: 'd', parameters: {} }]);
  });

  it('is undefined when there is nothing declared', () => {
    expect(toUniversalTools([])).toBeUndefined();
    expect(toUniversalTools(undefined)).toBeUndefined();
  });
});

/* ────────────────────────────── writing a response ────────────────────────────── */

describe('buildOllamaResponse', () => {
  it('puts the answer under message for /api/chat', () => {
    const record = buildOllamaResponse(identity, collected(), options());
    expect(record.message).toEqual({ role: 'assistant', content: 'Hello.' });
    expect(record.response).toBeUndefined();
    expect(record.done).toBe(true);
  });

  it('puts it under response for /api/generate', () => {
    // The older endpoint has no message envelope, and a lot of scripts still use it.
    const record = buildOllamaResponse(identity, collected(), options({ endpoint: 'generate' }));
    expect(record.response).toBe('Hello.');
    expect(record.message).toBeUndefined();
  });

  it('reports durations clients divide by, never zero', () => {
    // A missing field there produces NaN in somebody's progress display, and a zero
    // produces Infinity.
    const record = buildOllamaResponse(identity, collected(), options());
    for (const field of ['total_duration', 'load_duration', 'eval_duration'] as const) {
      expect(record[field], field).toBeGreaterThan(0);
    }
  });

  it('reports estimated token counts', () => {
    const record = buildOllamaResponse(
      identity,
      collected({ text: 'x'.repeat(40) }),
      options({ promptChars: 80 }),
    );
    expect(record.prompt_eval_count).toBe(20);
    expect(record.eval_count).toBe(10);
  });

  it('prefers real counts when the provider reported them', () => {
    const record = buildOllamaResponse(
      identity,
      collected({ usage: { promptTokens: 3, completionTokens: 4, estimated: false } }),
      options({ promptChars: 400 }),
    );
    expect(record.prompt_eval_count).toBe(3);
    expect(record.eval_count).toBe(4);
  });

  it('returns a tool call in Ollama shape, with arguments as an object', () => {
    const record = buildOllamaResponse(
      identity,
      collected({ text: 'TOOL_CALL: get_weather\narguments: {"city":"Berlin"}' }),
      options({ toolsOffered: true }),
    );
    expect(record.message?.tool_calls?.[0]).toEqual({
      function: { name: 'get_weather', arguments: { city: 'Berlin' } },
    });
    // Empty rather than the raw markup: a client rendering content would show a user
    // the model's tool syntax, and one parsing it would see the call twice.
    expect(record.message?.content).toBe('');
  });

  it('does not try to return a tool call from /api/generate', () => {
    // That endpoint has no place to put one, so the text is returned as it came.
    const record = buildOllamaResponse(
      identity,
      collected({ text: 'TOOL_CALL: f\narguments: {}' }),
      options({ toolsOffered: true, endpoint: 'generate' }),
    );
    expect(record.response).toContain('TOOL_CALL');
  });

  it('carries thinking when it was asked for', () => {
    const record = buildOllamaResponse(
      identity,
      collected({ reasoning: 'думаю' }),
      options({ includeThinking: true }),
    );
    expect(record.message?.thinking).toBe('думаю');
  });

  it('surfaces a warning without disturbing the schema', () => {
    const record = buildOllamaResponse(
      identity,
      collected({ warnings: [{ code: 'w', message: 'something' }] }),
      options(),
    );
    expect(record.omniproxy?.warnings).toHaveLength(1);
    expect(record.message?.content).toBe('Hello.');
  });
});

describe('toOllamaStream', () => {
  it('sends fragments then a final record', async () => {
    const parsed = await records(
      toOllamaStream(
        stream(
          { type: 'text.delta', text: 'Hel' },
          { type: 'text.delta', text: 'lo.' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        options(),
      ),
    );

    const text = parsed.map((record) => record.message?.content ?? '').join('');
    expect(text).toBe('Hello.');
    expect(parsed.at(-1)?.done).toBe(true);
  });

  it('uses response fragments on the generate endpoint', async () => {
    const parsed = await records(
      toOllamaStream(
        stream({ type: 'text.delta', text: 'hi' }, { type: 'done', finishReason: 'stop' }),
        identity,
        options({ endpoint: 'generate' }),
      ),
    );
    expect(parsed[0]?.response).toBe('hi');
    expect(parsed[0]?.message).toBeUndefined();
  });

  it('holds text back when tools were offered', async () => {
    const parsed = await records(
      toOllamaStream(
        stream(
          { type: 'text.delta', text: 'Hel' },
          { type: 'text.delta', text: 'lo.' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        options({ toolsOffered: true }),
      ),
    );
    const fragments = parsed.filter((record) => !record.done);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.message?.content).toBe('Hello.');
  });

  it('emits a tool call as one complete record', async () => {
    const parsed = await records(
      toOllamaStream(
        stream(
          { type: 'text.delta', text: 'TOOL_CALL: f\narguments: {"a":1}' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        options({ toolsOffered: true }),
      ),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.done).toBe(true);
    expect(parsed[0]?.message?.tool_calls?.[0]?.function.name).toBe('f');
  });

  it('sends a done record even when nothing arrived', async () => {
    const parsed = await records(
      toOllamaStream(stream({ type: 'done', finishReason: 'stop' }), identity, options()),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.done).toBe(true);
  });
});

/* ──────────────────────────────── errors ──────────────────────────────── */

describe('toOllamaError', () => {
  const error = (overrides: Partial<OmniError>): OmniError => ({
    code: 'internal',
    message: 'boom',
    userAction: 'do something',
    retryable: 'no',
    ...overrides,
  });

  it("puts the message under `error`, which is Ollama's whole contract", () => {
    const shaped = toOllamaError(error({ message: 'out of messages' }));
    expect(shaped.error).toBe('out of messages');
  });

  it('keeps the action and the code as additions', () => {
    // Ollama has nowhere for them, and a caller left with only a sentence has nothing
    // to act on (I-2).
    const shaped = toOllamaError(error({ code: 'quota_exhausted', userAction: 'Add an account.' }));
    expect(shaped.action).toBe('Add an account.');
    expect(shaped.code).toBe('quota_exhausted');
  });

  it('maps codes onto statuses', () => {
    expect(toOllamaError(error({ code: 'auth_expired' })).status).toBe(401);
    expect(toOllamaError(error({ code: 'rate_limit' })).status).toBe(429);
    expect(toOllamaError(error({ code: 'endpoint_gone' })).status).toBe(502);
  });
});

describe('ollamaDoneReason', () => {
  it('translates every finish reason', () => {
    expect(ollamaDoneReason('stop')).toBe('stop');
    expect(ollamaDoneReason('length')).toBe('length');
    // No separate reason: the tool_calls array is how a client knows.
    expect(ollamaDoneReason('tool_calls')).toBe('stop');
    expect(ollamaDoneReason('error')).toBe('error');
  });
});

describe('approxTokens', () => {
  it('estimates and never goes negative', () => {
    expect(approxTokens(40)).toBe(10);
    expect(approxTokens(0)).toBe(0);
    expect(approxTokens(-10)).toBe(0);
  });
});
