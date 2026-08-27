import { describe, expect, it } from 'vitest';
import { JsonPathError, parseJsonPath, queryJsonPath, selectJsonPath } from '../src/jsonpath.js';

const document = {
  data: {
    biz_data: {
      chat_session: { id: 'sess-1', title: 'first' },
      id: 'legacy-id',
    },
    works: [
      { resource: { resource: 'https://cdn.example.test/a.mp4' }, status: 'succeed' },
      { resource: { resource: 'https://cdn.example.test/b.mp4' }, status: 'failed' },
    ],
  },
  choices: [{ delta: { content: 'hello', reasoning_content: 'thinking' }, finish_reason: null }],
  nested: { a: { id: 'deep-1', b: { id: 'deep-2' } } },
};

describe('parseJsonPath', () => {
  it('parses dotted keys', () => {
    expect(parseJsonPath('$.data.biz_data.id')).toEqual([
      { kind: 'key', name: 'data' },
      { kind: 'key', name: 'biz_data' },
      { kind: 'key', name: 'id' },
    ]);
  });

  it('parses indexes, wildcards, quoted keys, descent and filters', () => {
    expect(parseJsonPath('$.a[0]')).toEqual([
      { kind: 'key', name: 'a' },
      { kind: 'index', index: 0 },
    ]);
    expect(parseJsonPath('$.a[*]')).toEqual([{ kind: 'key', name: 'a' }, { kind: 'wildcard' }]);
    expect(parseJsonPath('$["odd key"]')).toEqual([{ kind: 'key', name: 'odd key' }]);
    expect(parseJsonPath('$..id')).toEqual([{ kind: 'descend', name: 'id' }]);
    expect(parseJsonPath("$.works[?(@.status=='succeed')]")).toEqual([
      { kind: 'key', name: 'works' },
      { kind: 'filter', name: 'status', equals: 'succeed' },
    ]);
  });

  it('rejects anything that is not a path', () => {
    expect(() => parseJsonPath('data.id')).toThrow(JsonPathError);
    expect(() => parseJsonPath('$.')).toThrow(JsonPathError);
    expect(() => parseJsonPath('$.a[')).toThrow(JsonPathError);
    expect(() => parseJsonPath('$.a[1+1]')).toThrow(JsonPathError);
    expect(() => parseJsonPath('$..')).toThrow(JsonPathError);
    expect(() => parseJsonPath('$!bad')).toThrow(JsonPathError);
  });

  it('refuses expressions on purpose, so a declaration can never execute', () => {
    expect(() => parseJsonPath('$.a[?(@.x > 1)]')).toThrow(JsonPathError);
    expect(() => parseJsonPath('$.a[(@.length-1)]')).toThrow(JsonPathError);
  });

  it('caches parses without confusing different paths', () => {
    expect(parseJsonPath('$.data.id')).toEqual(parseJsonPath('$.data.id'));
    expect(parseJsonPath('$.data.id')).not.toEqual(parseJsonPath('$.data.title'));
  });
});

describe('selectJsonPath', () => {
  it('reads nested keys', () => {
    expect(selectJsonPath(document, '$.data.biz_data.chat_session.id')).toBe('sess-1');
  });

  it('returns undefined for a path that matches nothing', () => {
    expect(selectJsonPath(document, '$.data.nope.deeper')).toBeUndefined();
    expect(selectJsonPath(document, '$.choices[9].delta')).toBeUndefined();
  });

  it('reads array elements, including from the end', () => {
    expect(selectJsonPath(document, '$.data.works[0].status')).toBe('succeed');
    expect(selectJsonPath(document, '$.data.works[-1].status')).toBe('failed');
  });

  it('reads through a wildcard', () => {
    expect(queryJsonPath(document, '$.data.works[*].status')).toEqual(['succeed', 'failed']);
  });

  it('applies an equality filter', () => {
    expect(
      queryJsonPath(document, "$.data.works[?(@.status=='succeed')].resource.resource"),
    ).toEqual(['https://cdn.example.test/a.mp4']);
  });

  it('descends recursively, in document order', () => {
    expect(queryJsonPath(document, '$..id')).toEqual(['sess-1', 'legacy-id', 'deep-1', 'deep-2']);
  });

  it('survives nulls, primitives and arrays at the root', () => {
    expect(selectJsonPath(null, '$.a')).toBeUndefined();
    expect(selectJsonPath('text', '$.a')).toBeUndefined();
    expect(selectJsonPath([{ id: 1 }], '$[0].id')).toBe(1);
    expect(selectJsonPath(document, '$')).toBe(document);
  });

  it('does not read inherited properties', () => {
    // A response is untrusted data; walking up its prototype chain would let a crafted
    // body answer questions about our own objects.
    expect(selectJsonPath({}, '$.constructor')).toBeUndefined();
    expect(selectJsonPath({}, '$.__proto__')).toBeUndefined();
    expect(selectJsonPath({ a: {} }, '$.a.toString')).toBeUndefined();
  });

  it('stops early when an intermediate step matches nothing', () => {
    expect(queryJsonPath(document, '$.missing[*].deep')).toEqual([]);
  });
});
