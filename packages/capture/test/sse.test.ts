import { describe, expect, it } from 'vitest';
import { isEventStream, parseSseFrame, parseSseStream } from '../src/sse.js';

describe('parseSseStream', () => {
  it('splits on blank lines and keeps the raw frame alongside the parsed fields', () => {
    const frames = parseSseStream('event: message\ndata: {"a":1}\n\ndata: [DONE]\n\n');

    expect(frames).toHaveLength(2);
    expect(frames[0]?.event).toBe('message');
    expect(frames[0]?.data).toBe('{"a":1}');
    expect(frames[0]?.raw).toBe('event: message\ndata: {"a":1}');
    expect(frames[1]?.data).toBe('[DONE]');
  });

  it('handles CRLF line endings', () => {
    const frames = parseSseStream('data: one\r\n\r\ndata: two\r\n\r\n');
    expect(frames.map((f) => f.data)).toEqual(['one', 'two']);
  });

  it('joins multi-line data with newlines, as the SSE spec requires', () => {
    const frames = parseSseStream('data: line one\ndata: line two\n\n');
    expect(frames[0]?.data).toBe('line one\nline two');
  });

  it('accepts a field with no space after the colon', () => {
    const frames = parseSseStream('data:{"tight":true}\n\n');
    expect(frames[0]?.data).toBe('{"tight":true}');
  });

  it('keeps comment-only frames, because a heartbeat is a real signal', () => {
    const frames = parseSseStream('data: one\n\n: keep-alive\n\ndata: two\n\n');
    expect(frames).toHaveLength(3);
    expect(frames[1]?.data).toBeUndefined();
    expect(frames[1]?.raw).toBe(': keep-alive');
  });

  it('keeps a trailing frame that was never terminated', () => {
    // A capture can end mid-stream. Dropping the last frame would hide exactly that.
    const frames = parseSseStream('data: one\n\ndata: trunca');
    expect(frames).toHaveLength(2);
    expect(frames[1]?.data).toBe('trunca');
  });

  it('returns nothing for an empty or whitespace-only body', () => {
    expect(parseSseStream('')).toEqual([]);
    expect(parseSseStream('\n\n\n')).toEqual([]);
  });

  it('carries the supplied arrival time onto every frame', () => {
    const frames = parseSseStream('data: one\n\n', { at: 42 });
    expect(frames[0]?.at).toBe(42);
  });

  it('reports a null arrival time when the source does not know it', () => {
    expect(parseSseFrame('data: one').at).toBeNull();
  });

  it('reads the id field', () => {
    expect(parseSseFrame('id: 7\ndata: x').id).toBe('7');
  });
});

describe('isEventStream', () => {
  it('recognises the content type with and without parameters', () => {
    expect(isEventStream('text/event-stream')).toBe(true);
    expect(isEventStream('text/event-stream; charset=utf-8')).toBe(true);
    expect(isEventStream('TEXT/EVENT-STREAM')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isEventStream('application/json')).toBe(false);
    expect(isEventStream(undefined)).toBe(false);
    expect(isEventStream('')).toBe(false);
  });
});
