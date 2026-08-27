import type { FinishReason, OmniError, UMSEvent, Usage } from '@omniproxy/schema';
import { parseEmulatedToolCall, type EmulatedToolCall } from '@omniproxy/umr';

/**
 * The Gemini response surface, built from UMS and from nothing else.
 *
 * Google's stream is the simplest of the three: the same `GenerateContentResponse`
 * shape, again and again, each carrying the newest fragment. There is no sentinel and
 * no per-block framing, which means a client can only tell the stream ended because
 * the connection did — so the final chunk must carry `finishReason`, and it always
 * does here, including when the reason is a failure.
 */

export interface ResponseIdentity {
  /** Reported as `modelVersion`, which several clients log. */
  model: string;
}

export interface GenerateOptions {
  toolsOffered: boolean;
  /** Reasoning is emitted as a part marked `thought`, as Google's own models do. */
  includeThoughts?: boolean;
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args: unknown };
}

export interface GenerateContentResponse {
  candidates: {
    content: { role: 'model'; parts: GeminiPart[] };
    finishReason?: string;
    index: number;
    safetyRatings: never[];
  }[];
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  modelVersion: string;
  /** Warnings the caller should see. Not part of Google's schema; additive only. */
  omniproxy?: { warnings: { code: string; message: string }[]; estimatedTokens?: boolean };
}

/* ────────────────────────────── non-streaming ────────────────────────────── */

export function buildGenerateContentResponse(
  identity: ResponseIdentity,
  collected: {
    text: string;
    reasoning: string;
    finishReason: FinishReason;
    usage?: Usage;
    warnings: { code: string; message: string }[];
  },
  options: GenerateOptions,
  promptChars = 0,
): GenerateContentResponse {
  const warnings = [...collected.warnings];
  const toolCall = options.toolsOffered ? readToolCall(collected.text, warnings) : undefined;
  const parts: GeminiPart[] = [];

  if (!toolCall && options.includeThoughts && collected.reasoning !== '') {
    parts.push({ text: collected.reasoning, thought: true });
  }

  if (toolCall) {
    parts.push({ functionCall: { name: toolCall.name, args: parseArguments(toolCall.arguments) } });
  } else if (collected.text !== '') {
    parts.push({ text: collected.text });
  }

  // Never an empty parts array: clients read `candidates[0].content.parts[0].text`
  // without checking, and an empty one is the most common source of "undefined" in
  // somebody else's stack trace.
  if (parts.length === 0) parts.push({ text: '' });

  const usage = estimateUsage(promptChars, collected.text, collected.reasoning, collected.usage);
  const response: GenerateContentResponse = {
    candidates: [
      {
        content: { role: 'model', parts },
        finishReason: geminiFinish(collected.finishReason),
        index: 0,
        // Empty rather than invented: we ran no safety classifier, and reporting
        // ratings nobody computed would be a fabricated measurement.
        safetyRatings: [],
      },
    ],
    usageMetadata: usage,
    modelVersion: identity.model,
  };

  const estimated = collected.usage?.estimated !== false;
  if (warnings.length > 0 || estimated) {
    response.omniproxy = {
      warnings,
      ...(estimated ? { estimatedTokens: true } : {}),
    };
  }
  return response;
}

/* ──────────────────────────────── streaming ──────────────────────────────── */

export interface StreamOptions extends GenerateOptions {
  promptChars?: number;
}

/**
 * UMS as Gemini's `alt=sse` stream.
 *
 * Every chunk is a whole `GenerateContentResponse` carrying only the newest fragment;
 * the client concatenates them. Text is held back when tools were offered, for the
 * same reason as in the other two dialects: half a `TOOL_CALL:` marker is something no
 * client can act on, and a delta cannot be taken back once sent.
 */
export async function* toGeminiStream(
  events: AsyncIterable<UMSEvent>,
  identity: ResponseIdentity,
  options: StreamOptions,
): AsyncGenerator<string> {
  const buffering = options.toolsOffered;
  const warnings: { code: string; message: string }[] = [];
  const promptChars = options.promptChars ?? 0;

  let held = '';
  let text = '';
  let reasoning = '';
  let finish: FinishReason = 'stop';
  let usage: Usage | undefined;
  let failed: OmniError | undefined;
  let sent = false;

  const chunk = (parts: GeminiPart[], finishReason?: string): string => {
    sent = true;
    const payload: GenerateContentResponse = {
      candidates: [
        {
          content: { role: 'model', parts },
          ...(finishReason ? { finishReason } : {}),
          index: 0,
          safetyRatings: [],
        },
      ],
      usageMetadata: estimateUsage(promptChars, text, reasoning, usage),
      modelVersion: identity.model,
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  };

  for await (const event of events) {
    switch (event.type) {
      case 'reasoning.delta':
        reasoning += event.text;
        if (options.includeThoughts && event.text !== '') {
          yield chunk([{ text: event.text, thought: true }]);
        }
        break;

      case 'text.delta':
      case 'search.delta':
        text += event.text;
        if (buffering) {
          held += event.text;
          break;
        }
        if (event.text !== '') yield chunk([{ text: event.text }]);
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

  if (failed) {
    // Mid-stream: the status is already 200. Google's stream has no error frame, so
    // the failure travels as a final chunk with `finishReason: OTHER` and the error
    // beside it — a truncated stream with no explanation is the alternative, and every
    // client reports that as "the model stopped".
    const shaped = toGeminiError(failed);
    yield `data: ${JSON.stringify({
      candidates: [
        { content: { role: 'model', parts: [] }, finishReason: 'OTHER', index: 0, safetyRatings: [] },
      ],
      usageMetadata: estimateUsage(promptChars, text, reasoning, usage),
      modelVersion: identity.model,
      error: shaped.error,
    })}\n\n`;
    return;
  }

  if (buffering) {
    const toolCall = readToolCall(held, warnings);
    if (toolCall) {
      yield chunk(
        [{ functionCall: { name: toolCall.name, args: parseArguments(toolCall.arguments) } }],
        'STOP',
      );
      return;
    }

    if (options.includeThoughts && reasoning !== '') {
      yield chunk([{ text: reasoning, thought: true }]);
    }
    yield chunk([{ text: held }], geminiFinish(finish));
    return;
  }

  // The last chunk always carries the finish reason: without a sentinel, it is the
  // only way a client learns the stream ended rather than broke.
  yield chunk(sent ? [] : [{ text: '' }], geminiFinish(finish));
}

/* ──────────────────────────────── errors ──────────────────────────────── */

export interface GeminiErrorBody {
  error: {
    code: number;
    message: string;
    status: string;
    /** Additive: the thing the caller should actually do (invariant I-2). */
    action?: string;
    retryable?: string;
  };
}

export function toGeminiError(error: OmniError): GeminiErrorBody & { status: number } {
  const code = STATUS_BY_CODE[error.code] ?? 502;
  return {
    status: code,
    error: {
      code,
      message: error.message,
      status: REASON_BY_CODE[error.code] ?? 'UNKNOWN',
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
  upstream_unavailable: 503,
  internal: 500,
};

/** Google's canonical status strings, which client libraries switch on. */
const REASON_BY_CODE: Partial<Record<OmniError['code'], string>> = {
  auth_expired: 'UNAUTHENTICATED',
  auth_missing: 'UNAUTHENTICATED',
  challenge: 'PERMISSION_DENIED',
  content_filtered: 'INVALID_ARGUMENT',
  invalid_request: 'INVALID_ARGUMENT',
  context_too_long: 'INVALID_ARGUMENT',
  rate_limit: 'RESOURCE_EXHAUSTED',
  quota_exhausted: 'RESOURCE_EXHAUSTED',
  timeout: 'DEADLINE_EXCEEDED',
  canceled: 'CANCELLED',
  not_implemented: 'UNIMPLEMENTED',
  needs_capture: 'UNIMPLEMENTED',
  endpoint_gone: 'INTERNAL',
  upstream_schema_changed: 'INTERNAL',
  upstream_unavailable: 'UNAVAILABLE',
  internal: 'INTERNAL',
};

/* ──────────────────────────────── shared ──────────────────────────────── */

export function geminiFinish(reason: FinishReason): string {
  switch (reason) {
    case 'stop':
      return 'STOP';
    case 'length':
      return 'MAX_TOKENS';
    case 'content_filter':
      return 'SAFETY';
    case 'tool_calls':
      // Google has no separate reason for it: a function call ends the turn normally.
      return 'STOP';
    default:
      return 'OTHER';
  }
}

/**
 * Token counts, estimated and labelled as estimated.
 *
 * A provider web interface reports no usage. Four characters per token is the usual
 * rough figure for English and is worse for other scripts. `countTokens` returns the
 * same number and says in its own payload that it is an estimate — a client budgeting
 * against it deserves to know it is budgeting against arithmetic, not a tokenizer.
 */
export function estimateUsage(
  promptChars: number,
  text: string,
  reasoning: string,
  reported?: Usage,
): { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number } {
  const prompt = reported?.promptTokens ?? approxTokens(promptChars);
  const candidates = reported?.completionTokens ?? approxTokens(text.length + reasoning.length);
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: candidates,
    totalTokenCount: prompt + candidates,
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

/** `args` is an object here, as Google carries it structured. */
function parseArguments(json: string): unknown {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { _raw: json };
  }
}
