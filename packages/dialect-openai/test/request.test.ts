import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compactSchema,
  flattenMessages,
  formatToolDefinitions,
  normalizeContent,
  OpenAiRequestError,
  parseChatCompletionRequest,
  type ChatMessage,
  type ChatTool,
} from '../src/request.js';

const require = createRequire(import.meta.url);
const legacy = require(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../legacy/server.js'),
).__test as {
  formatMessages(messages: unknown[], tools?: unknown[]): { prompt: string; systemPrompt: string };
};

describe('parseChatCompletionRequest', () => {
  const minimal = { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] };

  it('accepts a minimal request', () => {
    expect(parseChatCompletionRequest(minimal).model).toBe('deepseek-chat');
  });

  it('keeps fields it does not act on rather than rejecting them', () => {
    // A gateway that 400s a request it could have served is worse than useless: the
    // caller's code already works against the real API.
    const parsed = parseChatCompletionRequest({ ...minimal, seed: 7, logit_bias: { a: 1 } });
    expect((parsed as Record<string, unknown>)['seed']).toBe(7);
  });

  it('names the field when the request is malformed', () => {
    const error = capture(() => parseChatCompletionRequest({ messages: [] }));
    expect(error.status).toBe(400);
    expect(error.type).toBe('invalid_request_error');
    expect(error.message).toMatch(/model|messages/);
  });

  it('rejects an empty message list', () => {
    expect(() => parseChatCompletionRequest({ model: 'a', messages: [] })).toThrow(
      OpenAiRequestError,
    );
  });

  it('refuses n > 1 rather than quietly returning one completion', () => {
    // Half-support is what makes a caller's retry logic subtly wrong.
    const error = capture(() => parseChatCompletionRequest({ ...minimal, n: 3 }));
    expect(error.param).toBe('n');
    expect(error.message).toMatch(/one completion per request/);
    expect(parseChatCompletionRequest({ ...minimal, n: 1 }).n).toBe(1);
  });

  it('accepts every role a client may send', () => {
    const roles = ['system', 'developer', 'user', 'assistant', 'tool'] as const;
    for (const role of roles) {
      expect(() =>
        parseChatCompletionRequest({ model: 'a', messages: [{ role, content: 'x' }] }),
      ).not.toThrow();
    }
  });

  it('accepts structured content parts', () => {
    expect(() =>
      parseChatCompletionRequest({
        model: 'a',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image_url', image_url: { url: 'https://x.test/a.png' } },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts a null content, which assistant tool-call turns use', () => {
    expect(() =>
      parseChatCompletionRequest({
        model: 'a',
        messages: [
          { role: 'assistant', content: null, tool_calls: [{ function: { name: 'f', arguments: '{}' } }] },
        ],
      }),
    ).not.toThrow();
  });
});

describe('flattenMessages, against the legacy formatter', () => {
  /**
   * The exact shape of this prompt is behaviour, not formatting. The role labels, the
   * blank lines and the `[Tool Result]` marker are what the model has been observed to
   * follow; tidying them would change the answers, so parity is checked rather than
   * assumed (risk R-15).
   */
  const conversations: Record<string, ChatMessage[]> = {
    'one user turn': [{ role: 'user', content: 'hello' }],

    'a system prompt and a turn': [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hello' },
    ],

    'a full back and forth': [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'what is 2+2' },
      { role: 'assistant', content: '4' },
      { role: 'user', content: 'and 3+3' },
    ],

    'an assistant tool-call turn and its result': [
      { role: 'user', content: 'weather in Berlin' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"temp":18}' },
      { role: 'user', content: 'thanks' },
    ],

    'structured content parts': [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: 'https://x.test/a.png' } },
        ],
      },
    ],

    'several system messages': [
      { role: 'system', content: 'first rule' },
      { role: 'system', content: 'second rule' },
      { role: 'user', content: 'go' },
    ],

    'an empty assistant message': [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'still there?' },
    ],
  };

  for (const [name, messages] of Object.entries(conversations)) {
    it(name, () => {
      expect(flattenMessages(messages)).toEqual(legacy.formatMessages(messages));
    });
  }

  it('treats developer as system, which legacy never saw', () => {
    // OpenAI's newer name for the same role. Legacy predates it, so there is nothing
    // to be in parity with — the behaviour is asserted directly instead.
    const flat = flattenMessages([
      { role: 'developer', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
    ]);
    expect(flat.systemPrompt).toBe('Be terse.');
    expect(flat.prompt).toBe('User: hi');
  });

  it('reads a function-role message like a tool result', () => {
    const flat = flattenMessages([
      { role: 'user', content: 'go' },
      { role: 'function', name: 'f', content: 'result' },
    ]);
    expect(flat.prompt).toContain('[Tool Result]\nresult');
  });
});

describe('normalizeContent', () => {
  it('passes a plain string through', () => {
    expect(normalizeContent('hello')).toBe('hello');
  });

  it('joins text parts with newlines', () => {
    expect(
      normalizeContent([
        { type: 'text', text: 'a' },
        { type: 'output_text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });

  it('names an image rather than dropping it', () => {
    // A model that cannot see the image can at least say so, which is a much better
    // failure than answering as if nothing was attached.
    expect(normalizeContent([{ type: 'image_url', image_url: { url: 'https://x/a.png' } }])).toBe(
      '[Image: https://x/a.png]',
    );
  });

  it('renders an Anthropic-style tool result', () => {
    expect(
      normalizeContent([{ type: 'tool_result', tool_use_id: 'u1', content: 'done' }]),
    ).toBe('[Tool Result u1]\ndone');
  });

  it('falls back to JSON for a part it does not know', () => {
    expect(normalizeContent([{ type: 'mystery', payload: 1 }])).toBe('{"type":"mystery","payload":1}');
  });

  it('handles null, undefined and numbers', () => {
    expect(normalizeContent(null)).toBe('');
    expect(normalizeContent(undefined)).toBe('');
    expect(normalizeContent(42)).toBe('42');
  });
});

describe('formatToolDefinitions', () => {
  const tools: ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Current weather for a city',
        parameters: {
          $schema: 'https://json-schema.org/draft-07/schema',
          type: 'object',
          additionalProperties: false,
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    },
  ];

  it('describes the format the prompt asks the model to use', () => {
    const text = formatToolDefinitions(tools);
    expect(text).toContain('TOOL_CALL: <tool_name>');
    expect(text).toContain('get_weather: Current weather for a city');
    expect(text).toMatch(/one tool at a time/);
  });

  it('emits nothing when there are no tools', () => {
    expect(formatToolDefinitions([])).toBe('');
  });

  it('drops schema noise the model cannot use', () => {
    // Full schemas from real toolchains run to thousands of characters each, and a
    // dozen of them will not fit alongside the conversation.
    const text = formatToolDefinitions(tools);
    expect(text).not.toContain('$schema');
    expect(text).not.toContain('additionalProperties');
    expect(text).toContain('"required":["city"]');
  });
});

describe('compactSchema', () => {
  it('keeps the fields a model needs to fill a schema in', () => {
    expect(
      compactSchema({
        type: 'object',
        $schema: 'x',
        additionalProperties: false,
        examples: [{ a: 1 }],
        required: ['a'],
        properties: { a: { type: 'string', description: 'the a', title: 'A' } },
      }),
    ).toEqual({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string', description: 'the a' } },
    });
  });

  it('truncates a description nobody will read in full', () => {
    const long = compactSchema({ type: 'string', description: 'x'.repeat(500) }) as {
      description: string;
    };
    expect(long.description.length).toBeLessThan(210);
    expect(long.description.endsWith('…')).toBe(true);
  });

  it('stops descending at a depth no real schema needs', () => {
    let deep: unknown = { type: 'string' };
    for (let level = 0; level < 10; level += 1) deep = { type: 'object', properties: { x: deep } };
    expect(() => compactSchema(deep)).not.toThrow();
  });

  it('passes primitives and arrays through', () => {
    expect(compactSchema('text')).toBe('text');
    expect(compactSchema(null)).toBe(null);
    expect(compactSchema([{ type: 'string', $schema: 'x' }])).toEqual([{ type: 'string' }]);
  });
});

function capture(fn: () => unknown): OpenAiRequestError {
  try {
    fn();
  } catch (error) {
    if (error instanceof OpenAiRequestError) return error;
    throw error;
  }
  throw new Error('expected the request to be rejected, and it was accepted');
}
