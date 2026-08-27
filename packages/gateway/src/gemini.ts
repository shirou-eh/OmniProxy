import type { ServerResponse } from 'node:http';
import {
  approxTokens,
  buildGenerateContentResponse,
  flattenRequest,
  GeminiRequestError,
  parseGenerateContentRequest,
  parseModelPath,
  toGeminiError,
  toGeminiStream,
  universalParams,
  type GenerateContentRequest,
} from '@omniproxy/dialect-gemini';
import { collectUms, type OmniError, type ProviderDeclaration, type UMSEvent } from '@omniproxy/schema';
import type { DialectHooks, Refusal, RefusalKind, RequestPlan } from './dialect.js';
import { sendJson } from './openai.js';
import { listModelIds, resolveRoute, RoutingError, type Route } from './router.js';

/**
 * `POST /v1beta/models/{model}:generateContent` and `:streamGenerateContent`.
 *
 * The third dialect on the same request loop. The one structural difference from the
 * other two is that Google puts the model and the operation in the URL, which is why
 * `DialectHooks.plan` takes a route context at all — everything else here is the same
 * conversion in and out that the other two do.
 */
export const geminiDialect: DialectHooks<GenerateContentRequest> = {
  name: 'gemini',

  plan(body, providers, context) {
    const model = context?.['model'];
    const method = context?.['method'] ?? 'generateContent';

    if (!model) {
      // Only reachable if the matcher and this function ever disagree, which is worth
      // saying out loud rather than crashing on an undefined.
      return refusal(400, 'INVALID_ARGUMENT', 'no model in the request path', 400, {
        action: 'Call /v1beta/models/<model>:generateContent.',
      });
    }

    let request: GenerateContentRequest;
    let route: Route;
    try {
      request = parseGenerateContentRequest(body);
      route = resolveRoute(providers, model);
    } catch (error) {
      if (error instanceof GeminiRequestError) {
        return refusal(error.status, error.reason, error.message, error.status, {
          action: 'Check the request against the generateContent schema.',
        });
      }
      if (error instanceof RoutingError) {
        return refusal(error.status, 'NOT_FOUND', error.message, error.status, {
          action: error.userAction,
        });
      }
      throw error;
    }

    const { prompt, systemPrompt } = flattenRequest(request);
    const fullPrompt = systemPrompt === '' ? prompt : `${systemPrompt}\n\n${prompt}`;

    if (fullPrompt.trim() === '') {
      return refusal(400, 'INVALID_ARGUMENT', 'the conversation flattened to an empty prompt', 400, {
        action: 'At least one part needs text a provider can be asked about.',
      });
    }

    return {
      kind: 'planned',
      request,
      route,
      prompt: fullPrompt,
      params: universalParams(request),
      // Google names the streaming operation rather than setting a flag in the body.
      stream: method === 'streamGenerateContent',
    } satisfies RequestPlan<GenerateContentRequest>;
  },

  identity() {
    // Gemini's response carries no request id; `modelVersion` is filled in by respond.
    return { id: '', model: '' };
  },

  async respond(context) {
    const { plan, events, response, settle, promptChars } = context;
    const identity = { model: plan.route.alias };
    const options = {
      toolsOffered: (plan.request.tools?.length ?? 0) > 0,
      includeThoughts: plan.route.alias.includes('reason') || plan.route.alias.includes('think'),
      promptChars,
    };

    if (plan.stream) {
      return streamGenerate(response, events, identity, options, settle, plan.route.provider.id);
    }

    try {
      const collected = await collectUms(events);
      settle(collected.error);
      if (collected.error) return sendGeminiError(response, collected.error);
      return sendJson(
        response,
        200,
        buildGenerateContentResponse(identity, collected, options, promptChars),
      );
    } catch (error) {
      const omni = context.asOmniError(error, plan.route.provider.id);
      settle(omni);
      return sendGeminiError(response, omni);
    }
  },

  error(error) {
    const shaped = toGeminiError(error);
    return { status: shaped.status, body: { error: shaped.error } };
  },

  refuse(status, kind, message, action) {
    return refusal(status, REASON_BY_KIND[kind], message, status, { action });
  },
};

const REASON_BY_KIND: Record<RefusalKind, string> = {
  invalid_request: 'INVALID_ARGUMENT',
  too_large: 'INVALID_ARGUMENT',
  not_found: 'NOT_FOUND',
  authentication: 'UNAUTHENTICATED',
  rate_limit: 'RESOURCE_EXHAUSTED',
  api: 'INTERNAL',
};

/* ─────────────────────────────── the extra endpoints ─────────────────────────────── */

/**
 * `GET /v1beta/models`.
 *
 * Its own path, so it does not collide with the OpenAI and Anthropic listing, and its
 * own shape: Google names models `models/x` and clients strip that prefix themselves.
 */
export function geminiModels(providers: readonly ProviderDeclaration[]): unknown {
  return {
    models: listModelIds(providers).map((id) => ({
      name: `models/${id}`,
      baseModelId: id,
      displayName: id,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
    })),
  };
}

/**
 * `POST /v1beta/models/{model}:countTokens`.
 *
 * Answered with the same arithmetic every token figure in this project uses — four
 * characters to a token — and labelled as an estimate in the payload. Clients budget
 * against this number, and one budgeting against arithmetic rather than a tokenizer
 * deserves to be told. Refusing outright was the alternative, and it breaks every
 * client that counts before it sends (§12.10 cuts both ways: do not overstate, and do
 * not pretend a working feature is missing).
 */
export function countTokens(
  body: unknown,
  providers: readonly ProviderDeclaration[],
  model: string | undefined,
): { status: number; body: unknown } {
  if (!model) {
    return {
      status: 400,
      body: {
        error: { code: 400, status: 'INVALID_ARGUMENT', message: 'no model in the request path' },
      },
    };
  }

  try {
    resolveRoute(providers, model);
  } catch (error) {
    if (error instanceof RoutingError) {
      return {
        status: error.status,
        body: {
          error: {
            code: error.status,
            status: 'NOT_FOUND',
            message: error.message,
            action: error.userAction,
          },
        },
      };
    }
    throw error;
  }

  let request: GenerateContentRequest;
  try {
    request = parseGenerateContentRequest(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 400,
      body: { error: { code: 400, status: 'INVALID_ARGUMENT', message } },
    };
  }

  const { prompt, systemPrompt } = flattenRequest(request);
  const total = approxTokens(prompt.length + systemPrompt.length);

  return {
    status: 200,
    body: {
      totalTokens: total,
      // Additive, and the honest part: this is arithmetic on characters, not a
      // tokenizer, because provider web interfaces expose neither.
      omniproxy: {
        estimated: true,
        method: 'characters/4',
        note: 'No provider web interface exposes a tokenizer. Treat this as a rough budget.',
      },
    },
  };
}

/* ─────────────────────────────────── streaming ─────────────────────────────────── */

async function streamGenerate(
  response: ServerResponse,
  events: AsyncGenerator<UMSEvent>,
  identity: { model: string },
  options: { toolsOffered: boolean; includeThoughts: boolean; promptChars: number },
  settle: (error?: OmniError) => void,
  provider: string,
): Promise<void> {
  let failure: OmniError | undefined;
  const guarded = (async function* () {
    try {
      for await (const event of events) {
        if (event.type === 'error') failure = event.error;
        yield event;
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
    for await (const chunk of toGeminiStream(guarded, identity, options)) {
      if (!started) {
        started = true;
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
      }
      if (!response.write(chunk)) {
        await new Promise<void>((resolve) => response.once('drain', resolve));
      }
    }
  } catch {
    if (!started && failure) {
      settle(failure);
      return sendGeminiError(response, failure);
    }
  }

  settle(failure);
  response.end();
}

function sendGeminiError(response: ServerResponse, error: OmniError): void {
  const shaped = toGeminiError(error);
  const headers =
    typeof error.retryAfterMs === 'number'
      ? { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) }
      : {};
  sendJson(response, shaped.status, { error: shaped.error }, headers);
}

function refusal(
  status: number,
  reason: string,
  message: string,
  code: number,
  extra: Record<string, unknown> = {},
): Refusal {
  return {
    kind: 'refused',
    status,
    body: { error: { code, message, status: reason, ...extra } },
  };
}

export { parseModelPath };
