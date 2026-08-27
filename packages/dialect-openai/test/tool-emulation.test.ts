import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildToolCall,
  extractBalancedJson,
  looksLikeToolMarkup,
  parseEmulatedToolCall,
} from '../src/tool-emulation.js';

/**
 * Tool-call emulation, checked against the parser it was ported from.
 *
 * Every branch in `legacy/server.js`'s parser exists because a model did something.
 * A rewrite that looks cleaner and quietly drops one of them regresses behaviour
 * nobody has written down anywhere else, which is risk R-15 exactly. So the oracle
 * here is the legacy function itself, loaded and run on the same inputs.
 */

const require = createRequire(import.meta.url);
const legacy = require(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../legacy/server.js'),
).__test as {
  parseToolCall(text: string): { name: string; arguments: string } | null;
  looksLikeToolCallMarkup(text: string): boolean;
};

/** Every shape this port claims to handle. */
const shared: Record<string, string> = {
  'the documented marker form':
    'TOOL_CALL: get_weather\narguments: {"city": "Berlin", "units": "metric"}',

  'the marker with prose around it':
    'Sure, let me check.\n\nTOOL_CALL: get_weather\n{"city":"Berlin"}\n\nOne moment.',

  'nested objects in the arguments':
    'TOOL_CALL: search\n{"query":{"text":"rain","filters":{"since":"2026-01-01"}}}',

  'braces inside a string in the arguments':
    'TOOL_CALL: echo\n{"text":"a } brace and a \\" quote"}',

  'a fenced json envelope':
    '```json\n{"tool_call": {"name": "get_time", "arguments": {"tz": "UTC"}}}\n```',

  'a fenced function_call envelope':
    '```\n{"function_call": {"name": "lookup", "arguments": "{\\"id\\": 7}"}}\n```',

  'a single-element tool_calls array':
    '{"tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "a_b", "arguments": "{}"}}]}',

  'an xml wrapper with a bare object':
    '<tool_call>{"name": "run_query", "arguments": {"sql": "select 1"}}</tool_call>',

  'plain prose with no call at all': 'The weather in Berlin is mild today.',

  'prose that mentions a tool without calling it':
    'You could use the get_weather tool, which takes {"city": "..."} as its input.',

  'a two-element tool_calls array, which is ambiguous':
    '{"tool_calls": [{"function": {"name": "a", "arguments": "{}"}}, {"function": {"name": "b", "arguments": "{}"}}]}',

  'a marker with no json after it': 'TOOL_CALL: get_weather\nI need the city first.',

  'a marker with unbalanced braces': 'TOOL_CALL: get_weather\n{"city": "Berlin"',

  'a name starting with a digit, which OpenAI also allows': 'TOOL_CALL: 9lives\n{"a":1}',

  'arguments that are an array, not an object':
    '{"tool_call": {"name": "sum", "arguments": [1, 2, 3]}}',
};

describe('parity with the legacy tool-call parser', () => {
  for (const [name, text] of Object.entries(shared)) {
    it(name, () => {
      const ours = parseEmulatedToolCall(text).call ?? null;
      const theirs = legacy.parseToolCall(text);
      expect(ours).toEqual(theirs);
    });
  }
});

describe('what the port does with what it does not parse', () => {
  it('says so about DSML markup instead of returning it as an answer', () => {
    // Not ported, and recorded as missing rather than half-done (§12.5). Returning
    // the raw markup to a client that renders it would show a user tool syntax.
    const text = '｜DSML｜<invoke name="get_weather"><parameter name="city">Berlin</parameter></invoke>';
    const parse = parseEmulatedToolCall(text);

    expect(parse.call).toBeUndefined();
    expect(parse.unparsed).toMatch(/DSML tool markup, which this build does not parse/);
  });

  it('refuses an implausibly large candidate rather than scanning it', () => {
    const huge = `TOOL_CALL: a\n{"x":"${'y'.repeat(300_000)}"}`;
    const parse = parseEmulatedToolCall(huge);
    expect(parse.call).toBeUndefined();
    expect(parse.unparsed).toMatch(/refusing \d+ characters/);
    expect(legacy.parseToolCall(huge)).toBeNull();
  });

  it('explains a marker whose arguments did not parse', () => {
    const parse = parseEmulatedToolCall('TOOL_CALL: get_weather\n{"city": Berlin}');
    expect(parse.call).toBeUndefined();
    expect(parse.unparsed).toMatch(/did not parse/);
  });

  it('handles no input at all', () => {
    expect(parseEmulatedToolCall(undefined)).toEqual({});
    expect(parseEmulatedToolCall('')).toEqual({});
  });
});

describe('looksLikeToolMarkup', () => {
  it('agrees with legacy about ordinary prose and about markers', () => {
    for (const text of ['just text', 'TOOL_CALL: a', '<tool_call>{}</tool_call>']) {
      expect(looksLikeToolMarkup(text)).toBe(legacy.looksLikeToolCallMarkup(text));
    }
  });

  it('recognises a json envelope', () => {
    expect(looksLikeToolMarkup('{"tool_calls": []}')).toBe(true);
    expect(looksLikeToolMarkup(undefined)).toBe(false);
  });
});

describe('buildToolCall', () => {
  it('serializes arguments to a JSON string, as the OpenAI shape requires', () => {
    expect(buildToolCall('a_b', { x: 1 })).toEqual({ name: 'a_b', arguments: '{"x":1}' });
  });

  it('accepts arguments that already are a JSON string', () => {
    expect(buildToolCall('a', '{"x":1}')).toEqual({ name: 'a', arguments: '{"x":1}' });
  });

  it('defaults absent arguments to an empty object', () => {
    expect(buildToolCall('a', undefined)).toEqual({ name: 'a', arguments: '{}' });
    expect(buildToolCall('a', null)).toEqual({ name: 'a', arguments: '{}' });
  });

  it('refuses names a client could not route', () => {
    // A leading digit is fine — OpenAI's own name rule allows it, and so does legacy.
    for (const name of ['', ' ', 'a b', 'a/b', 'a\nb', 'x'.repeat(200), 42, null]) {
      expect(buildToolCall(name, {})).toBeUndefined();
    }
  });

  it('refuses arguments that are not an object', () => {
    expect(buildToolCall('a', [1, 2])).toBeUndefined();
    expect(buildToolCall('a', 'not json')).toBeUndefined();
    expect(buildToolCall('a', 5)).toBeUndefined();
  });

  it('refuses arguments beyond the size cap', () => {
    expect(buildToolCall('a', { x: 'y'.repeat(200_000) })).toBeUndefined();
  });
});

describe('extractBalancedJson', () => {
  it('stops at the matching brace, not at the first one', () => {
    expect(extractBalancedJson('{"a":{"b":1}} trailing', 0)).toBe('{"a":{"b":1}}');
  });

  it('ignores braces inside strings', () => {
    expect(extractBalancedJson('{"a":"}"}', 0)).toBe('{"a":"}"}');
  });

  it('ignores escaped quotes', () => {
    expect(extractBalancedJson('{"a":"say \\"hi\\" }"}', 0)).toBe('{"a":"say \\"hi\\" }"}');
  });

  it('returns nothing when the braces never balance', () => {
    expect(extractBalancedJson('{"a":1', 0)).toBeUndefined();
    expect(extractBalancedJson('no brace here', 0)).toBeUndefined();
  });
});
