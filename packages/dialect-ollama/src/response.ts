import type { FinishReason, OmniError, UMSEvent, Usage } from '@omniproxy/schema';
import { parseEmulatedToolCall, type EmulatedToolCall } from '@omniproxy/umr';

/**
 * The Ollama response surface, built from UMS and from nothing else.
 *
 * The wire format is **NDJSON**: one JSON object per line, no `data:` prefix, no blank
 * line between records. Clients read it with a line reader, so a stray blank line or a
 * pretty-printed object breaks them — which is why everything below is serialised on
 * one line and terminated with exactly one newline.
 *
 * The `*_duration` fields are nanoseconds. They are reported because clients divide by
 * them to show tokens per second, and a missing field there produces `NaN` in somebody
 * else's progress display.
 */

export interface ResponseIdentity {
  model: string;
  /** ISO timestamp, injectable so tests are not at the mercy of the clock. */
  createdAt: string;
}

export interface OllamaOptions {
  toolsOffered: boolean;
  /** `/api/generate` puts the answer in `response`; `/api/chat` puts it in `message`. */
  endpoint: 'chat' | 'generate';
  includeThinking?: boolean;
  promptChars?: number;
  /** Nanoseconds the request took, for the duration fields clients divide by. */
  durationNs?: number;
}

export interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}

export interface OllamaRecord {
  model: string;
  created_at: string;
  message?: {
    role: 'assistant';
    content: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
  response?: string;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  /** Warnings the caller should see. Not part of Ollama's schema; additive only. */
  omniproxy?: { warnings: { code: string; message: string }[] };
}

/* ────────────────────────────── non-streaming ────────────────────────────── */

export function buildOllamaResponse(
  identity: ResponseIdentity,
  collected: {
    text: string;
    reasoning: string;
    finishReason: FinishReason;
    usage?: Usage;
    warnings: { code: string; message: string }[];
  },
  options: OllamaOptions,
): OllamaRecord {
  const warnings = [...collected.warnings];
  const toolCall = options.toolsOffered ? readToolCall(collected.text, warnings) : undefined;

  const record: OllamaRecord = {
    model: identity.model,
    created_at: identity.createdAt,
    done: true,
    done_reason: ollamaDoneReason(toolCall ? 'tool_calls' : collected.finishReason),
    ...durations(options),
    ...counts(collected, options),
  };

  if (options.endpoint === 'generate') {
    // The older endpoint has no message envelope and no tool calling. A tool call there
    // would have nowhere to go, so the text is returned as it came.
    record.response = collected.text;
  } else if (toolCall) {
    record.message = {
      role: 'assistant',
      // Empty, not the raw markup: a client that renders content would show the model's
      // tool syntax to a user, and one that parses it would see the call twice.
      content: '',
      tool_calls: [
        { function: { name: toolCall.name, arguments: parseArguments(toolCall.arguments) } },
      ],
    };
  } else {
    record.message = { role: 'assistant', content: collected.text };
    if (options.includeThinking && collected.reasoning !== '') {
      record.message.thinking = collected.reasoning;
    }
  }

  if (warnings.length > 0) record.omniproxy = { warnings };
  return record;
}

/* ──────────────────────────────── streaming ──────────────────────────────── */

/**
 * UMS as Ollama's NDJSON stream.
 *
 * Each record carries only the newest fragment and `done: false`; the final record
 * carries `done: true`, the reason and the counts. Clients stop reading on `done`, so
 * a stream that never sends it hangs — including the failure path, which is why an
 * error still ends with a done record rather than a closed socket.
 *
 * Text is held back when tools were offered, for the same reason as in every other
 * dialect: half a `TOOL_CALL:` marker is something no client can act on.
 */
export async function* toOllamaStream(
  events: AsyncIterable<UMSEvent>,
  identity: ResponseIdentity,
  options: OllamaOptions,
): AsyncGenerator<string> {
  const buffering = options.toolsOffered;
  const warnings: { code: string; message: string }[] = [];

  let held = '';
  let text = '';
  let reasoning = '';
  let finish: FinishReason = 'stop';
  let usage: Usage | undefined;
  let failed: OmniError | undefined;

  const fragment = (content: string, thinking?: string): string =>
    line({
      model: identity.model,
      created_at: identity.createdAt,
      ...(options.endpoint === 'generate'
        ? { response: content }
        : {
            message: {
              role: 'assistant' as const,
              content,
              ...(thinking !== undefined ? { thinking } : {}),
            },
          }),
      done: false,
    });

  for await (const event of events) {
    switch (event.type) {
      case 'reasoning.delta':
        reasoning += event.text;
        if (options.includeThinking && options.endpoint === 'chat' && event.text !== '') {
          yield fragment('', event.text);
        }
        break;

      case 'text.delta':
      case 'search.delta':
        text += event.text;
        if (buffering) {
          held += event.text;
          break;
        }
        if (event.text !== '') yield fragment(event.text);
        break;

      case 'usage':
        usage = event.usage;
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

      default:
        break;
    }

    if (failed) break;
  }

  const collected = { text, reasoning, finishReason: finish, warnings, ...(usage ? { usage } : {}) };

  if (failed) {
    // The status is already 200. Ollama's stream has no error record, but it does have
    // an `error` field clients check, and it must still be a `done` record or the
    // client goes on waiting for one.
    yield line({
      model: identity.model,
      created_at: identity.createdAt,
      ...(options.endpoint === 'generate' ? { response: '' } : { message: { role: 'assistant' as const, content: '' } }),
      done: true,
      done_reason: 'error',
      error: failed.message,
      action: failed.userAction,
      ...durations(options),
      ...counts(collected, options),
    });
    return;
  }

  if (buffering) {
    const toolCall = readToolCall(held, warnings);
    if (toolCall) {
      // Nothing was streamed, so the whole record arrives at once — content included.
      yield line(buildOllamaResponse(identity, { ...collected, finishReason: 'tool_calls' }, options));
      return;
    }
    if (held !== '') yield fragment(held);
  }

  // The closing record carries the reason and the counts, and **empty** content: the
  // fragments already carried the text, and a client that concatenates every record it
  // receives — which is what they do — would otherwise show the answer twice.
  const done = buildOllamaResponse(identity, collected, options);
  if (done.message) done.message = { role: 'assistant', content: '' };
  if (done.response !== undefined) done.response = '';
  yield line(done);
}

/**
 * One NDJSON record.
 *
 * Exactly one newline and no pretty-printing: clients read this with a line reader,
 * and a record spread over several lines is a parse error on every one of them.
 */
function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

/* ──────────────────────────────── errors ──────────────────────────────── */

export interface OllamaErrorBody {
  /** Ollama's whole error contract: a string under `error`. */
  error: string;
  /** Additive: the thing the caller should actually do (invariant I-2). */
  action?: string;
  code?: string;
}

export function toOllamaError(error: OmniError): OllamaErrorBody & { status: number } {
  return {
    status: STATUS_BY_CODE[error.code] ?? 502,
    error: error.message,
    action: error.userAction,
    code: error.code,
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
  upstream_unavailable: 503,
  internal: 500,
};

/* ──────────────────────────────── shared ──────────────────────────────── */

export function ollamaDoneReason(reason: FinishReason): string {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      // Ollama has no separate reason: a tool call ends the turn normally, and the
      // `tool_calls` array is how the client knows.
      return 'stop';
    case 'content_filter':
      return 'stop';
    default:
      return 'error';
  }
}

/**
 * The duration fields, in nanoseconds.
 *
 * Reported because clients divide by them to show tokens per second. A missing field
 * there produces `NaN` in somebody else's progress display, and a zero produces
 * `Infinity`, so the floor is one nanosecond rather than none.
 */
function durations(options: OllamaOptions): Partial<OllamaRecord> {
  const total = Math.max(1, Math.round((options.durationNs ?? 0) || 1));
  return {
    total_duration: total,
    // We do not load a model, so there is nothing honest to report but the smallest
    // non-zero value.
    load_duration: 1,
    prompt_eval_duration: 1,
    eval_duration: total,
  };
}

/** Token counts, estimated the same way every count in this project is. */
function counts(
  collected: { text: string; reasoning: string; usage?: Usage },
  options: OllamaOptions,
): Partial<OllamaRecord> {
  return {
    prompt_eval_count:
      collected.usage?.promptTokens ?? approxTokens(options.promptChars ?? 0),
    eval_count:
      collected.usage?.completionTokens ??
      approxTokens(collected.text.length + collected.reasoning.length),
  };
}

export function approxTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / 4));
}

function readToolCall(
  text: string,
  warnings: { code: string; message: string }[],
): EmulatedToolCall | undefined {
  const parsed = parseEmulatedToolCall(text);
  if (parsed.unparsed) warnings.push({ code: 'tool_call_unparsed', message: parsed.unparsed });
  return parsed.call;
}

/** Arguments as an object, since Ollama carries them structured. */
function parseArguments(json: string): unknown {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { _raw: json };
  }
}
