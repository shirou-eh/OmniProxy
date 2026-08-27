import type { FinishReason, OmniError, UMSEvent, Usage } from '@omniproxy/schema';
import { parseEmulatedToolCall, type EmulatedToolCall } from '@omniproxy/umr';

/**
 * The Anthropic Messages response surface, built from UMS and from nothing else.
 *
 * The same universal stream drives the OpenAI dialect. A provider quirk that reaches
 * this file is a bug in the engine, not something to special-case here.
 *
 * Anthropic's stream is more structured than OpenAI's: content arrives as numbered
 * blocks that are opened, filled and closed, and the message's stop reason arrives in
 * its own event at the end. That structure is the reason this file is longer than its
 * OpenAI counterpart, and it is worth matching exactly — clients index into those
 * blocks, and one that never receives a `content_block_stop` waits forever.
 */

export interface ResponseIdentity {
  id: string;
  model: string;
}

export interface MessageOptions {
  /** Tools were offered, so a tool call in the text should be read as one. */
  toolsOffered: boolean;
  /** The caller asked for extended thinking, so reasoning is worth emitting. */
  includeThinking?: boolean;
}

/* ────────────────────────────── non-streaming ────────────────────────────── */

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
  /** Warnings the caller should see. Not part of Anthropic's schema; additive only. */
  omniproxy?: { warnings: { code: string; message: string }[] };
}

export function buildMessageResponse(
  identity: ResponseIdentity,
  collected: {
    text: string;
    reasoning: string;
    finishReason: FinishReason;
    usage?: Usage;
    warnings: { code: string; message: string }[];
  },
  options: MessageOptions,
  promptChars = 0,
): AnthropicMessageResponse {
  const warnings = [...collected.warnings];
  const toolCall = options.toolsOffered ? readToolCall(collected.text, warnings) : undefined;
  const content: AnthropicContentBlock[] = [];

  // Thinking first, as the real API orders it. Never on a tool-call turn: several
  // agent clients treat any text payload as a final answer and stop their tool loop.
  if (!toolCall && options.includeThinking && collected.reasoning !== '') {
    content.push({ type: 'thinking', thinking: collected.reasoning });
  }

  if (toolCall) {
    content.push({
      type: 'tool_use',
      id: toolUseId(identity),
      name: toolCall.name,
      // An object, not a string: this is where the two dialects genuinely differ, and
      // a client that receives a string here throws while parsing its own response.
      input: parseArguments(toolCall.arguments),
    });
  } else if (collected.text !== '') {
    content.push({ type: 'text', text: collected.text });
  }

  // Never an empty array: the Messages API always carries at least one block, and
  // clients index `content[0]` without checking.
  if (content.length === 0) content.push({ type: 'text', text: '' });

  const usage = estimateUsage(promptChars, collected.text, collected.reasoning, collected.usage);
  const response: AnthropicMessageResponse = {
    id: identity.id,
    type: 'message',
    role: 'assistant',
    content,
    model: identity.model,
    stop_reason: toolCall ? 'tool_use' : anthropicStop(collected.finishReason),
    stop_sequence: null,
    usage,
  };

  if (warnings.length > 0) response.omniproxy = { warnings };
  return response;
}

/* ──────────────────────────────── streaming ──────────────────────────────── */

export interface StreamOptions extends MessageOptions {
  promptChars?: number;
}

/**
 * UMS as Anthropic's SSE event sequence.
 *
 * Text is held back when tools were offered, for the same reason as in the OpenAI
 * dialect: once a delta has gone out it cannot be taken back, and a client that
 * received half a `TOOL_CALL:` marker has been handed something it cannot act on. The
 * cost is real — no token-by-token streaming for tool-enabled requests — and it is the
 * honest one.
 *
 * Note on `thinking` blocks: no `signature` is emitted, because we cannot produce one.
 * Such a block is fine to display and must not be replayed to api.anthropic.com, which
 * would reject it. That is recorded here rather than papered over with a made-up value.
 */
export async function* toAnthropicStream(
  events: AsyncIterable<UMSEvent>,
  identity: ResponseIdentity,
  options: StreamOptions,
): AsyncGenerator<string> {
  const buffering = options.toolsOffered;
  const warnings: { code: string; message: string }[] = [];

  let held = '';
  let reasoning = '';
  let text = '';
  let finish: FinishReason = 'stop';
  let usage: Usage | undefined;
  let failed: OmniError | undefined;

  /** Which block index is open, and of what kind. -1 means none. */
  let openIndex = -1;
  let openKind: 'text' | 'thinking' | null = null;
  let nextIndex = 0;

  yield event('message_start', {
    type: 'message_start',
    message: {
      id: identity.id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: identity.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: approxTokens(options.promptChars ?? 0), output_tokens: 0 },
    },
  });

  const closeBlock = function* (): Generator<string> {
    if (openIndex >= 0) {
      yield event('content_block_stop', { type: 'content_block_stop', index: openIndex });
      openIndex = -1;
      openKind = null;
    }
  };

  const openBlock = function* (kind: 'text' | 'thinking'): Generator<string> {
    if (openKind === kind) return;
    yield* closeBlock();
    openIndex = nextIndex;
    nextIndex += 1;
    openKind = kind;
    yield event('content_block_start', {
      type: 'content_block_start',
      index: openIndex,
      content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
    });
  };

  for await (const item of events) {
    switch (item.type) {
      case 'reasoning.delta':
        reasoning += item.text;
        if (!options.includeThinking || item.text === '') break;
        yield* openBlock('thinking');
        yield event('content_block_delta', {
          type: 'content_block_delta',
          index: openIndex,
          delta: { type: 'thinking_delta', thinking: item.text },
        });
        break;

      case 'text.delta':
      case 'search.delta':
        text += item.text;
        if (buffering) {
          held += item.text;
          break;
        }
        if (item.text === '') break;
        yield* openBlock('text');
        yield event('content_block_delta', {
          type: 'content_block_delta',
          index: openIndex,
          delta: { type: 'text_delta', text: item.text },
        });
        break;

      case 'usage':
        usage = item.usage;
        break;

      case 'warning':
        warnings.push({ code: item.code, message: item.message });
        break;

      case 'error':
        failed = item.error;
        break;

      case 'done':
        finish = item.finishReason;
        break;

      default:
        break;
    }

    if (failed) break;
  }

  if (failed) {
    // Mid-stream: the status is already 200 and cannot be taken back, so the failure
    // travels as Anthropic's own error event rather than as a truncated stream.
    yield* closeBlock();
    yield event('error', { type: 'error', error: toAnthropicError(failed).error });
    return;
  }

  if (buffering) {
    const toolCall = readToolCall(held, warnings);
    if (toolCall) {
      const index = nextIndex;
      nextIndex += 1;
      yield event('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: toolUseId(identity), name: toolCall.name, input: {} },
      });
      // The whole argument object in one delta. Splitting it would be theatre: it was
      // never streamed by the provider, it was recognised after the fact.
      yield event('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: toolCall.arguments },
      });
      yield event('content_block_stop', { type: 'content_block_stop', index });
      yield* finishEvents('tool_use', usage, text, reasoning, options);
      return;
    }

    if (options.includeThinking && reasoning !== '') {
      yield* openBlock('thinking');
      yield event('content_block_delta', {
        type: 'content_block_delta',
        index: openIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      });
    }
    yield* openBlock('text');
    yield event('content_block_delta', {
      type: 'content_block_delta',
      index: openIndex,
      delta: { type: 'text_delta', text: held },
    });
  }

  if (nextIndex === 0) {
    // Nothing arrived at all. A message with no content block is one every client
    // mis-parses, so an empty text block is opened and closed.
    yield* openBlock('text');
  }

  yield* closeBlock();
  yield* finishEvents(anthropicStop(finish), usage, text, reasoning, options);

  function* finishEvents(
    stopReason: string | null,
    finalUsage: Usage | undefined,
    finalText: string,
    finalReasoning: string,
    streamOptions: StreamOptions,
  ): Generator<string> {
    const counted = estimateUsage(
      streamOptions.promptChars ?? 0,
      finalText,
      finalReasoning,
      finalUsage,
    );
    yield event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: counted.output_tokens },
    });
    yield event('message_stop', { type: 'message_stop' });
  }
}

/**
 * One SSE frame.
 *
 * Anthropic's stream names the event on its own line, and clients dispatch on that
 * name rather than on the payload's `type`. Sending only `data:` would parse and then
 * silently do nothing.
 */
function event(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/* ──────────────────────────────── errors ──────────────────────────────── */

export interface AnthropicErrorBody {
  type: 'error';
  error: {
    type: string;
    message: string;
    /** Additive: the thing the caller should actually do (invariant I-2). */
    action?: string;
    retryable?: string;
  };
}

export function toAnthropicError(error: OmniError): AnthropicErrorBody & { status: number } {
  return {
    status: STATUS_BY_CODE[error.code] ?? 502,
    type: 'error',
    error: {
      type: TYPE_BY_CODE[error.code] ?? 'api_error',
      message: error.message,
      action: error.userAction,
      retryable: error.retryable,
    },
  };
}

const STATUS_BY_CODE: Partial<Record<OmniError['code'], number>> = {
  auth_expired: 401,
  auth_missing: 401,
  challenge: 403,
  content_filtered: 400,
  invalid_request: 400,
  context_too_long: 400,
  rate_limit: 429,
  quota_exhausted: 429,
  timeout: 504,
  canceled: 499,
  not_implemented: 501,
  needs_capture: 501,
  endpoint_gone: 502,
  upstream_schema_changed: 502,
  upstream_unavailable: 529,
  internal: 500,
};

const TYPE_BY_CODE: Partial<Record<OmniError['code'], string>> = {
  auth_expired: 'authentication_error',
  auth_missing: 'authentication_error',
  challenge: 'permission_error',
  content_filtered: 'invalid_request_error',
  invalid_request: 'invalid_request_error',
  context_too_long: 'invalid_request_error',
  rate_limit: 'rate_limit_error',
  quota_exhausted: 'rate_limit_error',
  timeout: 'api_error',
  canceled: 'api_error',
  not_implemented: 'invalid_request_error',
  needs_capture: 'invalid_request_error',
  endpoint_gone: 'api_error',
  upstream_schema_changed: 'api_error',
  // The one Anthropic-specific code worth using: it means "try again later", and
  // clients back off on it rather than treating it as a bug in their request.
  upstream_unavailable: 'overloaded_error',
  internal: 'api_error',
};

/* ──────────────────────────────── shared ──────────────────────────────── */

export function anthropicStop(reason: FinishReason): string | null {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      // No Anthropic equivalent. `end_turn` with a warning is closer to the truth than
      // inventing a stop reason no client knows.
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/**
 * Token counts, estimated and labelled as estimated.
 *
 * A provider web interface reports no usage. Four characters per token is the usual
 * rough figure for English and is worse for other scripts; the number exists so that
 * clients which divide by it do not divide by zero, not because it is accurate.
 */
export function estimateUsage(
  promptChars: number,
  text: string,
  reasoning: string,
  reported?: Usage,
): { input_tokens: number; output_tokens: number } {
  return {
    input_tokens: reported?.promptTokens ?? approxTokens(promptChars),
    output_tokens: reported?.completionTokens ?? approxTokens(text.length + reasoning.length),
  };
}

function approxTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

function readToolCall(
  text: string,
  warnings: { code: string; message: string }[],
): EmulatedToolCall | undefined {
  const parsed = parseEmulatedToolCall(text);
  if (parsed.unparsed) {
    warnings.push({ code: 'tool_call_unparsed', message: parsed.unparsed });
  }
  return parsed.call;
}

/**
 * A tool-use id derived from the message id.
 *
 * Deterministic on purpose: a retried request that produces the same call produces the
 * same id, and a client keyed on it does not accumulate duplicates.
 */
function toolUseId(identity: ResponseIdentity): string {
  return `toolu_${identity.id.replace(/[^A-Za-z0-9]/g, '').slice(-24) || 'omniproxy'}`;
}

/** Arguments as an object, since Anthropic carries `input` structured. */
function parseArguments(json: string): unknown {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    // Unparseable arguments reach the client as their raw text rather than being
    // dropped: a client that can see what the model actually said can report it.
    return { _raw: json };
  }
}
