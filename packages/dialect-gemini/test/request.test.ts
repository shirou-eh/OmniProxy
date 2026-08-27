import { describe, expect, it } from 'vitest';
import {
  flattenRequest,
  GeminiRequestError,
  parseGenerateContentRequest,
  parseModelPath,
  toUniversal,
  toUniversalTools,
  universalParams,
  type GenerateContentRequest,
} from '../src/request.js';

/**
 * Reading a Gemini request.
 *
 * Google's layout differs from the other two more than they differ from each other,
 * and every difference below is somewhere a converter that assumed OpenAI's shape
 * would drop something without saying so.
 */

function request(overrides: Partial<GenerateContentRequest> = {}): GenerateContentRequest {
  return parseGenerateContentRequest({
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    ...overrides,
  });
}

describe('parseModelPath', () => {
  it('reads the model and the operation out of the URL', () => {
    expect(parseModelPath('/v1beta/models/deepseek-chat:generateContent')).toEqual({
      model: 'deepseek-chat',
      method: 'generateContent',
    });
  });

  it('keeps a qualified name whole, slash and all', () => {
    // `deepseek-web/deepseek-chat` puts a slash inside what looks like one path
    // segment. Reading the segment as one word would lose the provider.
    expect(parseModelPath('/v1beta/models/deepseek-web/deepseek-chat:streamGenerateContent')).toEqual(
      { model: 'deepseek-web/deepseek-chat', method: 'streamGenerateContent' },
    );
  });

  it('strips the models/ prefix clients sometimes send twice', () => {
    expect(parseModelPath('/v1beta/models/models/x:generateContent')?.model).toBe('x');
  });

  it('accepts the versions Google actually serves', () => {
    for (const prefix of ['/v1', '/v1beta', '/v1beta2']) {
      expect(parseModelPath(`${prefix}/models/x:generateContent`)?.model).toBe('x');
    }
  });

  it('decodes a percent-encoded name', () => {
    expect(parseModelPath('/v1beta/models/deepseek-web%2Fdeepseek-chat:generateContent')?.model).toBe(
      'deepseek-web/deepseek-chat',
    );
  });

  it('matches nothing it should not', () => {
    for (const path of [
      '/v1/chat/completions',
      '/v1/messages',
      '/v1beta/models',
      '/v1beta/models/x',
      '/health',
    ]) {
      expect(parseModelPath(path), path).toBeUndefined();
    }
  });
});

describe('parseGenerateContentRequest', () => {
  it('accepts a minimal request', () => {
    expect(request().contents).toHaveLength(1);
  });

  it('rejects an empty contents list', () => {
    expect(() => parseGenerateContentRequest({ contents: [] })).toThrow(GeminiRequestError);
  });

  it('refuses more than one candidate rather than quietly returning one', () => {
    const failure = refusal(() => request({ generationConfig: { candidateCount: 3 } }));
    expect(failure.reason).toBe('INVALID_ARGUMENT');
    expect(failure.message).toMatch(/one candidate per request/);
    expect(() => request({ generationConfig: { candidateCount: 1 } })).not.toThrow();
  });

  it('keeps fields it does not act on', () => {
    const parsed = request({ safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH' }] } as Partial<GenerateContentRequest>);
    expect(parsed.safetySettings).toHaveLength(1);
  });

  it('uses Google status strings, which client libraries switch on', () => {
    expect(refusal(() => parseGenerateContentRequest({})).reason).toBe('INVALID_ARGUMENT');
  });
});

describe('toUniversal', () => {
  it('reads `model` as the assistant role', () => {
    const universal = toUniversal(
      request({
        contents: [
          { role: 'user', parts: [{ text: 'a' }] },
          { role: 'model', parts: [{ text: 'b' }] },
        ],
      }),
    );
    expect(universal.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('treats an absent role as the user, which the single-turn form allows', () => {
    const universal = toUniversal(request({ contents: [{ parts: [{ text: 'hi' }] }] }));
    expect(universal[0]?.role).toBe('user');
  });

  it('lifts systemInstruction into a system message', () => {
    const universal = toUniversal(
      request({ systemInstruction: { parts: [{ text: 'Be terse.' }] } }),
    );
    expect(universal[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'Be terse.' }] });
  });

  it('turns a functionCall part into a tool call', () => {
    const universal = toUniversal(
      request({
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Berlin' } } }] },
        ],
      }),
    );
    expect(universal[0]?.content[0]).toEqual({
      type: 'tool_call',
      name: 'get_weather',
      args: '{"city":"Berlin"}',
    });
  });

  it('lifts a functionResponse out of its user turn, keyed by name', () => {
    // Gemini has no call id here; the name is the only handle the model has for
    // matching a result to the call that asked for it.
    const universal = toUniversal(
      request({
        contents: [
          { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { result: '18C' } } }] },
        ],
      }),
    );
    expect(universal[0]?.role).toBe('tool');
    expect(universal[0]?.content[0]).toEqual({ type: 'tool_result', id: 'get_weather', text: '18C' });
  });

  it('splits a turn that mixes a function result with typed text', () => {
    const universal = toUniversal(
      request({
        contents: [
          {
            role: 'user',
            parts: [
              { functionResponse: { name: 'f', response: { result: 'done' } } },
              { text: 'now summarise it' },
            ],
          },
        ],
      }),
    );
    expect(universal.map((message) => message.role)).toEqual(['tool', 'user']);
  });

  it('unwraps the usual result envelope rather than handing the model raw JSON', () => {
    const universal = toUniversal(
      request({
        contents: [{ role: 'user', parts: [{ functionResponse: { name: 'f', response: { content: 'plain' } } }] }],
      }),
    );
    expect(universal[0]?.content[0]).toMatchObject({ text: 'plain' });
  });

  it('keeps a response that does not use that envelope, as JSON', () => {
    const universal = toUniversal(
      request({
        contents: [{ role: 'user', parts: [{ functionResponse: { name: 'f', response: { temp: 18 } } }] }],
      }),
    );
    expect(universal[0]?.content[0]).toMatchObject({ text: '{"temp":18}' });
  });

  it('names inline data and its size instead of carrying it', () => {
    const universal = toUniversal(
      request({
        contents: [
          { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'x'.repeat(24) } }] },
        ],
      }),
    );
    expect(universal[0]?.content[0]).toEqual({
      type: 'image',
      url: 'image/png, 24 base64 characters, not sent',
    });
  });

  it('passes a file reference through as its uri', () => {
    const universal = toUniversal(
      request({ contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'gs://b/o' } }] }] }),
    );
    expect(universal[0]?.content[0]).toEqual({ type: 'image', url: 'gs://b/o' });
  });

  it('keeps a part it does not recognise, described', () => {
    const universal = toUniversal(
      request({ contents: [{ role: 'user', parts: [{ executableCode: { code: 'x' } }] }] }),
    );
    expect(universal[0]?.content[0]).toMatchObject({ type: 'unknown' });
  });

  it('skips a turn with nothing in it', () => {
    const universal = toUniversal(
      request({
        contents: [
          { role: 'user', parts: [] },
          { role: 'user', parts: [{ text: 'real' }] },
        ],
      }),
    );
    expect(universal).toHaveLength(1);
  });
});

describe('toUniversalTools', () => {
  it('flattens the list of lists Google uses', () => {
    expect(
      toUniversalTools([
        {
          functionDeclarations: [
            { name: 'a', description: 'first', parameters: { type: 'object' } },
            { name: 'b' },
          ],
        },
        { functionDeclarations: [{ name: 'c' }] },
      ]),
    ).toEqual([
      { name: 'a', description: 'first', parameters: { type: 'object' } },
      { name: 'b' },
      { name: 'c' },
    ]);
  });

  it('is undefined when there is nothing declared', () => {
    expect(toUniversalTools(undefined)).toBeUndefined();
    expect(toUniversalTools([])).toBeUndefined();
    expect(toUniversalTools([{ functionDeclarations: [] }])).toBeUndefined();
  });
});

describe('flattenRequest', () => {
  it('produces the shape the model was taught to read', () => {
    const flat = flattenRequest(
      request({
        systemInstruction: { parts: [{ text: 'Be terse.' }] },
        contents: [
          { role: 'user', parts: [{ text: 'what is 2+2' }] },
          { role: 'model', parts: [{ text: '4' }] },
          { role: 'user', parts: [{ text: 'and 3+3' }] },
        ],
      }),
    );

    expect(flat.systemPrompt).toBe('Be terse.');
    expect(flat.prompt).toBe('User: what is 2+2\n\nAssistant: 4\n\nUser: and 3+3');
  });

  it('renders a call and its result the way the other dialects do', () => {
    const flat = flattenRequest(
      request({
        contents: [
          { role: 'user', parts: [{ text: 'weather?' }] },
          { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Berlin' } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { result: '18C' } } }] },
        ],
      }),
    );

    expect(flat.prompt).toContain('Assistant: TOOL_CALL: get_weather');
    expect(flat.prompt).toContain('[Tool Result get_weather]\n18C');
  });
});

describe('universalParams', () => {
  it('lifts the knobs out of generationConfig', () => {
    expect(
      universalParams(
        request({
          generationConfig: {
            temperature: 0.3,
            topP: 0.8,
            topK: 20,
            maxOutputTokens: 512,
            stopSequences: ['END'],
          },
        }),
      ),
    ).toEqual({ temperature: 0.3, topP: 0.8, topK: 20, maxTokens: 512, stop: ['END'] });
  });

  it('is empty when there is no config, rather than inventing defaults', () => {
    expect(universalParams(request())).toEqual({});
  });
});

function refusal(fn: () => unknown): GeminiRequestError {
  try {
    fn();
  } catch (error) {
    if (error instanceof GeminiRequestError) return error;
    throw error;
  }
  throw new Error('expected the request to be refused, and it was accepted');
}
