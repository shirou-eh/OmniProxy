import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildChatCompletion,
  flattenMessages,
  OpenAiRequestError,
  parseChatCompletionRequest,
  toOpenAiError,
  toOpenAiStream,
  type ChatCompletionRequest,
} from '@omniproxy/dialect-openai';
import {
  DeclarationExecutionError,
  defaultTransformContext,
  executeFlow,
  memoryStateStore,
  TransformRegistry,
  type HttpClient,
  type TransformContext,
} from '@omniproxy/engine-declarative';
import {
  collectUms,
  type OmniError,
  type ProviderDeclaration,
  type UMSEvent,
} from '@omniproxy/schema';
import { AccountPool, type Account } from './accounts.js';
import { listModelIds, resolveRoute, RoutingError, type Route } from './router.js';

/**
 * The gateway.
 *
 * Two decisions shape everything below.
 *
 * **A request carries its own history, and the gateway keeps none.** OpenAI's protocol
 * is stateless — every call sends the whole conversation — while provider web
 * interfaces are the opposite, keeping a session server-side and expecting only the
 * newest message. Bridging the two by remembering sessions across requests is faster
 * and is risk R-6: two callers sharing a session see each other's context, a retried
 * request continues a conversation that has already moved on, and the bug is invisible
 * until an answer is subtly wrong. So each request opens a fresh upstream session with
 * the whole conversation flattened into the prompt. That costs a round trip, and it
 * makes the answer a function of the request and nothing else.
 *
 * **A failed attempt may move to another account, but only before the provider has
 * started answering.** After the first content event the answer is committed: the
 * message has been spent, and starting over would bill a second one and could hand the
 * caller a different answer than the one already half-produced. Before that point,
 * retrying costs nothing and catches exactly the failures worth retrying — expired
 * cookies, rate limits, an exhausted daily quota.
 */

export interface GatewayOptions {
  providers: readonly ProviderDeclaration[];
  accounts: AccountPool;
  http: HttpClient;
  transforms?: TransformRegistry;
  transformContext?: TransformContext;
  /**
   * Required in `Authorization: Bearer <key>`. When absent the gateway is open, which
   * is only safe on loopback — `serve` enforces that pairing, not this function.
   */
  apiKey?: string;
  env?: Record<string, string | undefined>;
  /** Injectable so tests are not at the mercy of the clock. */
  now?: () => number;
  uuid?: () => string;
  log?(line: string): void;
}

export type GatewayHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

interface Runtime {
  now(): number;
  uuid(): string;
  transforms: TransformRegistry;
  transformContext: TransformContext;
  log(line: string): void;
}

export function createGatewayHandler(options: GatewayOptions): GatewayHandler {
  const runtime: Runtime = {
    now: options.now ?? (() => Date.now()),
    uuid: options.uuid ?? (() => randomUUID()),
    transforms: options.transforms ?? new TransformRegistry(),
    transformContext: options.transformContext ?? defaultTransformContext(),
    log: options.log ?? (() => {}),
  };

  return async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const cors = corsHeaders(request);

    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, cors).end();
        return;
      }

      if (path === '/health' || path === '/healthz') {
        return json(response, 200, health(options, runtime), cors);
      }

      const unauthorized = checkApiKey(request, options.apiKey);
      if (unauthorized) return json(response, 401, unauthorized, cors);

      if (path === '/v1/models' && request.method === 'GET') {
        return json(response, 200, models(options, runtime), cors);
      }

      if (path === '/v1/chat/completions' && request.method === 'POST') {
        return await chatCompletions(request, response, options, runtime);
      }

      return json(
        response,
        404,
        errorBody(
          `no route for ${request.method} ${path}`,
          'invalid_request_error',
          'not_found',
          'This build serves /v1/chat/completions, /v1/models and /health.',
        ),
        cors,
      );
    } catch (error) {
      // Nothing reaches here in normal operation. If something does, the caller still
      // gets a shaped error rather than a socket that closes with no explanation.
      runtime.log(`gateway: unhandled ${String(error)}`);
      if (!response.headersSent) {
        json(
          response,
          500,
          errorBody(
            'the gateway failed in an unexpected way',
            'api_error',
            'internal',
            'Check the gateway log. This is a bug worth reporting.',
          ),
        );
      } else {
        response.end();
      }
    }
  };
}

/* ─────────────────────────────────── endpoints ─────────────────────────────────── */

function health(options: GatewayOptions, runtime: Runtime): unknown {
  return {
    status: 'ok',
    time: Math.floor(runtime.now() / 1000),
    providers: options.providers.map((provider) => ({
      id: provider.id,
      // Reported as declared. A provider never verified against the live service says
      // so here, rather than looking like one that has been (§12.10).
      status: provider.status,
      models: provider.models.map((model) => model.alias),
      accounts: options.accounts.size(provider.id),
    })),
    // Field names only. Never a value (§12.7).
    accounts: options.accounts.snapshot(),
  };
}

function models(options: GatewayOptions, runtime: Runtime): unknown {
  return {
    object: 'list',
    data: listModelIds(options.providers).map((id) => ({
      id,
      object: 'model',
      created: Math.floor(runtime.now() / 1000),
      owned_by: id.includes('/') ? id.slice(0, id.indexOf('/')) : 'omniproxy',
    })),
  };
}

async function chatCompletions(
  request: IncomingMessage,
  response: ServerResponse,
  options: GatewayOptions,
  runtime: Runtime,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch (error) {
    const tooLarge = (error as Error).message === BODY_TOO_LARGE;
    return json(
      response,
      tooLarge ? 413 : 400,
      errorBody(
        tooLarge ? 'the request body is too large' : 'the request body is not JSON',
        'invalid_request_error',
        'invalid_request',
        tooLarge
          ? `The gateway accepts up to ${MAX_BODY_BYTES / (1024 * 1024)}MB of conversation.`
          : 'Send a JSON body with Content-Type: application/json.',
      ),
    );
  }

  let parsed: ChatCompletionRequest;
  let route: Route;
  try {
    parsed = parseChatCompletionRequest(body);
    route = resolveRoute(options.providers, parsed.model);
  } catch (error) {
    if (error instanceof OpenAiRequestError) {
      return json(
        response,
        error.status,
        errorBody(
          error.message,
          error.type,
          'invalid_request',
          'Check the request against the OpenAI Chat Completions schema.',
          error.param ?? null,
        ),
      );
    }
    if (error instanceof RoutingError) {
      return json(
        response,
        error.status,
        errorBody(
          error.message,
          'invalid_request_error',
          'model_not_found',
          error.userAction,
          'model',
        ),
      );
    }
    throw error;
  }

  const { prompt, systemPrompt } = flattenMessages(parsed.messages, parsed.tools);
  const fullPrompt = systemPrompt === '' ? prompt : `${systemPrompt}\n\n${prompt}`;

  if (fullPrompt.trim() === '') {
    return json(
      response,
      400,
      errorBody(
        'the conversation flattened to an empty prompt',
        'invalid_request_error',
        'invalid_request',
        'At least one message needs content a provider can be asked about.',
        'messages',
      ),
    );
  }

  const opened = await openWithRetry(options, runtime, route, parsed, fullPrompt);
  if (opened.kind === 'failed') {
    const shaped = toOpenAiError(opened.error);
    return json(response, shaped.status, { error: shaped.error }, retryAfterHeader(opened.error));
  }

  const identity = {
    id: `chatcmpl-${runtime.uuid().replace(/-/g, '').slice(0, 24)}`,
    created: Math.floor(runtime.now() / 1000),
    model: parsed.model,
  };
  const shape = {
    toolsOffered: (parsed.tools?.length ?? 0) > 0,
    includeReasoning: route.alias.includes('reason') || route.alias.includes('think'),
  };

  const account = opened.account;
  const settle = (error?: OmniError): void => {
    if (!account) return;
    if (error) options.accounts.fail(account.id, error);
    else options.accounts.succeed(account.id);
  };

  if (parsed.stream === true) {
    return streamResponse(response, opened.stream, identity, {
      ...shape,
      provider: route.provider.id,
      log: runtime.log,
      settle,
    });
  }

  try {
    const collected = await collectUms(opened.stream);
    settle(collected.error);
    if (collected.error) {
      const shaped = toOpenAiError(collected.error);
      return json(
        response,
        shaped.status,
        { error: shaped.error },
        retryAfterHeader(collected.error),
      );
    }
    return json(response, 200, buildChatCompletion(identity, collected, shape, fullPrompt.length));
  } catch (error) {
    const omni = asOmniError(error, route.provider.id);
    settle(omni);
    const shaped = toOpenAiError(omni);
    return json(response, shaped.status, { error: shaped.error }, retryAfterHeader(omni));
  }
}

/* ────────────────────────────── attempts and accounts ────────────────────────────── */

type Opened =
  | { kind: 'ok'; stream: AsyncGenerator<UMSEvent>; account?: Account }
  | { kind: 'failed'; error: OmniError };

/**
 * Runs the flow, moving to another account while nothing has been committed.
 *
 * An attempt is "committed" the moment the provider emits anything but `start` and
 * `warning` — the first token, a usage figure, a finish. Up to that point a failure has
 * cost nothing but a connection, and every failure worth retrying (expired cookie, rate
 * limit, exhausted quota) arrives exactly there. After it we stop: the message has been
 * spent, and the caller is owed the answer already being produced.
 */
async function openWithRetry(
  options: GatewayOptions,
  runtime: Runtime,
  route: Route,
  parsed: ChatCompletionRequest,
  fullPrompt: string,
): Promise<Opened> {
  const needsAccount = route.provider.auth.kind !== 'none';
  const attempts = needsAccount ? Math.max(1, options.accounts.size(route.provider.id)) : 1;
  const tried = new Set<string>();
  let lastError: OmniError | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let account: Account | undefined;

    if (needsAccount) {
      const lease = options.accounts.nextFor(route.provider.id, tried);

      if (lease.kind === 'none') {
        return { kind: 'failed', error: noAccountError(route.provider.id, lease.reason, lastError) };
      }
      if (lease.kind === 'cooling') {
        return {
          kind: 'failed',
          error: {
            code: 'rate_limit',
            message: `every account for ${route.provider.id} is resting: ${lease.reason}`,
            userAction: `Wait ${Math.ceil(lease.retryAfterMs / 1000)}s, or add another account.`,
            retryable: 'same-account',
            retryAfterMs: lease.retryAfterMs,
            provider: route.provider.id,
          },
        };
      }

      account = lease.account;
      tried.add(account.id);
    }

    // A fresh state store per attempt: a session created by a failed attempt belongs to
    // that attempt's account, and must not leak into the next one's.
    const events = executeFlow({
      declaration: route.provider,
      http: options.http,
      transforms: runtime.transforms,
      transformContext: runtime.transformContext,
      state: memoryStateStore(),
      auth: account?.fields ?? {},
      ...(options.env ? { env: options.env } : {}),
      ...(options.now ? { now: options.now } : {}),
      request: {
        model: route.alias,
        prompt: fullPrompt,
        messages: parsed.messages,
        params: numericParams(parsed),
      },
    });

    const opened = await commit(events, route.provider.id);
    if (opened.kind === 'ok') return account ? { ...opened, account } : opened;

    lastError = opened.error;
    if (account) options.accounts.fail(account.id, opened.error);

    const worthRetrying = opened.error.retryable === 'other-account' && attempt + 1 < attempts;
    runtime.log(
      `gateway: ${route.provider.id} attempt ${attempt + 1}/${attempts} failed (${opened.error.code})` +
        (worthRetrying ? ', trying another account' : ''),
    );
    if (!worthRetrying) return opened;
  }

  return {
    kind: 'failed',
    error: lastError ?? {
      code: 'internal',
      message: 'no attempt was made',
      userAction: 'This is a bug in the gateway.',
      retryable: 'no',
      provider: route.provider.id,
    },
  };
}

function noAccountError(
  provider: string,
  reason: 'unconfigured' | 'exhausted',
  lastError: OmniError | undefined,
): OmniError {
  if (reason === 'unconfigured') {
    return {
      code: 'auth_missing',
      message: `no account is configured for ${provider}`,
      userAction: `Add one to your accounts file — { "${provider}": { … } } — and start with --accounts.`,
      retryable: 'no',
      provider,
    };
  }
  return (
    lastError ?? {
      code: 'auth_expired',
      message: `every account for ${provider} failed`,
      userAction: 'Re-capture credentials for at least one account.',
      retryable: 'no',
      provider,
    }
  );
}

/**
 * Reads far enough into a flow to know whether it started, without losing what it read.
 *
 * Whatever was consumed while deciding is replayed ahead of the rest, so the caller
 * sees exactly the event sequence it would have seen had nothing peeked at it.
 */
async function commit(events: AsyncGenerator<UMSEvent>, provider: string): Promise<Opened> {
  const head: UMSEvent[] = [];
  try {
    for (;;) {
      const next = await events.next();
      if (next.done) break;
      const event = next.value;
      if (event.type === 'error') {
        await closeQuietly(events);
        return { kind: 'failed', error: event.error };
      }
      head.push(event);
      if (event.type !== 'start' && event.type !== 'warning') break;
    }
  } catch (error) {
    await closeQuietly(events);
    return { kind: 'failed', error: asOmniError(error, provider) };
  }
  return { kind: 'ok', stream: replay(head, events) };
}

async function* replay(
  head: readonly UMSEvent[],
  rest: AsyncGenerator<UMSEvent>,
): AsyncGenerator<UMSEvent> {
  yield* head;
  yield* rest;
}

async function closeQuietly(events: AsyncGenerator<UMSEvent>): Promise<void> {
  try {
    await events.return(undefined);
  } catch {
    // A generator that objects to being closed has nothing left to tell us.
  }
}

/* ─────────────────────────────────── streaming ─────────────────────────────────── */

interface StreamContext {
  toolsOffered: boolean;
  includeReasoning: boolean;
  provider: string;
  log(line: string): void;
  settle(error?: OmniError): void;
}

/**
 * Streams, and keeps streaming honestly when things go wrong.
 *
 * The moment the first byte is written the status is fixed at 200, so a later failure
 * cannot become a 500. It becomes a final chunk carrying the error and its action —
 * the difference between a client that reports "rate limited, try another account" and
 * one that reports a truncated response with no explanation.
 */
async function streamResponse(
  response: ServerResponse,
  events: AsyncGenerator<UMSEvent>,
  identity: { id: string; created: number; model: string },
  context: StreamContext,
): Promise<void> {
  let failure: OmniError | undefined;
  const guarded = guardStream(events, context.provider, (error) => {
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
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
      }
      // Back-pressure. Without it a fast provider fills memory when the client is slow,
      // and the process dies with an allocation failure rather than a message.
      if (!response.write(chunk)) {
        await new Promise<void>((resolve) => response.once('drain', resolve));
      }
    }
  } catch (error) {
    failure = asOmniError(error, context.provider);
    context.log(
      `gateway: stream failed after ${started ? 'first byte' : 'nothing'}: ${String(error)}`,
    );
    if (!started) {
      context.settle(failure);
      const shaped = toOpenAiError(failure);
      json(response, shaped.status, { error: shaped.error }, retryAfterHeader(failure));
      return;
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
async function* guardStream(
  events: AsyncGenerator<UMSEvent>,
  provider: string,
  onError: (error: OmniError) => void,
): AsyncGenerator<UMSEvent> {
  try {
    for await (const event of events) {
      if (event.type === 'error') onError(event.error);
      yield event;
    }
  } catch (error) {
    const omni = asOmniError(error, provider);
    onError(omni);
    yield { type: 'error', error: omni };
  }
}

/* ──────────────────────────────────── plumbing ──────────────────────────────────── */

export function asOmniError(error: unknown, provider: string): OmniError {
  if (error instanceof DeclarationExecutionError) return error.omni;

  const named = error as { name?: string; message?: string; userAction?: string; kind?: string };
  if (named?.name === 'TransportError') {
    return {
      code: named.kind === 'timeout' ? 'timeout' : 'upstream_unavailable',
      message: named.message ?? 'the provider could not be reached',
      userAction: named.userAction ?? 'Check the network, then run omniproxy provider validate.',
      retryable: 'same-account',
      provider,
    };
  }

  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    userAction: 'This is a bug in the gateway. The gateway log has the detail.',
    retryable: 'no',
    provider,
  };
}

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

function retryAfterHeader(error: OmniError): Record<string, string> {
  if (typeof error.retryAfterMs !== 'number') return {};
  return { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) };
}

function errorBody(
  message: string,
  type: string,
  code: string,
  action: string,
  param: string | null = null,
): unknown {
  return { error: { message, type, code, param, action } };
}

/**
 * Constant-time comparison of the proxy's own key.
 *
 * The key guards someone's accounts, and a length-leaking comparison is a five-minute
 * attack on a service that is, by design, reachable from the machine it runs on.
 */
export function checkApiKey(
  request: IncomingMessage,
  expected: string | undefined,
): unknown | undefined {
  if (!expected) return undefined;

  const header = request.headers['authorization'];
  const presented = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return errorBody(
      'invalid api key',
      'authentication_error',
      'invalid_api_key',
      'Send the key the gateway was started with as Authorization: Bearer <key>.',
    );
  }
  return undefined;
}

/**
 * CORS for local browser use only.
 *
 * A wildcard here would let any page on the internet spend the user's accounts through
 * their own machine, silently. Only a loopback origin is echoed back.
 */
export function corsHeaders(request: IncomingMessage): Record<string, string> {
  const origin = request.headers['origin'];
  if (typeof origin !== 'string') return {};
  try {
    const host = new URL(origin).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
      return {};
    }
  } catch {
    return {};
  }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  };
}

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const BODY_TOO_LARGE = 'request body too large';

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    // A cap, because a conversation is text and 32MB of it is a mistake or an attack.
    if (size > MAX_BODY_BYTES) throw new Error(BODY_TOO_LARGE);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(
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
