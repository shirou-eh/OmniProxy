import type { ServerResponse } from 'node:http';
import {
  AnthropicRequestError,
  buildMessageResponse,
  flattenRequest,
  parseMessagesRequest,
  toAnthropicError,
  toAnthropicStream,
  universalParams,
  wantsThinking,
  type MessagesRequest,
} from '@omniproxy/dialect-anthropic';
import { collectUms, type OmniError } from '@omniproxy/schema';
import { RoutingError, resolveRoute, type Route } from './router.js';
import type { DialectHooks, RefusalKind, RequestPlan } from './dialect.js';

/**
 * `POST /v1/messages`.
 *
 * Everything upstream of this file is shared with the OpenAI endpoint: routing,
 * accounts, the concurrency gate, the retry rule, the engine. What differs is the
 * shape of the request coming in and the shape of the events going out, and that is
 * exactly as much as should differ. If serving a second dialect had required touching
 * the request loop, the universal layers would not be earning their keep.
 */
export const anthropicDialect: DialectHooks<MessagesRequest> = {
  name: 'anthropic',

  plan(body, providers) {
    let request: MessagesRequest;
    let route: Route;
    try {
      request = parseMessagesRequest(body);
      route = resolveRoute(providers, request.model);
    } catch (error) {
      if (error instanceof AnthropicRequestError) {
        return {
          kind: 'refused',
          status: error.status,
          body: {
            type: 'error',
            error: {
              type: error.type,
              message: error.message,
              action: 'Check the request against the Anthropic Messages schema.',
            },
          },
        };
      }
      if (error instanceof RoutingError) {
        return {
          kind: 'refused',
          status: error.status,
          body: {
            type: 'error',
            error: {
              type: 'not_found_error',
              message: error.message,
              action: error.userAction,
            },
          },
        };
      }
      throw error;
    }

    const { prompt, systemPrompt } = flattenRequest(request);
    const fullPrompt = systemPrompt === '' ? prompt : `${systemPrompt}\n\n${prompt}`;

    if (fullPrompt.trim() === '') {
      return {
        kind: 'refused',
        status: 400,
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'the conversation flattened to an empty prompt',
            action: 'At least one message needs content a provider can be asked about.',
          },
        },
      };
    }

    return {
      kind: 'planned',
      request,
      route,
      prompt: fullPrompt,
      params: universalParams(request),
      stream: request.stream === true,
    } satisfies RequestPlan<MessagesRequest>;
  },

  identity(uuid) {
    // `msg_` is the prefix every Anthropic client expects, and several log or index by
    // it. Ours is not a real Anthropic id and does not pretend to be beyond the prefix.
    return { id: `msg_${uuid().replace(/-/g, '').slice(0, 24)}`, model: '' };
  },

  async respond(context) {
    const { plan, identity, events, response, settle, promptChars } = context;
    const options = {
      toolsOffered: (plan.request.tools?.length ?? 0) > 0,
      includeThinking: wantsThinking(plan.request) || plan.route.alias.includes('reason'),
      promptChars,
    };
    const named = { ...identity, model: plan.request.model };

    if (plan.stream) {
      return streamMessages(response, events, named, options, settle, plan.route.provider.id);
    }

    try {
      const collected = await collectUms(events);
      settle(collected.error);
      if (collected.error) return errorResponse(response, collected.error);
      return sendJson(
        response,
        200,
        buildMessageResponse(named, collected, options, promptChars),
      );
    } catch (error) {
      const omni = context.asOmniError(error, plan.route.provider.id);
      settle(omni);
      return errorResponse(response, omni);
    }
  },

  error(error) {
    const shaped = toAnthropicError(error);
    return { status: shaped.status, body: { type: shaped.type, error: shaped.error } };
  },

  refuse(status, kind, message, action) {
    return {
      kind: 'refused',
      status,
      body: { type: 'error', error: { type: TYPE_BY_KIND[kind], message, action } },
    };
  },
};

const TYPE_BY_KIND: Record<RefusalKind, string> = {
  invalid_request: 'invalid_request_error',
  // Anthropic's own name for a body the API will not read, and clients special-case it.
  too_large: 'request_too_large',
  not_found: 'not_found_error',
  authentication: 'authentication_error',
  rate_limit: 'rate_limit_error',
  api: 'api_error',
};

async function streamMessages(
  response: ServerResponse,
  events: AsyncGenerator<import('@omniproxy/schema').UMSEvent>,
  identity: { id: string; model: string },
  options: { toolsOffered: boolean; includeThinking: boolean; promptChars: number },
  settle: (error?: OmniError) => void,
  provider: string,
): Promise<void> {
  let failure: OmniError | undefined;
  const guarded = (async function* () {
    try {
      for await (const item of events) {
        if (item.type === 'error') failure = item.error;
        yield item;
      }
    } catch (error) {
      const omni: OmniError = {
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
        userAction: 'This is a bug in the gateway. The gateway log has the detail.',
        retryable: 'no',
        provider,
      };
      failure = omni;
      yield { type: 'error' as const, error: omni };
    }
  })();

  let started = false;
  try {
    for await (const frame of toAnthropicStream(guarded, identity, options)) {
      if (!started) {
        started = true;
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
      }
      if (!response.write(frame)) {
        await new Promise<void>((resolve) => response.once('drain', resolve));
      }
    }
  } catch {
    if (!started) {
      settle(failure);
      if (failure) return errorResponse(response, failure);
    }
  }

  settle(failure);
  response.end();
}

function errorResponse(response: ServerResponse, error: OmniError): void {
  const shaped = toAnthropicError(error);
  const headers =
    typeof error.retryAfterMs === 'number'
      ? { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) }
      : {};
  sendJson(response, shaped.status, { type: shaped.type, error: shaped.error }, headers);
}

function sendJson(
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
