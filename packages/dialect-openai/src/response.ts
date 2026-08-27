import type { FinishReason, OmniError, UMSEvent, Usage } from '@omniproxy/schema';
import { parseEmulatedToolCall, type EmulatedToolCall } from '@omniproxy/umr';

/**
 * The OpenAI response surface, built from UMS and from nothing else.
 *
 * That restriction is the point of having a universal stream at all: a provider quirk
 * that reaches this file is a bug in the engine, not something to special-case here.
 * The same UMS drives the Anthropic and Gemini dialects when they land, which is why a
 * fix to reasoning handling or finish reasons has to happen once rather than three
 * times.
 */

export interface ResponseIdentity {
  id: string;
  created: number;
  model: string;
}

export interface CompletionOptions {
  /** Tools were offered, so a tool call in the text should be read as one. */
  toolsOffered: boolean;
  /** Include `reasoning_content` on deltas, as several clients now expect. */
  includeReasoning?: boolean;
}

/* ────────────────────────────── non-streaming ────────────────────────────── */

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** Warnings the caller should see. Not part of OpenAI's schema; additive only. */
  omniproxy?: { warnings: { code: string; message: string }[] };
}

export function buildChatCompletion(
  identity: ResponseIdentity,
  collected: {
    text: string;
    reasoning: string;
    finishReason: FinishReason;
    usage?: Usage;
    warnings: { code: string; message: string }[];
  },
  options: CompletionOptions,
  promptChars = 0,
): ChatCompletion {
  const warnings = [...collected.warnings];
  const toolCall = options.toolsOffered ? readToolCall(collected.text, warnings) : undefined;

  const message: ChatCompletion['choices'][number]['message'] = toolCall
    ? {
        role: 'assistant',
        // Null, not the raw markup: a client that renders content would show the
        // model's tool syntax to a user, and one that parses it would see both.
        content: null,
        tool_calls: [
          { id: toolCallId(identity), type: 'function', function: toolCall },
        ],
      }
    : { role: 'assistant', content: collected.text };

  // Reasoning is deliberately not attached to a tool-call turn: several agent clients
  // treat any text payload as a final answer and stop their tool loop.
  if (!toolCall && options.includeReasoning && collected.reasoning !== '') {
    message.reasoning_content = collected.reasoning;
  }

  const completion: ChatCompletion = {
    id: identity.id,
    object: 'chat.completion',
    created: identity.created,
    model: identity.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCall ? 'tool_calls' : openAiFinish(collected.finishReason),
      },
    ],
    usage: estimateUsage(promptChars, collected.text, collected.reasoning, collected.usage),
  };

  if (warnings.length > 0) completion.omniproxy = { warnings };
  return completion;
}

/* ──────────────────────────────── streaming ──────────────────────────────── */

export interface StreamOptions extends CompletionOptions {
  /** Emitted after the final chunk. OpenAI clients expect it. */
  doneSentinel?: boolean;
}

/**
 * UMS to `data:` lines.
 *
 * Text is held back when tools were offered, because a tool call has to be recognised
 * before anything is sent: once a delta has gone out it cannot be taken back, and a
 * client that received half a `TOOL_CALL:` marker as content has been given something
 * it cannot act on. This is a real cost — no streaming for tool-enabled requests — and
 * it is the honest one. Guessing mid-stream produces a client that sometimes shows the
 * user raw markup, which is worse than being slower.
 */
export async function* toOpenAiStream(
  events: AsyncIterable<UMSEvent>,
  identity: ResponseIdentity,
  options: StreamOptions,
): AsyncGenerator<string> {
  const buffering = options.toolsOffered;
  let held = '';
  let reasoning = '';
  let finish: FinishReason = 'stop';
  let sentRole = false;
  const warnings: { code: string; message: string }[] = [];
  let failed: OmniError | undefined;

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
    `data: ${JSON.stringify({
      id: identity.id,
      object: 'chat.completion.chunk',
      created: identity.created,
      model: identity.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break;

      case 'text.delta':
        if (buffering) {
          held += event.text;
          break;
        }
        if (!sentRole) {
          sentRole = true;
          yield chunk({ role: 'assistant', content: event.text });
        } else {
          yield chunk({ content: event.text });
        }
        break;

      case 'reasoning.delta':
        reasoning += event.text;
        if (!buffering && options.includeReasoning) {
          if (!sentRole) {
            sentRole = true;
            yield chunk({ role: 'assistant', reasoning_content: event.text });
          } else {
            yield chunk({ reasoning_content: event.text });
          }
        }
        break;

      case 'search.delta':
        // Search text is part of the answer for providers that emit it separately.
        if (buffering) held += event.text;
        else {
          if (!sentRole) sentRole = true;
          yield chunk({ content: event.text });
        }
        break;

      case 'tool_call.delta':
        // A provider with native tool calling. Passed through as OpenAI shapes it.
        yield chunk({
          tool_calls: [
            {
              index: event.index,
              ...(event.id ? { id: event.id } : {}),
              type: 'function',
              function: {
                ...(event.name ? { name: event.name } : {}),
                ...(event.argsDelta ? { arguments: event.argsDelta } : {}),
              },
            },
          ],
        });
        break;

      case 'warning':
        warnings.push({ code: event.code, message: event.message });
        break;

      case 'error':
        failed = event.error;
        break;

      case 'done':
        finish = event.finishReason;
        break;

      case 'usage':
        break;
    }
  }

  if (failed) {
    // An error mid-stream cannot become an HTTP status — the headers are long gone —
    // so it goes out as a final chunk a client can surface, with the action attached.
    yield `data: ${JSON.stringify({
      id: identity.id,
      object: 'chat.completion.chunk',
      created: identity.created,
      model: identity.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
      error: toOpenAiError(failed).error,
    })}\n\n`;
    if (options.doneSentinel !== false) yield 'data: [DONE]\n\n';
    return;
  }

  if (buffering) {
    const toolCall = readToolCall(held, warnings);
    if (toolCall) {
      yield chunk({
        role: 'assistant',
        content: null,
        tool_calls: [
          { index: 0, id: toolCallId(identity), type: 'function', function: toolCall },
        ],
      });
      yield chunk({}, 'tool_calls');
      if (options.doneSentinel !== false) yield 'data: [DONE]\n\n';
      return;
    }

    const delta: Record<string, unknown> = { role: 'assistant', content: held };
    if (options.includeReasoning && reasoning !== '') delta['reasoning_content'] = reasoning;
    yield chunk(delta);
  }

  if (!sentRole && !buffering) yield chunk({ role: 'assistant', content: '' });
  yield chunk({}, openAiFinish(finish));
  if (options.doneSentinel !== false) yield 'data: [DONE]\n\n';
}

/* ──────────────────────────────── errors ──────────────────────────────── */

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    code: string;
    param: null;
    /** Additive: the thing the caller should actually do (invariant I-2). */
    action?: string;
    retryable?: string;
  };
}

/** An OmniError as OpenAI shapes errors, with the action kept rather than dropped. */
export function toOpenAiError(error: OmniError): OpenAiErrorBody & { status: number } {
  const status = STATUS_BY_CODE[error.code] ?? 502;
  return {
    status,
    error: {
      message: error.message,
      type: TYPE_BY_CODE[error.code] ?? 'api_error',
      code: error.code,
      param: null,
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
  upstream_unavailable: 502,
  internal: 500,
};

const TYPE_BY_CODE: Partial<Record<OmniError['code'], string>> = {
  auth_expired: 'authentication_error',
  auth_missing: 'authentication_error',
  challenge: 'permission_error',
  invalid_request: 'invalid_request_error',
  context_too_long: 'invalid_request_error',
  content_filtered: 'invalid_request_error',
  rate_limit: 'rate_limit_error',
  quota_exhausted: 'rate_limit_error',
  not_implemented: 'not_implemented_error',
  needs_capture: 'not_implemented_error',
};

/* ──────────────────────────────── helpers ──────────────────────────────── */

function readToolCall(
  text: string,
  warnings: { code: string; message: string }[],
): EmulatedToolCall | undefined {
  const parse = parseEmulatedToolCall(text);
  if (parse.unparsed) {
    // Said out loud rather than swallowed: "the model tried to call a tool and we
    // could not read it" is a diagnosable complaint; silence is not.
    warnings.push({ code: 'tool_call_unparsed', message: parse.unparsed });
  }
  return parse.call;
}

function toolCallId(identity: ResponseIdentity): string {
  return `call_${identity.id.replace(/^chatcmpl-/, '')}`;
}

export function openAiFinish(reason: FinishReason): string {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case 'canceled':
    case 'error':
      // OpenAI has no code for either. `stop` is the least wrong: the alternative is
      // a value clients do not handle, and the real news is in the error body.
      return 'stop';
    default:
      return 'stop';
  }
}

/**
 * Token counts, estimated and labelled as estimated.
 *
 * Provider web interfaces do not report token usage, so any number here is arithmetic
 * on character counts. Four characters per token is the usual rough figure for English
 * and wrong for most other languages. It is reported because clients break without the
 * field, and `usage.estimated` upstream is what says not to bill anyone on it.
 */
export function estimateUsage(
  promptChars: number,
  completion: string,
  reasoning: string,
  reported?: Usage,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const prompt = reported?.promptTokens ?? Math.ceil(promptChars / 4);
  const output =
    reported?.completionTokens ?? Math.ceil((completion.length + reasoning.length) / 4);
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output };
}
