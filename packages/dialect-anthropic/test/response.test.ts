import type { OmniError, UMSEvent } from '@omniproxy/schema';
import { describe, expect, it } from 'vitest';
import {
  anthropicStop,
  buildMessageResponse,
  estimateUsage,
  toAnthropicError,
  toAnthropicStream,
  type MessageOptions,
} from '../src/response.js';

/**
 * Writing an Anthropic response.
 *
 * Anthropic's stream is more structured than OpenAI's: content arrives as numbered
 * blocks that are opened, filled and closed, and the stop reason arrives in its own
 * event. Clients index into those blocks and wait for those events, so most of what
 * follows checks the sequence rather than the text — a stream that carries the right
 * words in the wrong envelope hangs a client just as thoroughly as one that carries
 * nothing.
 */

const identity = { id: 'msg_0123456789abcdef01234567', model: 'deepseek-chat' };

const collected = (overrides: Partial<Parameters<typeof buildMessageResponse>[1]> = {}) => ({
  text: 'Hello.',
  reasoning: '',
  finishReason: 'stop' as const,
  warnings: [] as { code: string; message: string }[],
  ...overrides,
});

const options = (overrides: Partial<MessageOptions> = {}): MessageOptions => ({
  toolsOffered: false,
  ...overrides,
});

async function* stream(...events: UMSEvent[]): AsyncGenerator<UMSEvent> {
  for (const event of events) yield event;
}

/** Parses an SSE stream into `[eventName, payload]` pairs. */
async function frames(
  generator: AsyncGenerator<string>,
): Promise<[string, Record<string, unknown>][]> {
  const parsed: [string, Record<string, unknown>][] = [];
  for await (const frame of generator) {
    const name = /^event: (.+)$/m.exec(frame)?.[1];
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (name && data) parsed.push([name, JSON.parse(data) as Record<string, unknown>]);
  }
  return parsed;
}

const names = (parsed: [string, unknown][]): string[] => parsed.map(([name]) => name);

/* ────────────────────────────── non-streaming ────────────────────────────── */

describe('buildMessageResponse', () => {
  it('builds the message clients expect', () => {
    const message = buildMessageResponse(identity, collected(), options(), 40);

    expect(message.type).toBe('message');
    expect(message.role).toBe('assistant');
    expect(message.model).toBe('deepseek-chat');
    expect(message.content).toEqual([{ type: 'text', text: 'Hello.' }]);
    expect(message.stop_reason).toBe('end_turn');
    expect(message.stop_sequence).toBe(null);
    expect(message.usage.input_tokens).toBeGreaterThan(0);
  });

  it('never returns an empty content array', () => {
    // The Messages API always carries at least one block, and clients index
    // `content[0]` without checking.
    const message = buildMessageResponse(identity, collected({ text: '' }), options(), 0);
    expect(message.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('puts thinking before the answer, and only when it was asked for', () => {
    const withThinking = buildMessageResponse(
      identity,
      collected({ reasoning: 'Считаю…' }),
      options({ includeThinking: true }),
      0,
    );
    expect(withThinking.content[0]).toEqual({ type: 'thinking', thinking: 'Считаю…' });
    expect(withThinking.content[1]).toEqual({ type: 'text', text: 'Hello.' });

    const without = buildMessageResponse(identity, collected({ reasoning: 'Считаю…' }), options(), 0);
    expect(without.content).toEqual([{ type: 'text', text: 'Hello.' }]);
  });

  it('reads a tool call out of the text and carries input as an object', () => {
    // This is where the two dialects genuinely differ: a client that receives a string
    // here throws while parsing its own response.
    const message = buildMessageResponse(
      identity,
      collected({ text: 'TOOL_CALL: get_weather\narguments: {"city":"Berlin"}' }),
      options({ toolsOffered: true }),
      0,
    );

    expect(message.stop_reason).toBe('tool_use');
    expect(message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'get_weather',
      input: { city: 'Berlin' },
    });
  });

  it('leaves the text alone when no tools were offered', () => {
    const message = buildMessageResponse(
      identity,
      collected({ text: 'TOOL_CALL: x\narguments: {}' }),
      options(),
      0,
    );
    expect(message.content[0]).toMatchObject({ type: 'text' });
    expect(message.stop_reason).toBe('end_turn');
  });

  it('keeps unparseable arguments rather than dropping them', () => {
    const message = buildMessageResponse(
      identity,
      collected({ text: 'TOOL_CALL: f\narguments: {not json' }),
      options({ toolsOffered: true }),
      0,
    );
    // Either it was not read as a call at all, or its raw text survived. Both are
    // honest; silently inventing `{}` would not be.
    const block = message.content[0];
    if (block?.type === 'tool_use') expect(JSON.stringify(block.input)).toContain('not json');
    else expect(block).toMatchObject({ type: 'text' });
  });

  it('does not attach thinking to a tool-call turn', () => {
    // Several agent clients treat any text payload as a final answer and stop looping.
    const message = buildMessageResponse(
      identity,
      collected({ text: 'TOOL_CALL: f\narguments: {}', reasoning: 'thought' }),
      options({ toolsOffered: true, includeThinking: true }),
      0,
    );
    expect(message.content.some((block) => block.type === 'thinking')).toBe(false);
  });

  it('surfaces a warning without disturbing the schema', () => {
    const message = buildMessageResponse(
      identity,
      collected({ warnings: [{ code: 'w', message: 'something' }] }),
      options(),
      0,
    );
    expect(message.omniproxy?.warnings).toEqual([{ code: 'w', message: 'something' }]);
    expect(message.content).toEqual([{ type: 'text', text: 'Hello.' }]);
  });

  it('derives the same tool id for the same message id', () => {
    // A retried request that produces the same call produces the same id, so a client
    // keyed on it does not accumulate duplicates.
    const build = () =>
      buildMessageResponse(
        identity,
        collected({ text: 'TOOL_CALL: f\narguments: {}' }),
        options({ toolsOffered: true }),
        0,
      );
    expect(build().content[0]).toEqual(build().content[0]);
  });
});

/* ──────────────────────────────── streaming ──────────────────────────────── */

describe('toAnthropicStream', () => {
  it('emits the whole event sequence in order', async () => {
    const parsed = await frames(
      toAnthropicStream(
        stream(
          { type: 'start', provider: 'p', channel: 'web', model: 'm' },
          { type: 'text.delta', text: 'Hel' },
          { type: 'text.delta', text: 'lo.' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: false },
      ),
    );

    expect(names(parsed)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const text = parsed
      .filter(([name]) => name === 'content_block_delta')
      .map(([, payload]) => (payload['delta'] as { text: string }).text)
      .join('');
    expect(text).toBe('Hello.');
  });

  it('closes every block it opens', async () => {
    // A client that never receives `content_block_stop` waits forever.
    const parsed = await frames(
      toAnthropicStream(
        stream(
          { type: 'reasoning.delta', text: 'думаю' },
          { type: 'text.delta', text: 'ответ' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: false, includeThinking: true },
      ),
    );

    const starts = parsed.filter(([name]) => name === 'content_block_start');
    const stops = parsed.filter(([name]) => name === 'content_block_stop');
    expect(starts).toHaveLength(2);
    expect(stops).toHaveLength(2);
    expect(starts.map(([, payload]) => payload['index'])).toEqual([0, 1]);
    expect(stops.map(([, payload]) => payload['index'])).toEqual([0, 1]);
  });

  it('numbers blocks from zero without gaps', async () => {
    const parsed = await frames(
      toAnthropicStream(
        stream(
          { type: 'reasoning.delta', text: 'a' },
          { type: 'text.delta', text: 'b' },
          { type: 'reasoning.delta', text: 'c' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: false, includeThinking: true },
      ),
    );
    const indexes = parsed
      .filter(([name]) => name === 'content_block_start')
      .map(([, payload]) => payload['index']);
    expect(indexes).toEqual([0, 1, 2]);
  });

  it('emits one text block even when nothing arrives', async () => {
    // A message with no content block is one every client mis-parses.
    const parsed = await frames(
      toAnthropicStream(stream({ type: 'done', finishReason: 'stop' }), identity, {
        toolsOffered: false,
      }),
    );
    expect(names(parsed)).toContain('content_block_start');
    expect(names(parsed).at(-1)).toBe('message_stop');
  });

  it('drops thinking deltas when thinking was not asked for', async () => {
    const parsed = await frames(
      toAnthropicStream(
        stream({ type: 'reasoning.delta', text: 'secret' }, { type: 'done', finishReason: 'stop' }),
        identity,
        { toolsOffered: false },
      ),
    );
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('holds text back when tools were offered, then emits it as one block', async () => {
    // Once a delta has gone out it cannot be taken back, and half a TOOL_CALL marker is
    // something no client can act on.
    const parsed = await frames(
      toAnthropicStream(
        stream(
          { type: 'text.delta', text: 'Hel' },
          { type: 'text.delta', text: 'lo.' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: true },
      ),
    );

    const deltas = parsed.filter(([name]) => name === 'content_block_delta');
    expect(deltas).toHaveLength(1);
    expect((deltas[0]?.[1]['delta'] as { text: string }).text).toBe('Hello.');
  });

  it('turns a recognised tool call into a tool_use block', async () => {
    const parsed = await frames(
      toAnthropicStream(
        stream(
          { type: 'text.delta', text: 'TOOL_CALL: get_weather\narguments: {"city":"Berlin"}' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: true },
      ),
    );

    const start = parsed.find(([name]) => name === 'content_block_start');
    expect(start?.[1]['content_block']).toMatchObject({ type: 'tool_use', name: 'get_weather' });

    const delta = parsed.find(([name]) => name === 'content_block_delta');
    expect(delta?.[1]['delta']).toMatchObject({ type: 'input_json_delta' });
    expect((delta?.[1]['delta'] as { partial_json: string }).partial_json).toContain('Berlin');

    const finish = parsed.find(([name]) => name === 'message_delta');
    expect((finish?.[1]['delta'] as { stop_reason: string }).stop_reason).toBe('tool_use');
  });

  it('carries a mid-stream failure as an error event', async () => {
    // The status is already 200 and cannot be taken back, so the failure travels in
    // the stream rather than as a truncated response.
    const failure: OmniError = {
      code: 'quota_exhausted',
      message: 'out of messages',
      userAction: 'Add another account.',
      retryable: 'other-account',
    };
    const parsed = await frames(
      toAnthropicStream(
        stream({ type: 'text.delta', text: 'partial' }, { type: 'error', error: failure }),
        identity,
        { toolsOffered: false },
      ),
    );

    expect(names(parsed)).toContain('error');
    const error = parsed.find(([name]) => name === 'error')?.[1]['error'] as Record<string, unknown>;
    expect(error['type']).toBe('rate_limit_error');
    expect(error['action']).toBe('Add another account.');
    // And the block it had opened was closed before the error.
    expect(names(parsed).indexOf('content_block_stop')).toBeLessThan(names(parsed).indexOf('error'));
  });

  it('reports the finish reason and the output count at the end', async () => {
    const parsed = await frames(
      toAnthropicStream(
        stream({ type: 'text.delta', text: 'x'.repeat(40) }, { type: 'done', finishReason: 'length' }),
        identity,
        { toolsOffered: false, promptChars: 100 },
      ),
    );

    const delta = parsed.find(([name]) => name === 'message_delta')?.[1];
    expect((delta?.['delta'] as { stop_reason: string }).stop_reason).toBe('max_tokens');
    expect((delta?.['usage'] as { output_tokens: number }).output_tokens).toBe(10);
  });

  it('names each event on its own line, as clients dispatch on it', async () => {
    // Sending only `data:` parses and then silently does nothing.
    const first = await toAnthropicStream(
      stream({ type: 'done', finishReason: 'stop' }),
      identity,
      { toolsOffered: false },
    ).next();
    expect(first.value).toMatch(/^event: message_start\ndata: \{/);
    expect(first.value).toMatch(/\n\n$/);
  });
});

/* ──────────────────────────────── errors ──────────────────────────────── */

describe('toAnthropicError', () => {
  const error = (overrides: Partial<OmniError>): OmniError => ({
    code: 'internal',
    message: 'boom',
    userAction: 'do something',
    retryable: 'no',
    ...overrides,
  });

  it('maps codes onto the statuses and types clients branch on', () => {
    const cases: [OmniError['code'], number, string][] = [
      ['auth_expired', 401, 'authentication_error'],
      ['auth_missing', 401, 'authentication_error'],
      ['challenge', 403, 'permission_error'],
      ['rate_limit', 429, 'rate_limit_error'],
      ['quota_exhausted', 429, 'rate_limit_error'],
      ['invalid_request', 400, 'invalid_request_error'],
      ['timeout', 504, 'api_error'],
      ['internal', 500, 'api_error'],
    ];
    for (const [code, status, type] of cases) {
      const shaped = toAnthropicError(error({ code }));
      expect([code, shaped.status, shaped.error.type]).toEqual([code, status, type]);
    }
  });

  it('uses overloaded_error for an unreachable provider, which clients back off on', () => {
    const shaped = toAnthropicError(error({ code: 'upstream_unavailable' }));
    expect(shaped.status).toBe(529);
    expect(shaped.error.type).toBe('overloaded_error');
  });

  it('keeps the action, which is what the person is supposed to do (I-2)', () => {
    const shaped = toAnthropicError(error({ userAction: 'Run omniproxy auth add.' }));
    expect(shaped.error.action).toBe('Run omniproxy auth add.');
    expect(shaped.type).toBe('error');
  });

  it('falls back to a gateway error rather than inventing a status', () => {
    const shaped = toAnthropicError(error({ code: 'endpoint_gone' }));
    expect(shaped.status).toBe(502);
  });
});

describe('anthropicStop', () => {
  it('translates every finish reason', () => {
    expect(anthropicStop('stop')).toBe('end_turn');
    expect(anthropicStop('length')).toBe('max_tokens');
    expect(anthropicStop('tool_calls')).toBe('tool_use');
    // No Anthropic equivalent; end_turn is closer to the truth than an invented value.
    expect(anthropicStop('content_filter')).toBe('end_turn');
  });
});

describe('estimateUsage', () => {
  it('estimates when the provider reports nothing', () => {
    expect(estimateUsage(400, 'x'.repeat(80), '')).toEqual({ input_tokens: 100, output_tokens: 20 });
  });

  it('prefers a real count when there is one', () => {
    expect(
      estimateUsage(400, 'x', '', { promptTokens: 7, completionTokens: 3, estimated: false }),
    ).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it('counts reasoning as output, because it was generated', () => {
    expect(estimateUsage(0, '', 'y'.repeat(40)).output_tokens).toBe(10);
  });

  it('never returns a negative count', () => {
    expect(estimateUsage(-10, '', '').input_tokens).toBe(0);
  });
});
