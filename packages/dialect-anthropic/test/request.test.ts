import { describe, expect, it } from 'vitest';
import {
  AnthropicRequestError,
  flattenRequest,
  parseMessagesRequest,
  toUniversal,
  toUniversalTools,
  universalParams,
  wantsThinking,
  type MessagesRequest,
} from '../src/request.js';

/**
 * Reading an Anthropic request.
 *
 * Three of its differences from OpenAI are places a careless port loses information,
 * and each has its own group below: `system` is a field rather than a role, a tool
 * result is a block inside a user turn rather than a message, and `max_tokens` is
 * required.
 */

function request(overrides: Partial<MessagesRequest> = {}): MessagesRequest {
  return parseMessagesRequest({
    model: 'deepseek-chat',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  });
}

describe('parseMessagesRequest', () => {
  it('accepts a minimal request', () => {
    expect(request().model).toBe('deepseek-chat');
  });

  it('says plainly that max_tokens is required', () => {
    // A caller porting from OpenAI hits this first, and "messages.0: Required" would
    // send them looking in the wrong place.
    const failure = refusal(() =>
      parseMessagesRequest({ model: 'a', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(failure.status).toBe(400);
    expect(failure.message).toMatch(/max_tokens is required/);
  });

  it('rejects a max_tokens that is not a positive integer', () => {
    for (const max of [0, -5, 1.5, 'lots']) {
      expect(() => request({ max_tokens: max as number })).toThrow(AnthropicRequestError);
    }
  });

  it('rejects an empty message list', () => {
    expect(() => request({ messages: [] })).toThrow(AnthropicRequestError);
  });

  it('rejects a role the Messages API does not have', () => {
    // There is no `system` role here; it is a top-level field, and accepting one would
    // silently drop it.
    expect(() =>
      parseMessagesRequest({
        model: 'a',
        max_tokens: 1,
        messages: [{ role: 'system', content: 'hi' }],
      }),
    ).toThrow(AnthropicRequestError);
  });

  it('keeps fields it does not act on rather than rejecting them', () => {
    const parsed = request({ metadata: { user_id: 'u1' } } as Partial<MessagesRequest>);
    expect((parsed as Record<string, unknown>)['metadata']).toEqual({ user_id: 'u1' });
  });

  it('accepts every content block kind the API defines', () => {
    expect(() =>
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
              { type: 'tool_result', tool_use_id: 'u1', content: 'done' },
            ],
          },
        ],
      } as Partial<MessagesRequest>),
    ).not.toThrow();
  });
});

describe('toUniversal', () => {
  it('lifts the system field into a system message', () => {
    const universal = toUniversal(request({ system: 'Be terse.' } as Partial<MessagesRequest>));
    expect(universal[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'Be terse.' }] });
  });

  it('accepts a system given as blocks', () => {
    const universal = toUniversal(
      request({ system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } as Partial<MessagesRequest>),
    );
    expect(universal[0]?.content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('lifts a tool result out of its user turn', () => {
    // Anthropic carries results inside a user message. Leaving them there would make
    // the model read its own tool output as something the person said.
    const universal = toUniversal(
      request({
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get', input: { city: 'Berlin' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '18C' }] },
        ],
      } as Partial<MessagesRequest>),
    );

    expect(universal.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(universal[2]?.content).toEqual([{ type: 'tool_result', id: 't1', text: '18C' }]);
  });

  it('splits a user turn that mixes results and typed text, keeping the order', () => {
    const universal = toUniversal(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'done' },
              { type: 'text', text: 'now summarise it' },
            ],
          },
        ],
      } as Partial<MessagesRequest>),
    );

    expect(universal.map((message) => message.role)).toEqual(['tool', 'user']);
    expect(universal[1]?.content).toEqual([{ type: 'text', text: 'now summarise it' }]);
  });

  it('labels a failed tool result as failed', () => {
    // A model told only the text will usually retry the same call, because nothing
    // told it the call failed.
    const universal = toUniversal(
      request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }],
          },
        ],
      } as Partial<MessagesRequest>),
    );
    expect(universal[0]?.content[0]).toMatchObject({ text: '[error] boom' });
  });

  it('renders a tool result given as blocks', () => {
    const universal = toUniversal(
      request({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
              },
            ],
          },
        ],
      } as Partial<MessagesRequest>),
    );
    expect(universal[0]?.content[0]).toMatchObject({ text: 'one\ntwo' });
  });

  it('names an image and its size instead of carrying it', () => {
    // A base64 image is megabytes and the text channel cannot take it. Saying it was
    // attached lets the model say it cannot see it; saying nothing makes it answer as
    // though nothing was attached.
    const universal = toUniversal(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(40) } },
            ],
          },
        ],
      } as Partial<MessagesRequest>),
    );
    expect(universal[0]?.content[0]).toEqual({
      type: 'image',
      url: 'image/png, 40 base64 characters, not sent',
    });
  });

  it('passes a url image through as its url', () => {
    const universal = toUniversal(
      request({
        messages: [
          { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/a.png' } }] },
        ],
      } as Partial<MessagesRequest>),
    );
    expect(universal[0]?.content[0]).toEqual({ type: 'image', url: 'https://x/a.png' });
  });

  it('drops a thinking block the client is replaying', () => {
    // Replaying a previous turn's reasoning as though the model had just produced it
    // changes what it does next, and the provider behind us has its own channel.
    const universal = toUniversal(
      request({
        messages: [
          { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'four' }] },
          { role: 'user', content: 'why?' },
        ],
      } as Partial<MessagesRequest>),
    );
    expect(universal[0]?.content).toEqual([{ type: 'text', text: 'four' }]);
  });

  it('keeps a block it does not recognise, described', () => {
    const universal = toUniversal(
      request({
        messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url' } }] }],
      } as Partial<MessagesRequest>),
    );
    expect(universal[0]?.content[0]).toMatchObject({ type: 'unknown' });
  });

  it('skips a message that holds nothing at all', () => {
    const universal = toUniversal(
      request({ messages: [{ role: 'user', content: '' }, { role: 'user', content: 'real' }] } as Partial<MessagesRequest>),
    );
    expect(universal).toHaveLength(1);
  });
});

describe('flattenRequest', () => {
  it('produces the same prompt shape the OpenAI dialect does', () => {
    // One flattener serves both, which is the point of the universal layer: the model
    // sees the same conversation whichever SDK the caller happened to use.
    const flat = flattenRequest(
      request({
        system: 'Be terse.',
        messages: [
          { role: 'user', content: 'what is 2+2' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'and 3+3' },
        ],
      } as Partial<MessagesRequest>),
    );

    expect(flat.systemPrompt).toBe('Be terse.');
    expect(flat.prompt).toBe('User: what is 2+2\n\nAssistant: 4\n\nUser: and 3+3');
  });

  it('renders a tool call and its result the way the model was taught to read them', () => {
    const flat = flattenRequest(
      request({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Berlin' } }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '18C' }] },
        ],
      } as Partial<MessagesRequest>),
    );

    expect(flat.prompt).toContain('Assistant: TOOL_CALL: get_weather');
    expect(flat.prompt).toContain('arguments: {"city":"Berlin"}');
    expect(flat.prompt).toContain('[Tool Result t1]\n18C');
  });

  it('puts the tool instructions in the system prompt', () => {
    const flat = flattenRequest(
      request({
        tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object' } }],
      } as Partial<MessagesRequest>),
    );
    expect(flat.systemPrompt).toContain('TOOL_CALL: <tool_name>');
    expect(flat.systemPrompt).toContain('get_weather: weather');
  });
});

describe('toUniversalTools', () => {
  it('renames input_schema to the neutral parameters', () => {
    expect(toUniversalTools([{ name: 'f', description: 'd', input_schema: { type: 'object' } }])).toEqual([
      { name: 'f', description: 'd', parameters: { type: 'object' } },
    ]);
  });

  it('is undefined when there are no tools, so nothing is added to the prompt', () => {
    expect(toUniversalTools(undefined)).toBeUndefined();
    expect(toUniversalTools([])).toBeUndefined();
  });
});

describe('universalParams and wantsThinking', () => {
  it('carries max_tokens, which this API always has', () => {
    expect(universalParams(request())).toEqual({ maxTokens: 1024 });
  });

  it('canonicalises the knobs a declaration maps from', () => {
    expect(
      universalParams(
        request({
          temperature: 0.5,
          top_p: 0.9,
          top_k: 40,
          stop_sequences: ['END'],
        } as Partial<MessagesRequest>),
      ),
    ).toEqual({ maxTokens: 1024, temperature: 0.5, topP: 0.9, topK: 40, stop: ['END'] });
  });

  it('reads the thinking switch', () => {
    expect(wantsThinking(request())).toBe(false);
    expect(
      wantsThinking(request({ thinking: { type: 'enabled', budget_tokens: 1024 } } as Partial<MessagesRequest>)),
    ).toBe(true);
    expect(wantsThinking(request({ thinking: { type: 'disabled' } } as Partial<MessagesRequest>))).toBe(
      false,
    );
  });
});

function refusal(fn: () => unknown): AnthropicRequestError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AnthropicRequestError) return error;
    throw error;
  }
  throw new Error('expected the request to be refused, and it was accepted');
}
