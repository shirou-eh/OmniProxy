import type { OmniError, UMSEvent } from '@omniproxy/schema';
import { describe, expect, it } from 'vitest';
import {
  buildChatCompletion,
  estimateUsage,
  openAiFinish,
  toOpenAiError,
  toOpenAiStream,
} from '../src/response.js';

const identity = { id: 'chatcmpl-abc123', created: 1_700_000_000, model: 'deepseek-chat' };

async function* stream(...events: UMSEvent[]): AsyncGenerator<UMSEvent> {
  for (const event of events) yield event;
}

async function collect(events: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of events) out.push(chunk);
  return out;
}

/** The parsed `data:` payloads of a stream, minus the sentinel. */
async function chunks(events: AsyncIterable<string>): Promise<Record<string, any>[]> {
  return (await collect(events))
    .map((line) => line.replace(/^data: /, '').trim())
    .filter((payload) => payload !== '' && payload !== '[DONE]')
    .map((payload) => JSON.parse(payload) as Record<string, any>);
}

/* ────────────────────────────── non-streaming ────────────────────────────── */

describe('buildChatCompletion', () => {
  const base = { text: 'Hello', reasoning: '', finishReason: 'stop' as const, warnings: [] };

  it('produces the shape a client expects', () => {
    const completion = buildChatCompletion(identity, base, { toolsOffered: false }, 20);
    expect(completion).toMatchObject({
      id: 'chatcmpl-abc123',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
    });
    expect(completion.usage.total_tokens).toBeGreaterThan(0);
  });

  it('attaches reasoning when asked, and never otherwise', () => {
    const withReasoning = { ...base, reasoning: 'thinking' };
    expect(
      buildChatCompletion(identity, withReasoning, { toolsOffered: false, includeReasoning: true })
        .choices[0]!.message.reasoning_content,
    ).toBe('thinking');
    expect(
      buildChatCompletion(identity, withReasoning, { toolsOffered: false }).choices[0]!.message
        .reasoning_content,
    ).toBeUndefined();
  });

  it('turns an emulated tool call into the real shape', () => {
    const completion = buildChatCompletion(
      identity,
      { ...base, text: 'TOOL_CALL: get_weather\n{"city":"Berlin"}' },
      { toolsOffered: true },
    );
    const message = completion.choices[0]!.message;

    expect(message.content).toBeNull();
    expect(message.tool_calls).toEqual([
      { id: 'call_abc123', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } },
    ]);
    expect(completion.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('never puts the raw markup in content alongside the call', () => {
    // A client that renders content would show a user the model's tool syntax; one
    // that parses both would act twice.
    const completion = buildChatCompletion(
      identity,
      { ...base, text: 'TOOL_CALL: f\n{}' },
      { toolsOffered: true },
    );
    expect(completion.choices[0]!.message.content).toBeNull();
  });

  it('does not attach reasoning to a tool-call turn', () => {
    // Several agent clients treat any text payload as a final answer and stop their
    // tool loop, which strands the caller mid-task.
    const completion = buildChatCompletion(
      identity,
      { ...base, text: 'TOOL_CALL: f\n{}', reasoning: 'I should call f' },
      { toolsOffered: true, includeReasoning: true },
    );
    expect(completion.choices[0]!.message.reasoning_content).toBeUndefined();
  });

  it('leaves text alone when no tools were offered, however it looks', () => {
    const completion = buildChatCompletion(
      identity,
      { ...base, text: 'Write TOOL_CALL: f\n{} to call a tool.' },
      { toolsOffered: false },
    );
    expect(completion.choices[0]!.message.content).toContain('TOOL_CALL');
    expect(completion.choices[0]!.message.tool_calls).toBeUndefined();
  });

  it('reports a tool call it could not read instead of swallowing it', () => {
    const completion = buildChatCompletion(
      identity,
      { ...base, text: '｜DSML｜<invoke name="f"></invoke>' },
      { toolsOffered: true },
    );
    expect(completion.omniproxy?.warnings.map((w) => w.code)).toContain('tool_call_unparsed');
  });

  it('carries engine warnings through to the caller', () => {
    const completion = buildChatCompletion(
      identity,
      { ...base, warnings: [{ code: 'empty_response', message: 'nothing streamed' }] },
      { toolsOffered: false },
    );
    expect(completion.omniproxy?.warnings).toEqual([
      { code: 'empty_response', message: 'nothing streamed' },
    ]);
  });

  it('omits the extension field entirely when there is nothing to say', () => {
    expect(buildChatCompletion(identity, base, { toolsOffered: false }).omniproxy).toBeUndefined();
  });
});

/* ──────────────────────────────── streaming ──────────────────────────────── */

describe('toOpenAiStream', () => {
  it('sends the role on the first chunk and text after it', async () => {
    const frames = await chunks(
      toOpenAiStream(
        stream(
          { type: 'start', provider: 'p', channel: 'c', model: 'm' },
          { type: 'text.delta', text: 'Hel' },
          { type: 'text.delta', text: 'lo' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: false },
      ),
    );

    expect(frames[0]!.choices[0].delta).toEqual({ role: 'assistant', content: 'Hel' });
    expect(frames[1]!.choices[0].delta).toEqual({ content: 'lo' });
    expect(frames.at(-1)!.choices[0].finish_reason).toBe('stop');
  });

  it('ends with the sentinel clients wait for', async () => {
    const lines = await collect(
      toOpenAiStream(stream({ type: 'done', finishReason: 'stop' }), identity, {
        toolsOffered: false,
      }),
    );
    expect(lines.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('can be told not to send the sentinel', async () => {
    const lines = await collect(
      toOpenAiStream(stream({ type: 'done', finishReason: 'stop' }), identity, {
        toolsOffered: false,
        doneSentinel: false,
      }),
    );
    expect(lines.at(-1)).not.toContain('[DONE]');
  });

  it('streams reasoning separately when asked', async () => {
    const frames = await chunks(
      toOpenAiStream(
        stream(
          { type: 'reasoning.delta', text: 'hmm' },
          { type: 'text.delta', text: 'answer' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: false, includeReasoning: true },
      ),
    );
    expect(frames[0]!.choices[0].delta).toEqual({ role: 'assistant', reasoning_content: 'hmm' });
    expect(frames[1]!.choices[0].delta).toEqual({ content: 'answer' });
  });

  it('drops reasoning from the wire when it was not asked for', async () => {
    const frames = await chunks(
      toOpenAiStream(
        stream({ type: 'reasoning.delta', text: 'hmm' }, { type: 'done', finishReason: 'stop' }),
        identity,
        { toolsOffered: false },
      ),
    );
    expect(JSON.stringify(frames)).not.toContain('hmm');
  });

  it('emits an empty first chunk when the provider said nothing', async () => {
    // A stream with no chunk at all confuses clients that wait for a role.
    const frames = await chunks(
      toOpenAiStream(stream({ type: 'done', finishReason: 'stop' }), identity, {
        toolsOffered: false,
      }),
    );
    expect(frames[0]!.choices[0].delta).toEqual({ role: 'assistant', content: '' });
  });

  it('passes a native tool-call delta straight through', async () => {
    const frames = await chunks(
      toOpenAiStream(
        stream(
          { type: 'tool_call.delta', index: 0, id: 'c1', name: 'f', argsDelta: '{"a"' },
          { type: 'done', finishReason: 'tool_calls' },
        ),
        identity,
        { toolsOffered: true },
      ),
    );
    expect(frames[0]!.choices[0].delta.tool_calls[0]).toEqual({
      index: 0,
      id: 'c1',
      type: 'function',
      function: { name: 'f', arguments: '{"a"' },
    });
  });

  it('holds text back when tools were offered, then sends one tool-call chunk', async () => {
    // Once a delta has gone out it cannot be taken back, and half a TOOL_CALL marker
    // as content is something a client cannot act on.
    const frames = await chunks(
      toOpenAiStream(
        stream(
          { type: 'text.delta', text: 'TOOL_' },
          { type: 'text.delta', text: 'CALL: f\n{"a":1}' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: true },
      ),
    );

    expect(frames).toHaveLength(2);
    expect(frames[0]!.choices[0].delta.tool_calls[0].function).toEqual({
      name: 'f',
      arguments: '{"a":1}',
    });
    expect(frames[1]!.choices[0].finish_reason).toBe('tool_calls');
  });

  it('releases the held text as one chunk when it was not a tool call after all', async () => {
    const frames = await chunks(
      toOpenAiStream(
        stream(
          { type: 'text.delta', text: 'Just ' },
          { type: 'text.delta', text: 'an answer.' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: true },
      ),
    );
    expect(frames[0]!.choices[0].delta).toEqual({ role: 'assistant', content: 'Just an answer.' });
    expect(frames[1]!.choices[0].finish_reason).toBe('stop');
  });

  it('reports a mid-stream error as a final chunk, with the action attached', async () => {
    // The headers are long gone by then, so this cannot be an HTTP status.
    const error: OmniError = {
      code: 'rate_limit',
      message: 'too many requests',
      userAction: 'Wait for the cooldown or add another account.',
      retryable: 'other-account',
    };
    const frames = await chunks(
      toOpenAiStream(stream({ type: 'error', error }), identity, { toolsOffered: false }),
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]!.error).toMatchObject({
      code: 'rate_limit',
      type: 'rate_limit_error',
      action: 'Wait for the cooldown or add another account.',
    });
    expect(frames[0]!.choices[0].finish_reason).toBe('error');
  });

  it('carries search text into the answer', async () => {
    const frames = await chunks(
      toOpenAiStream(
        stream({ type: 'search.delta', text: '[1] source' }, { type: 'done', finishReason: 'stop' }),
        identity,
        { toolsOffered: false },
      ),
    );
    expect(JSON.stringify(frames)).toContain('[1] source');
  });

  it('keeps the same id and model on every chunk', async () => {
    const frames = await chunks(
      toOpenAiStream(
        stream({ type: 'text.delta', text: 'a' }, { type: 'done', finishReason: 'length' }),
        identity,
        { toolsOffered: false },
      ),
    );
    expect(frames.every((frame) => frame.id === identity.id)).toBe(true);
    expect(frames.every((frame) => frame.model === identity.model)).toBe(true);
    expect(frames.at(-1)!.choices[0].finish_reason).toBe('length');
  });
});

/* ──────────────────────────────── errors ──────────────────────────────── */

describe('toOpenAiError', () => {
  const error = (code: OmniError['code']): OmniError => ({
    code,
    message: 'something',
    userAction: 'do this',
    retryable: 'no',
  });

  it('maps codes to the statuses clients branch on', () => {
    expect(toOpenAiError(error('auth_expired')).status).toBe(401);
    expect(toOpenAiError(error('rate_limit')).status).toBe(429);
    expect(toOpenAiError(error('quota_exhausted')).status).toBe(429);
    expect(toOpenAiError(error('invalid_request')).status).toBe(400);
    expect(toOpenAiError(error('not_implemented')).status).toBe(501);
    expect(toOpenAiError(error('timeout')).status).toBe(504);
    expect(toOpenAiError(error('internal')).status).toBe(500);
  });

  it('falls back to 502 for an upstream problem it has no specific status for', () => {
    expect(toOpenAiError(error('upstream_schema_changed')).status).toBe(502);
  });

  it('keeps the action rather than dropping it into a log', () => {
    // Invariant I-2: an error without a next step is only half an error.
    const body = toOpenAiError(error('challenge'));
    expect(body.error.action).toBe('do this');
    expect(body.error.retryable).toBe('no');
  });

  it('uses the OpenAI error types clients switch on', () => {
    expect(toOpenAiError(error('auth_expired')).error.type).toBe('authentication_error');
    expect(toOpenAiError(error('rate_limit')).error.type).toBe('rate_limit_error');
    expect(toOpenAiError(error('upstream_unavailable')).error.type).toBe('api_error');
  });
});

describe('openAiFinish', () => {
  it('passes through the reasons OpenAI has', () => {
    expect(openAiFinish('stop')).toBe('stop');
    expect(openAiFinish('length')).toBe('length');
    expect(openAiFinish('tool_calls')).toBe('tool_calls');
    expect(openAiFinish('content_filter')).toBe('content_filter');
  });

  it('maps the ones it does not to stop, since the news is in the error body', () => {
    expect(openAiFinish('canceled')).toBe('stop');
    expect(openAiFinish('error')).toBe('stop');
  });
});

describe('estimateUsage', () => {
  it('estimates from characters when the provider reports nothing', () => {
    const usage = estimateUsage(400, 'x'.repeat(80), '');
    expect(usage.prompt_tokens).toBe(100);
    expect(usage.completion_tokens).toBe(20);
    expect(usage.total_tokens).toBe(120);
  });

  it('counts reasoning as completion, because it was generated', () => {
    expect(estimateUsage(0, 'x'.repeat(40), 'y'.repeat(40)).completion_tokens).toBe(20);
  });

  it('prefers real numbers when the provider gives them', () => {
    const usage = estimateUsage(4000, 'text', '', {
      estimated: false,
      promptTokens: 11,
      completionTokens: 7,
    });
    expect(usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  });
});
