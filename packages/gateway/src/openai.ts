import type { ServerResponse } from 'node:http';
import {
  buildChatCompletion,
  flattenMessages,
  OpenAiRequestError,
  parseChatCompletionRequest,
  toOpenAiError,
  toOpenAiStream,
  type ChatCompletionRequest,
} from '@omniproxy/dialect-openai';
import { collectUms, type OmniError, type UMSEvent } from '@omniproxy/schema';
import type { DialectHooks, Refusal, RefusalKind, RequestPlan } from './dialect.js';
import { resolveRoute, RoutingError, type Route } from './router.js';

/** `POST /v1/chat/completions`. */
export const openAiDialect: DialectHooks<ChatCompletionRequest> = {
  name: 'openai',

  plan(body, providers) {
    let request: ChatCompletionRequest;
    let route: Route;
    try {
      request = parseChatCompletionRequest(body);
      route = resolveRoute(providers, request.model);
    } catch (error) {
      if (error instanceof OpenAiRequestError) {
        return refusal(error.status, {
          message: error.message,
          type: error.type,
          code: 'invalid_request',
          param: error.param ?? null,
          action: 'Check the request against the OpenAI Chat Completions schema.',
        });
      }
      if (error instanceof RoutingError) {
        return refusal(error.status, {
          message: error.message,
          type: 'invalid_request_error',
          code: 'model_not_found',
          param: 'model',
          action: error.userAction,
        });
      }
      throw error;
    }

    const { prompt, systemPrompt } = flattenMessages(request.messages, request.tools);
    const fullPrompt = systemPrompt === '' ? prompt : `${systemPrompt}\n\n${prompt}`;

    if (fullPrompt.trim() === '') {
      return refusal(400, {
        message: 'the conversation flattened to an empty prompt',
        type: 'invalid_request_error',
        code: 'invalid_request',
        param: 'messages',
        action: 'At least one message needs content a provider can be asked about.',
      });
    }

    return {
      kind: 'planned',
      request,
      route,
      prompt: fullPrompt,
      params: numericParams(request),
      stream: request.stream === true,
    } satisfies RequestPlan<ChatCompletionRequest>;
  },

  identity(uuid) {
    return { id: `chatcmpl-${uuid().replace(/-/g, '').slice(0, 24)}`, model: '' };
  },

  async respond(context) {
    const { plan, events, response, settle, promptChars } = context;
    const identity = {
      ...context.identity,
      model: plan.request.model,
      created: Math.floor(Date.now() / 1000),
    };
    const shape = {
      toolsOffered: (plan.request.tools?.length ?? 0) > 0,
      includeReasoning: plan.route.alias.includes('reason') || plan.route.alias.includes('think'),
    };

    if (plan.stream) {
      return streamCompletion(response, events, identity, {
        ...shape,
        provider: plan.route.provider.id,
        log: context.log,
        settle,
        asOmniError: context.asOmniError,
      });
    }

    try {
      const collected = await collectUms(events);
      settle(collected.error);
      if (collected.error) return sendError(response, collected.error);
      return sendJson(response, 200, buildChatCompletion(identity, collected, shape, promptChars));
    } catch (error) {
      const omni = context.asOmniError(error, plan.route.provider.id);
      settle(omni);
      return sendError(response, omni);
    }
  },

  error(error) {
    const shaped = toOpenAiError(error);
    return { status: shaped.status, body: { error: shaped.error } };
  },

  refuse(status, kind, message, action) {
    return refusal(status, {
      message,
      type: TYPE_BY_KIND[kind],
      code: CODE_BY_KIND[kind],
      param: null,
      action,
    });
  },
};

const TYPE_BY_KIND: Record<RefusalKind, string> = {
  invalid_request: 'invalid_request_error',
  too_large: 'invalid_request_error',
  not_found: 'invalid_request_error',
  authentication: 'authentication_error',
  rate_limit: 'rate_limit_error',
  api: 'api_error',
};

/** OpenAI's `code` is finer-grained than its `type`, and clients branch on it. */
const CODE_BY_KIND: Record<RefusalKind, string> = {
  invalid_request: 'invalid_request',
  too_large: 'invalid_request',
  not_found: 'not_found',
  authentication: 'invalid_api_key',
  rate_limit: 'rate_limit_exceeded',
  api: 'internal',
};

/* ─────────────────────────────────── streaming ─────────────────────────────────── */

interface StreamContext {
  toolsOffered: boolean;
  includeReasoning: boolean;
  provider: string;
  log(line: string): void;
  settle(error?: OmniError): void;
  asOmniError(error: unknown, provider: string): OmniError;
}

/**
 * Streams, and keeps streaming honestly when things go wrong.
 *
 * The moment the first byte is written the status is fixed at 200, so a later failure
 * cannot become a 500. It becomes a final chunk carrying the error and its action —
 * the difference between a client that reports "rate limited, try another account" and
 * one that reports a truncated response with no explanation.
 */
async function streamCompletion(
  response: ServerResponse,
  events: AsyncGenerator<UMSEvent>,
  identity: { id: string; created: number; model: string },
  context: StreamContext,
): Promise<void> {
  let failure: OmniError | undefined;
  const guarded = guard(events, context.provider, context.asOmniError, (error) => {
    failure = error;
  });

  let started = false;
  try {
    for await (const chunk of toOpenAiStream(guarded, identity, {
      toolsOffered: context.toolsOffered,
      includeReasoning: context.includeReasoning,
    })) {
      if (!started) {
        started = true;
        response.writeHead(200, EVENT_STREAM_HEADERS);
      }
      // Back-pressure. Without it a fast provider fills memory when the client is slow,
      // and the process dies with an allocation failure rather than a message.
      if (!response.write(chunk)) {
        await new Promise<void>((resolve) => response.once('drain', resolve));
      }
    }
  } catch (error) {
    failure = context.asOmniError(error, context.provider);
    context.log(
      `gateway: stream failed after ${started ? 'first byte' : 'nothing'}: ${String(error)}`,
    );
    if (!started) {
      context.settle(failure);
      return sendError(response, failure);
    }
  }

  context.settle(failure);
  response.end();
}

/**
 * Turns a thrown failure into a UMS error event, so the stream can carry it.
 *
 * Without this an exception mid-generator would abort the HTTP response with no body,
 * and every client in existence reports that as "the model stopped".
 */
export async function* guard(
  events: AsyncGenerator<UMSEvent>,
  provider: string,
  asOmniError: (error: unknown, provider: string) => OmniError,
  onError: (error: OmniError) => void,
): AsyncGenerator<UMSEvent> {
  try {
    for await (const item of events) {
      if (item.type === 'error') onError(item.error);
      yield item;
    }
  } catch (error) {
    const omni = asOmniError(error, provider);
    onError(omni);
    yield { type: 'error', error: omni };
  }
}

export const EVENT_STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

/* ──────────────────────────────────── plumbing ──────────────────────────────────── */

/** Numeric knobs a declaration may map onto provider fields. */
export function numericParams(request: ChatCompletionRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (request.temperature !== undefined) params['temperature'] = request.temperature;
  if (request.top_p !== undefined) params['topP'] = request.top_p;
  const maxTokens = request.max_completion_tokens ?? request.max_tokens;
  if (maxTokens !== undefined) params['maxTokens'] = maxTokens;
  if (request.stop !== undefined) params['stop'] = request.stop;
  return params;
}

function refusal(status: number, error: Record<string, unknown>): Refusal {
  return { kind: 'refused', status, body: { error } };
}

function sendError(response: ServerResponse, error: OmniError): void {
  const shaped = toOpenAiError(error);
  const headers =
    typeof error.retryAfterMs === 'number'
      ? { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) }
      : {};
  sendJson(response, shaped.status, { error: shaped.error }, headers);
}

export function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}
