import { describe, expect, it } from 'vitest';
import { renderTemplate, renderValue, TemplateError } from '../src/template.js';

const context = {
  req: { model: 'deepseek-chat', prompt: 'привет', messages: [{ role: 'user', content: 'hi' }] },
  auth: { cookie: 'userToken=abc' },
  state: { sessionId: 'sess-1', parentMessageId: 7 },
  vars: { pow: 'eyJhbGciOi' },
  env: { HOME: '/home/user' },
  extracted: { challenge: { difficulty: 12 } },
  channel: { id: 'web', base: 'https://chat.example.test' },
  now: { unixMs: 1_700_000_000_000, unixS: 1_700_000_000, iso: '2023-11-14T22:13:20.000Z' },
};

describe('renderTemplate', () => {
  it('substitutes a value', () => {
    expect(renderTemplate('/api/{{state.sessionId}}/send', context).value).toBe('/api/sess-1/send');
  });

  it('substitutes several placeholders in one string', () => {
    expect(renderTemplate('{{channel.base}}/v1/{{req.model}}', context).value).toBe(
      'https://chat.example.test/v1/deepseek-chat',
    );
  });

  it('stringifies non-strings', () => {
    expect(renderTemplate('parent={{state.parentMessageId}}', context).value).toBe('parent=7');
    expect(renderTemplate('{{extracted.challenge}}', context).value).toBe('{"difficulty":12}');
  });

  it('reads array elements and nested keys', () => {
    expect(renderTemplate('{{req.messages[0].role}}', context).value).toBe('user');
    expect(renderTemplate('{{extracted.challenge.difficulty}}', context).value).toBe('12');
  });

  it('reports unresolved placeholders instead of quietly emptying them', () => {
    const result = renderTemplate('/api/{{state.missing}}/send', context);
    expect(result.value).toBe('/api//send');
    expect(result.unresolved).toEqual(['state.missing']);
  });

  it('leaves text with no placeholders alone', () => {
    const result = renderTemplate('/api/v1/chat', context);
    expect(result.value).toBe('/api/v1/chat');
    expect(result.unresolved).toEqual([]);
  });

  it('refuses an unknown root', () => {
    expect(() => renderTemplate('{{process.env.SECRET}}', context)).toThrow(TemplateError);
    expect(() => renderTemplate('{{globalThis}}', context)).toThrow(TemplateError);
  });

  it('cannot compute — the point of ADR-0002', () => {
    // No expressions: these are read as paths, fail as unknown roots, and never evaluate.
    expect(() => renderTemplate('{{1+1}}', context)).toThrow(TemplateError);
    expect(() => renderTemplate('{{require("fs")}}', context)).toThrow(TemplateError);
  });
});

describe('template modifiers', () => {
  it('applies default: only for empty values', () => {
    expect(renderTemplate('{{state.missing|default:none}}', context).value).toBe('none');
    expect(renderTemplate('{{state.sessionId|default:none}}', context).value).toBe('sess-1');
  });

  it('applies the encoding modifiers', () => {
    expect(renderTemplate('{{req.model|upper}}', context).value).toBe('DEEPSEEK-CHAT');
    expect(renderTemplate('{{req.model|base64}}', context).value).toBe(
      Buffer.from('deepseek-chat').toString('base64'),
    );
    expect(renderTemplate('{{req.prompt|urlencode}}', context).value).toBe(
      encodeURIComponent('привет'),
    );
    expect(renderTemplate('{{req.messages|json}}', context).value).toBe(
      '[{"role":"user","content":"hi"}]',
    );
  });

  it('applies numeric and boolean modifiers', () => {
    expect(renderTemplate('{{state.parentMessageId|int}}', context).value).toBe('7');
    expect(renderTemplate('{{state.missing|bool}}', context).value).toBe('false');
    expect(renderTemplate('{{req.prompt|slice:3}}', context).value).toBe('при');
  });

  it('chains modifiers left to right', () => {
    expect(renderTemplate('{{req.model|upper|base64}}', context).value).toBe(
      Buffer.from('DEEPSEEK-CHAT').toString('base64'),
    );
  });

  it('refuses an unknown modifier rather than ignoring it', () => {
    expect(() => renderTemplate('{{req.model|exec}}', context)).toThrow(TemplateError);
    expect(() => renderTemplate('{{req.model|slice:abc}}', context)).toThrow(TemplateError);
  });
});

describe('renderValue', () => {
  it('keeps the type of a whole-placeholder string', () => {
    const { value } = renderValue({ messages: '{{req.messages}}' }, context);
    expect(value).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
  });

  it('still interpolates when a placeholder is part of a larger string', () => {
    const { value } = renderValue({ ref: 'id:{{state.sessionId}}' }, context);
    expect(value).toEqual({ ref: 'id:sess-1' });
  });

  it('walks nested objects and arrays', () => {
    const { value } = renderValue(
      { a: [{ b: '{{state.parentMessageId}}' }], c: { d: '{{req.model}}' } },
      context,
    );
    expect(value).toEqual({ a: [{ b: 7 }], c: { d: 'deepseek-chat' } });
  });

  it('drops a key whose only content was unresolved, and reports it', () => {
    const { value, unresolved } = renderValue(
      { keep: '{{req.model}}', drop: '{{state.nope}}' },
      context,
    );
    expect(value).toEqual({ keep: 'deepseek-chat' });
    expect(unresolved).toEqual(['state.nope']);
  });

  it('passes non-string leaves through untouched', () => {
    const { value } = renderValue({ n: 1, b: true, z: null, arr: [1, 2] }, context);
    expect(value).toEqual({ n: 1, b: true, z: null, arr: [1, 2] });
  });
});
