import type { ServerResponse } from 'node:http';
import {
  buildOllamaResponse,
  flattenRequest,
  isChatRequest,
  OllamaRequestError,
  parseChatRequest,
  parseGenerateRequest,
  toOllamaError,
  toOllamaStream,
  universalParams,
  wantsStream,
  type OllamaRequest,
} from '@omniproxy/dialect-ollama';
import { collectUms, type OmniError, type ProviderDeclaration, type UMSEvent } from '@omniproxy/schema';
import type { DialectHooks, DialectPlugin, Refusal, RefusalKind, RequestPlan } from './dialect.js';
import { sendJson } from './openai.js';
import { listModelIds, resolveRoute, RoutingError, type Route } from './router.js';

/**
 * `POST /api/chat` and `POST /api/generate`.
 *
 * The fourth dialect, and the one that proves the abstraction was not shaped around
 * SSE by accident: Ollama's stream is NDJSON, and its `stream` field defaults to
 * `true` rather than false. Both are handled here and nowhere else.
 *
 * There is a whole ecosystem of local-first tools that speak this and nothing else,
 * and pointing them at a provider web interface is exactly the sort of thing this
 * project exists to make possible.
 */
export const ollamaDialect: DialectHooks<OllamaRequest> = {
  name: 'ollama',

  plan(body, providers, context) {
    const endpoint = context?.['endpoint'] === 'generate' ? 'generate' : 'chat';

    let request: OllamaRequest;
    let route: Route;
    try {
      request = endpoint === 'chat' ? parseChatRequest(body) : parseGenerateRequest(body);
      route = resolveRoute(providers, request.model);
    } catch (error) {
      if (error instanceof OllamaRequestError) {
        return refusal(error.status, error.message, 'Check the request against the Ollama API.');
      }
      if (error instanceof RoutingError) {
        // Ollama's own wording for a model it does not have, because clients match on
        // it to decide whether to offer a pull.
        return refusal(
          error.status,
          `model "${modelOf(body)}" not found`,
          error.userAction,
        );
      }
      throw error;
    }

    const { prompt, systemPrompt } = flattenRequest(request);
    const fullPrompt = systemPrompt === '' ? prompt : `${systemPrompt}\n\n${prompt}`;

    if (fullPrompt.trim() === '') {
      return refusal(
        400,
        'the conversation flattened to an empty prompt',
        'At least one message needs content a provider can be asked about.',
      );
    }

    return {
      kind: 'planned',
      request,
      route,
      prompt: fullPrompt,
      params: universalParams(request),
      // The one default that is the opposite of every other protocol here. A client
      // that omits the field is asking for a stream.
      stream: wantsStream(request),
    } satisfies RequestPlan<OllamaRequest>;
  },

  identity() {
    // Ollama's records carry no request id.
    return { id: '', model: '' };
  },

  async respond(context) {
    const { plan, events, response, settle, promptChars } = context;
    const started = Date.now();
    const identity = { model: plan.request.model, createdAt: new Date(started).toISOString() };
    const options = {
      toolsOffered: isChatRequest(plan.request) && (plan.request.tools?.length ?? 0) > 0,
      endpoint: (isChatRequest(plan.request) ? 'chat' : 'generate') as 'chat' | 'generate',
      includeThinking:
        plan.route.alias.includes('reason') || plan.route.alias.includes('think'),
      promptChars,
    };

    if (plan.stream) {
      return streamNdjson(response, events, identity, options, settle, plan.route.provider.id, started);
    }

    try {
      const collected = await collectUms(events);
      settle(collected.error);
      if (collected.error) return sendOllamaError(response, collected.error);
      return sendJson(
        response,
        200,
        buildOllamaResponse(identity, collected, {
          ...options,
          durationNs: (Date.now() - started) * 1_000_000,
        }),
      );
    } catch (error) {
      const omni = context.asOmniError(error, plan.route.provider.id);
      settle(omni);
      return sendOllamaError(response, omni);
    }
  },

  error(error) {
    const shaped = toOllamaError(error);
    return {
      status: shaped.status,
      body: { error: shaped.error, action: shaped.action, code: shaped.code },
    };
  },

  refuse(status, kind, message, action) {
    return refusal(status, kind === 'not_found' ? `${message} (not found)` : message, action);
  },
};

/* ─────────────────────────────── the extra endpoints ─────────────────────────────── */

/**
 * `GET /api/tags`.
 *
 * The list a client shows in its model picker. Sizes and digests are reported as zero
 * and empty rather than invented: there is no file on disk, and a plausible-looking
 * digest would be a fabricated fact about something that does not exist.
 */
export function ollamaTags(providers: readonly ProviderDeclaration[], now: number): unknown {
  const modified = new Date(now).toISOString();
  return {
    models: listModelIds(providers).map((id) => ({
      name: id,
      model: id,
      modified_at: modified,
      size: 0,
      digest: '',
      details: {
        parent_model: '',
        format: 'omniproxy',
        family: id.includes('/') ? id.slice(0, id.indexOf('/')) : 'omniproxy',
        families: null,
        parameter_size: '',
        quantization_level: '',
      },
    })),
  };
}

/**
 * `POST /api/show`.
 *
 * Clients call it before chatting to learn a model's capabilities. What is reported is
 * what the declaration says and nothing more — no context length, because none has been
 * measured against the live service, and a number here would be a guess a client would
 * then plan around.
 */
export function ollamaShow(
  providers: readonly ProviderDeclaration[],
  model: string | undefined,
): { status: number; body: unknown } {
  if (!model) return { status: 400, body: { error: 'no model name given' } };

  let route: Route;
  try {
    route = resolveRoute(providers, model);
  } catch (error) {
    if (error instanceof RoutingError) {
      return {
        status: error.status,
        body: { error: `model "${model}" not found`, action: error.userAction },
      };
    }
    throw error;
  }

  const declared = route.provider.models.find((entry) => entry.alias === route.alias);
  return {
    status: 200,
    body: {
      details: {
        format: 'omniproxy',
        family: route.provider.id,
        families: null,
        parameter_size: '',
        quantization_level: '',
      },
      model_info: {
        'omniproxy.provider': route.provider.id,
        // As declared, not as we would like it to look (§12.10).
        'omniproxy.status': route.provider.status,
        'omniproxy.native_model': declared?.native ?? route.alias,
      },
      capabilities: ['completion', 'tools'],
      modified_at: new Date().toISOString(),
    },
  };
}

/** `GET /api/version`. Ours, plainly labelled, rather than a version of Ollama we are not. */
export function ollamaVersion(): unknown {
  return { version: '0.1.4-omniproxy' };
}

/* ─────────────────────────────────── streaming ─────────────────────────────────── */

async function streamNdjson(
  response: ServerResponse,
  events: AsyncGenerator<UMSEvent>,
  identity: { model: string; createdAt: string },
  options: { toolsOffered: boolean; endpoint: 'chat' | 'generate'; includeThinking: boolean; promptChars: number },
  settle: (error?: OmniError) => void,
  provider: string,
  started: number,
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

  let sent = false;
  try {
    for await (const record of toOllamaStream(guarded, identity, {
      ...options,
      durationNs: (Date.now() - started) * 1_000_000,
    })) {
      if (!sent) {
        sent = true;
        // NDJSON, not SSE. Ollama clients read this with a line reader and do not look
        // for `data:` prefixes.
        response.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
      }
      if (!response.write(record)) {
        await new Promise<void>((resolve) => response.once('drain', resolve));
      }
    }
  } catch {
    if (!sent && failure) {
      settle(failure);
      return sendOllamaError(response, failure);
    }
  }

  settle(failure);
  response.end();
}

function sendOllamaError(response: ServerResponse, error: OmniError): void {
  const shaped = toOllamaError(error);
  const headers =
    typeof error.retryAfterMs === 'number'
      ? { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) }
      : {};
  sendJson(
    response,
    shaped.status,
    { error: shaped.error, action: shaped.action, code: shaped.code },
    headers,
  );
}

function refusal(status: number, message: string, action: string): Refusal {
  return { kind: 'refused', status, body: { error: message, action } };
}

function modelOf(body: unknown): string {
  const model = (body as { model?: unknown } | null)?.model;
  return typeof model === 'string' ? model : 'unknown';
}

export type { RefusalKind };

/**
 * Mounted on Ollama's two completion endpoints, with the three a client calls before
 * it chats: the model list, the model description and the version.
 */
export const ollamaPlugin: DialectPlugin = {
  name: 'ollama',
  dialect: ollamaDialect as unknown as DialectHooks<never>,
  paths: ['/api/chat', '/api/generate', '/api/tags', '/api/show', '/api/version'],

  match: (path) => {
    if (path === '/api/chat') return { endpoint: 'chat' };
    if (path === '/api/generate') return { endpoint: 'generate' };
    return undefined;
  },

  async side(request) {
    if (request.method === 'GET' && request.path === '/api/tags') {
      return { status: 200, body: ollamaTags(request.providers, request.now()) };
    }
    if (request.method === 'GET' && request.path === '/api/version') {
      return { status: 200, body: ollamaVersion() };
    }
    if (request.method === 'POST' && request.path === '/api/show') {
      // Ollama's own clients send either spelling, depending on their vintage.
      const body = (await request.body()) as { model?: string; name?: string } | undefined;
      return ollamaShow(request.providers, body?.model ?? body?.name);
    }
    return undefined;
  },
};
