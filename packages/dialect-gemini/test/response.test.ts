import type { OmniError, UMSEvent } from '@omniproxy/schema';
import { describe, expect, it } from 'vitest';
import {
  approxTokens,
  buildGenerateContentResponse,
  estimateUsage,
  geminiFinish,
  toGeminiError,
  toGeminiStream,
  type GenerateContentResponse,
  type GenerateOptions,
} from '../src/response.js';

/**
 * Writing a Gemini response.
 *
 * Google's stream is the simplest of the three and the least forgiving for it: no
 * sentinel, no per-block framing, just the same response shape again and again. A
 * client learns the stream ended only because the last chunk carried a `finishReason`,
 * so most of what follows checks that it always does — including when the reason is a
 * failure.
 */

const identity = { model: 'deepseek-chat' };

const collected = (overrides: Record<string, unknown> = {}) => ({
  text: 'Hello.',
  reasoning: '',
  finishReason: 'stop' as const,
  warnings: [] as { code: string; message: string }[],
  ...overrides,
});

const options = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
  toolsOffered: false,
  ...overrides,
});

async function* stream(...events: UMSEvent[]): AsyncGenerator<UMSEvent> {
  for (const event of events) yield event;
}

async function chunks(generator: AsyncGenerator<string>): Promise<GenerateContentResponse[]> {
  const parsed: GenerateContentResponse[] = [];
  for await (const frame of generator) {
    const data = /^data: (.+)$/m.exec(frame)?.[1];
    if (data) parsed.push(JSON.parse(data) as GenerateContentResponse);
  }
  return parsed;
}

/* ────────────────────────────── non-streaming ────────────────────────────── */

describe('buildGenerateContentResponse', () => {
  it('builds the candidate clients read', () => {
    const response = buildGenerateContentResponse(identity, collected(), options(), 40);
    const candidate = response.candidates[0];

    expect(candidate?.content.role).toBe('model');
    expect(candidate?.content.parts).toEqual([{ text: 'Hello.' }]);
    expect(candidate?.finishReason).toBe('STOP');
    expect(candidate?.index).toBe(0);
    expect(response.modelVersion).toBe('deepseek-chat');
    expect(response.usageMetadata.totalTokenCount).toBeGreaterThan(0);
  });

  it('never returns an empty parts array', () => {
    // Clients read candidates[0].content.parts[0].text without checking, and an empty
    // array is the most common source of "undefined" in somebody else's stack trace.
    const response = buildGenerateContentResponse(identity, collected({ text: '' }), options(), 0);
    expect(response.candidates[0]?.content.parts).toEqual([{ text: '' }]);
  });

  it('reports no safety ratings rather than inventing them', () => {
    // We ran no classifier. Reporting ratings nobody computed is a fabricated
    // measurement, which is worse than an empty list.
    expect(buildGenerateContentResponse(identity, collected(), options(), 0).candidates[0]
      ?.safetyRatings).toEqual([]);
  });

  it('marks token counts as estimated, because they are', () => {
    const response = buildGenerateContentResponse(identity, collected(), options(), 40);
    expect(response.omniproxy?.estimatedTokens).toBe(true);
  });

  it('does not mark them estimated when the provider reported real ones', () => {
    const response = buildGenerateContentResponse(
      identity,
      collected({ usage: { promptTokens: 5, completionTokens: 6, estimated: false } }),
      options(),
      40,
    );
    expect(response.omniproxy?.estimatedTokens).toBeUndefined();
    expect(response.usageMetadata.promptTokenCount).toBe(5);
  });

  it('marks reasoning with `thought`, as Google does', () => {
    const response = buildGenerateContentResponse(
      identity,
      collected({ reasoning: 'Считаю…' }),
      options({ includeThoughts: true }),
      0,
    );
    expect(response.candidates[0]?.content.parts[0]).toEqual({ text: 'Считаю…', thought: true });
  });

  it('turns a recognised tool call into a functionCall part', () => {
    const response = buildGenerateContentResponse(
      identity,
      collected({ text: 'TOOL_CALL: get_weather\narguments: {"city":"Berlin"}' }),
      options({ toolsOffered: true }),
      0,
    );

    expect(response.candidates[0]?.content.parts[0]).toEqual({
      functionCall: { name: 'get_weather', args: { city: 'Berlin' } },
    });
    // Google has no separate reason for a call; the turn ends normally.
    expect(response.candidates[0]?.finishReason).toBe('STOP');
  });

  it('leaves the text alone when no tools were offered', () => {
    const response = buildGenerateContentResponse(
      identity,
      collected({ text: 'TOOL_CALL: x\narguments: {}' }),
      options(),
      0,
    );
    expect(response.candidates[0]?.content.parts[0]).toMatchObject({ text: expect.any(String) });
  });

  it('surfaces a warning without disturbing the schema', () => {
    const response = buildGenerateContentResponse(
      identity,
      collected({ warnings: [{ code: 'w', message: 'something' }] }),
      options(),
      0,
    );
    expect(response.omniproxy?.warnings).toEqual([{ code: 'w', message: 'something' }]);
    expect(response.candidates).toHaveLength(1);
  });
});

/* ──────────────────────────────── streaming ──────────────────────────────── */

describe('toGeminiStream', () => {
  it('sends each fragment as a whole response, and finishes with a reason', async () => {
    const parsed = await chunks(
      toGeminiStream(
        stream(
          { type: 'text.delta', text: 'Hel' },
          { type: 'text.delta', text: 'lo.' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: false },
      ),
    );

    const text = parsed
      .flatMap((chunk) => chunk.candidates[0]?.content.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    expect(text).toBe('Hello.');
    expect(parsed.at(-1)?.candidates[0]?.finishReason).toBe('STOP');
  });

  it('carries the finish reason even when nothing was said', async () => {
    // Without a sentinel this is the only way a client learns the stream ended rather
    // than broke.
    const parsed = await chunks(
      toGeminiStream(stream({ type: 'done', finishReason: 'stop' }), identity, {
        toolsOffered: false,
      }),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.candidates[0]?.finishReason).toBe('STOP');
  });

  it('marks thinking chunks and only sends them when asked', async () => {
    const withThoughts = await chunks(
      toGeminiStream(
        stream({ type: 'reasoning.delta', text: 'думаю' }, { type: 'done', finishReason: 'stop' }),
        identity,
        { toolsOffered: false, includeThoughts: true },
      ),
    );
    expect(withThoughts[0]?.candidates[0]?.content.parts[0]).toEqual({
      text: 'думаю',
      thought: true,
    });

    const without = await chunks(
      toGeminiStream(
        stream({ type: 'reasoning.delta', text: 'думаю' }, { type: 'done', finishReason: 'stop' }),
        identity,
        { toolsOffered: false },
      ),
    );
    expect(JSON.stringify(without)).not.toContain('думаю');
  });

  it('holds text back when tools were offered', async () => {
    const parsed = await chunks(
      toGeminiStream(
        stream(
          { type: 'text.delta', text: 'Hel' },
          { type: 'text.delta', text: 'lo.' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: true },
      ),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.candidates[0]?.content.parts[0]).toEqual({ text: 'Hello.' });
  });

  it('emits a functionCall when the held text turns out to be one', async () => {
    const parsed = await chunks(
      toGeminiStream(
        stream(
          { type: 'text.delta', text: 'TOOL_CALL: f\narguments: {"a":1}' },
          { type: 'done', finishReason: 'stop' },
        ),
        identity,
        { toolsOffered: true },
      ),
    );

    expect(parsed[0]?.candidates[0]?.content.parts[0]).toEqual({
      functionCall: { name: 'f', args: { a: 1 } },
    });
    expect(parsed[0]?.candidates[0]?.finishReason).toBe('STOP');
  });

  it('ends a failed stream with a reason and the error, not with silence', async () => {
    // Google's stream has no error frame. A truncated stream is the alternative, and
    // every client reports that as "the model stopped".
    const failure: OmniError = {
      code: 'quota_exhausted',
      message: 'out of messages',
      userAction: 'Add another account.',
      retryable: 'other-account',
    };
    const parsed = await chunks(
      toGeminiStream(
        stream({ type: 'text.delta', text: 'partial' }, { type: 'error', error: failure }),
        identity,
        { toolsOffered: false },
      ),
    );

    const last = parsed.at(-1) as GenerateContentResponse & { error?: Record<string, unknown> };
    expect(last.candidates[0]?.finishReason).toBe('OTHER');
    expect(last.error?.['status']).toBe('RESOURCE_EXHAUSTED');
    expect(last.error?.['action']).toBe('Add another account.');
  });

  it('carries usage on every chunk, as Google does', async () => {
    const parsed = await chunks(
      toGeminiStream(
        stream({ type: 'text.delta', text: 'x'.repeat(40) }, { type: 'done', finishReason: 'length' }),
        identity,
        { toolsOffered: false, promptChars: 40 },
      ),
    );
    for (const chunk of parsed) expect(chunk.usageMetadata.promptTokenCount).toBe(10);
    expect(parsed.at(-1)?.candidates[0]?.finishReason).toBe('MAX_TOKENS');
  });

  it('frames chunks as SSE data lines', async () => {
    const first = await toGeminiStream(
      stream({ type: 'done', finishReason: 'stop' }),
      identity,
      { toolsOffered: false },
    ).next();
    expect(first.value).toMatch(/^data: \{/);
    expect(first.value).toMatch(/\n\n$/);
  });
});

/* ──────────────────────────────── errors ──────────────────────────────── */

describe('toGeminiError', () => {
  const error = (overrides: Partial<OmniError>): OmniError => ({
    code: 'internal',
    message: 'boom',
    userAction: 'do something',
    retryable: 'no',
    ...overrides,
  });

  it('uses the canonical status strings client libraries switch on', () => {
    const cases: [OmniError['code'], number, string][] = [
      ['auth_expired', 401, 'UNAUTHENTICATED'],
      ['challenge', 403, 'PERMISSION_DENIED'],
      ['rate_limit', 429, 'RESOURCE_EXHAUSTED'],
      ['quota_exhausted', 429, 'RESOURCE_EXHAUSTED'],
      ['invalid_request', 400, 'INVALID_ARGUMENT'],
      ['timeout', 504, 'DEADLINE_EXCEEDED'],
      ['upstream_unavailable', 503, 'UNAVAILABLE'],
      ['internal', 500, 'INTERNAL'],
    ];
    for (const [code, status, reason] of cases) {
      const shaped = toGeminiError(error({ code }));
      expect([code, shaped.status, shaped.error.status]).toEqual([code, status, reason]);
    }
  });

  it('repeats the status inside the body, as Google does', () => {
    const shaped = toGeminiError(error({ code: 'rate_limit' }));
    expect(shaped.error.code).toBe(429);
  });

  it('keeps the action (I-2)', () => {
    expect(toGeminiError(error({ userAction: 'Run omniproxy auth add.' })).error.action).toBe(
      'Run omniproxy auth add.',
    );
  });
});

describe('geminiFinish', () => {
  it('translates every finish reason', () => {
    expect(geminiFinish('stop')).toBe('STOP');
    expect(geminiFinish('length')).toBe('MAX_TOKENS');
    expect(geminiFinish('content_filter')).toBe('SAFETY');
    expect(geminiFinish('tool_calls')).toBe('STOP');
    expect(geminiFinish('error')).toBe('OTHER');
  });
});

describe('estimateUsage', () => {
  it('estimates and totals', () => {
    expect(estimateUsage(400, 'x'.repeat(80), '')).toEqual({
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      totalTokenCount: 120,
    });
  });

  it('prefers a real count when there is one', () => {
    expect(
      estimateUsage(400, 'x', '', { promptTokens: 7, completionTokens: 3, estimated: false }),
    ).toMatchObject({ promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 });
  });

  it('never returns a negative count', () => {
    expect(approxTokens(-10)).toBe(0);
  });
});
