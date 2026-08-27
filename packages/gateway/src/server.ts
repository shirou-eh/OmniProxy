import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DeclarationExecutionError,
  defaultTransformContext,
  executeFlow,
  memoryStateStore,
  pickChannel,
  TransformRegistry,
  type HttpClient,
  type TransformContext,
} from '@omniproxy/engine-declarative';
import type { OmniError, ProviderDeclaration, UMSEvent } from '@omniproxy/schema';
import { AccountPool, type Account } from './accounts.js';
import { anthropicPlugin } from './anthropic.js';
import type {
  DialectHooks,
  DialectPlugin,
  RouteContext,
  RequestPlan,
  SideRequest,
} from './dialect.js';
import { ConcurrencyGate, gateKey, GateRefused, type Release } from './gate.js';
import { geminiPlugin } from './gemini.js';
import { ollamaPlugin } from './ollama.js';
import { openAiDialect, openAiPlugin, sendJson } from './openai.js';
import { listModelIds, type Route } from './router.js';

/**
 * The gateway.
 *
 * Three decisions shape everything below.
 *
 * **A request carries its own history, and the gateway keeps none.** OpenAI's protocol
 * is stateless — every call sends the whole conversation — while provider web
 * interfaces are the opposite, keeping a session server-side and expecting only the
 * newest message. Bridging the two by remembering sessions across requests is faster
 * and is risk R-6: two callers sharing a session see each other's context, a retried
 * request continues a conversation that has already moved on, and the bug is invisible
 * until an answer is subtly wrong. So each request opens a fresh upstream session with
 * the whole conversation flattened into the prompt (ADR-0008).
 *
 * **A failed attempt may move to another account, but only before the provider has
 * started answering.** After the first content event the answer is committed: the
 * message has been spent, and starting over would bill a second one and could hand the
 * caller a different answer than the one already half-produced.
 *
 * **Every dialect shares this loop.** Routing, accounts, the gate, the retry rule and
 * the engine live here; a dialect supplies how to read a request, how to write a
 * response, and how to phrase a refusal (`dialect.ts`). Adding a protocol touches
 * nothing in this file except the table below — and if it had required more, the
 * universal layers would not have been earning their keep.
 */

export interface GatewayOptions {
  providers: readonly ProviderDeclaration[];
  accounts: AccountPool;
  http: HttpClient;
  /** Enforces `channels[].concurrency` per account. One is made if none is given. */
  gate?: ConcurrencyGate;
  transforms?: TransformRegistry;
  transformContext?: TransformContext;
  /**
   * Required from callers. Accepted as `Authorization: Bearer <key>`, `x-api-key`,
   * `x-goog-api-key` or `?key=`, because the three client families each send their own.
   * When absent the gateway is open, which is only safe on loopback — `serve` enforces
   * that pairing, not this function.
   */
  apiKey?: string;
  /**
   * Dialects to mount ahead of the built-in four.
   *
   * Ahead, not behind: a plugin that claims `/v1/chat/completions` replaces ours. It is
   * your gateway, and the shadowing is announced in the log rather than refused.
   */
  dialects?: readonly DialectPlugin[];
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
  gate: ConcurrencyGate;
  log(line: string): void;
  /** User plugins first, then the built-ins. Fixed when the handler is created. */
  routes: readonly DialectPlugin[];
}

/**
 * Which dialect answers which path.
 *
 * The endpoint chooses — not a header, and not a guess at the body's shape. A client
 * that posts an Anthropic body to the OpenAI path has made a mistake and deserves to be
 * told so, rather than served by accident.
 *
 * These four are ordinary `DialectPlugin`s, mounted the same way a user's own is. That
 * is the point: there is no privileged route into the gateway, so a protocol we have
 * never heard of is not a fork, it is a file (`docs/omniproxy/07-writing-a-dialect.md`).
 */
const BUILT_IN_DIALECTS: readonly DialectPlugin[] = [
  openAiPlugin,
  anthropicPlugin,
  ollamaPlugin,
  geminiPlugin,
];

/**
 * Representative paths of the built-ins, used for one thing only: noticing when a
 * user's plugin takes one over, so the log says so instead of the change being silent.
 */
const BUILT_IN_PATHS = [
  '/v1/chat/completions',
  '/v1/messages',
  '/api/chat',
  '/api/generate',
  '/v1beta/models/m:generateContent',
];

function mount(
  extra: readonly DialectPlugin[],
  log: (line: string) => void,
): readonly DialectPlugin[] {
  for (const plugin of extra) {
    for (const path of BUILT_IN_PATHS) {
      // Warned about once, then done: overriding a built-in is a supported thing to
      // want, and a gateway that refused it would be ours rather than yours.
      if (plugin.match(path, 'POST')) {
        log(`gateway: dialect "${plugin.name}" answers ${path} instead of the built-in one`);
      }
    }
  }
  return [...extra, ...BUILT_IN_DIALECTS];
}

/** The dialect a caller was aiming at, so a refusal is phrased in their protocol. */
function routeFor(
  routes: readonly DialectPlugin[],
  path: string,
  method: string,
): { dialect: DialectHooks<never>; context: RouteContext } | undefined {
  for (const route of routes) {
    const context = route.match(path, method);
    if (context) return { dialect: route.dialect, context };
  }
  return undefined;
}

export function createGatewayHandler(options: GatewayOptions): GatewayHandler {
  const log = options.log ?? ((): void => {});
  const runtime: Runtime = {
    now: options.now ?? (() => Date.now()),
    uuid: options.uuid ?? (() => randomUUID()),
    transforms: options.transforms ?? new TransformRegistry(),
    transformContext: options.transformContext ?? defaultTransformContext(),
    gate: options.gate ?? new ConcurrencyGate(),
    log,
    routes: mount(options.dialects ?? [], log),
  };

  return async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method ?? 'GET';
    const cors = corsHeaders(request);
    // Read at most once however many handlers ask for it, so looking at a body in a
    // side endpoint never consumes the one the request loop needs.
    const body = bodyOnce(request);

    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204, cors).end();
        return;
      }

      if (path === '/health' || path === '/healthz') {
        return sendJson(response, 200, health(options, runtime), cors);
      }

      if (path === '/v1/capabilities' && method === 'GET') {
        return sendJson(response, 200, capabilities(options, runtime), cors);
      }

      if (needsApiKey(request, url, options.apiKey)) {
        // Phrased by whichever dialect the caller was aiming at, so their client
        // surfaces an auth error rather than an unrecognised payload.
        const dialect = routeFor(runtime.routes, path, method)?.dialect ?? openAiDialect;
        const refused = dialect.refuse(
          401,
          'authentication',
          'invalid api key',
          'Send the key the gateway was started with as Authorization: Bearer <key>, or as x-api-key.',
        );
        return sendJson(response, refused.status, refused.body, cors);
      }

      // The endpoints that reach no provider and spend no account, each owned by the
      // dialect whose clients call it. A user's plugin is asked first, so it can answer
      // a path of its own — or take over one of ours.
      const side: SideRequest = {
        path,
        method,
        url,
        providers: options.providers,
        body: () => body.json(),
        now: runtime.now,
      };
      for (const plugin of runtime.routes) {
        const answered = await plugin.side?.(side);
        if (answered) {
          return sendJson(response, answered.status, answered.body, {
            ...cors,
            ...answered.headers,
          });
        }
      }

      if (path === '/v1/models' && method === 'GET') {
        return sendJson(response, 200, models(options, runtime), cors);
      }

      const matched = routeFor(runtime.routes, path, method);
      if (matched && method === 'POST') {
        return await handleCompletion(
          matched.dialect,
          matched.context,
          body,
          response,
          options,
          runtime,
        );
      }

      const refused = (matched?.dialect ?? openAiDialect).refuse(
        404,
        'not_found',
        `no route for ${method} ${path}`,
        `This build serves ${servedPaths(runtime.routes)}, /v1/models, /v1/capabilities and /health.`,
      );
      return sendJson(response, refused.status, refused.body, cors);
    } catch (error) {
      // Nothing reaches here in normal operation. If something does, the caller still
      // gets a shaped error rather than a socket that closes with no explanation.
      runtime.log(`gateway: unhandled ${String(error)}`);
      if (!response.headersSent) {
        const refused = openAiDialect.refuse(
          500,
          'api',
          'the gateway failed in an unexpected way',
          'Check the gateway log. This is a bug worth reporting.',
        );
        sendJson(response, refused.status, refused.body);
      } else {
        response.end();
      }
    }
  };
}

/* ─────────────────────────────────── endpoints ─────────────────────────────────── */

/** Every path a mounted dialect claims, for a 404 that says what does exist. */
function servedPaths(routes: readonly DialectPlugin[]): string {
  const paths = routes.flatMap((route) => route.paths ?? []);
  return paths.length > 0 ? paths.join(', ') : routes.map((route) => route.name).join(', ');
}

function capabilities(options: GatewayOptions, runtime: Runtime): unknown {
  return {
    // What the gateway itself can do — honestly, today only text, one account
    // and a hundred go through the same code path (ADR-0004), pluggable
    // dialects are real (PR-13), everything else is still TODO.
    gateway: {
      dialects: runtime.routes.map((route) => route.name),
      modalities: ['text'],
      concurrencyGate: true,
      pluggableDialects: true,
    },
    // What each provider declares — status as declared (§12.10), capabilities
    // as declared, context not measured unless `measured` is present.
    providers: options.providers.map((provider) => ({
      id: provider.id,
      status: provider.status,
      // `class` and `homepage` are part of the declaration; both are honest
      // about the provider's nature, not about our readiness.
      class: (provider as unknown as Record<string, unknown>)['class'],
      homepage: (provider as unknown as Record<string, unknown>)['homepage'],
      channels: provider.channels.map((channel) => ({
        id: channel.id,
        kind: channel.kind,
        // concurrency is the only channel knob the gateway enforces today.
        concurrency: (channel as unknown as Record<string, unknown>)['concurrency'] ?? 1,
      })),
      models: provider.models.map((model) => ({
        alias: model.alias,
        native: (model as unknown as Record<string, unknown>)['native'],
        modality: model.modality,
        capability: (model as unknown as Record<string, unknown>)['capability'],
        // Top-level context is shared; per-model capability may override it.
        context: provider.context,
      })),
      accounts: options.accounts.size(provider.id),
      capture: (provider as unknown as Record<string, unknown>)['capture'],
    })),
  };
}

function health(options: GatewayOptions, runtime: Runtime): unknown {
  return {
    status: 'ok',
    time: Math.floor(runtime.now() / 1000),
    // In the order they are tried, user plugins first.
    dialects: runtime.routes.map((route) => route.name),
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
    // What is in flight and what is waiting for a slot. Empty when the gateway is idle.
    inFlight: runtime.gate.snapshot(),
  };
}

/**
 * `/v1/models`, answered for both dialects at once.
 *
 * OpenAI and Anthropic both define this path and disagree about the field names. Each
 * entry therefore carries both sets, and the envelope carries both envelopes. That is a
 * superset rather than a fiction: every field says something true, and either client
 * finds what it looks for instead of one of them getting a 404.
 */
function models(options: GatewayOptions, runtime: Runtime): unknown {
  const created = Math.floor(runtime.now() / 1000);
  const data = listModelIds(options.providers).map((id) => ({
    id,
    object: 'model',
    type: 'model',
    created,
    created_at: new Date(created * 1000).toISOString(),
    display_name: id,
    owned_by: id.includes('/') ? id.slice(0, id.indexOf('/')) : 'omniproxy',
  }));

  return {
    object: 'list',
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  };
}

/* ────────────────────────────── the shared request loop ────────────────────────────── */

async function handleCompletion<T>(
  dialect: DialectHooks<T>,
  routeContext: RouteContext,
  reader: BodyReader,
  response: ServerResponse,
  options: GatewayOptions,
  runtime: Runtime,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await reader.text());
  } catch (error) {
    const tooLarge = (error as Error).message === BODY_TOO_LARGE;
    const refused = tooLarge
      ? dialect.refuse(
          413,
          'too_large',
          'the request body is too large',
          `The gateway accepts up to ${MAX_BODY_BYTES / (1024 * 1024)}MB of conversation.`,
        )
      : dialect.refuse(
          400,
          'invalid_request',
          'the request body is not JSON',
          'Send a JSON body with Content-Type: application/json.',
        );
    return sendJson(response, refused.status, refused.body);
  }

  const planned = dialect.plan(body, options.providers, routeContext);
  if (planned.kind === 'refused') {
    return sendJson(response, planned.status, planned.body, planned.headers ?? {});
  }

  const opened = await openWithRetry(options, runtime, planned);
  if (opened.kind === 'failed') {
    const shaped = dialect.error(opened.error);
    return sendJson(response, shaped.status, shaped.body, retryAfterHeader(opened.error));
  }

  const account = opened.account;
  let settled = false;
  const settle = (error?: OmniError): void => {
    // Exactly once: a second call would double-count a success or rest an account twice.
    if (!account || settled) return;
    settled = true;
    if (error) options.accounts.fail(account.id, error);
    else options.accounts.succeed(account.id);
  };

  // The concurrency slot is held until the response is finished, streaming included.
  // Giving it back earlier would let a second request start while the first is still
  // talking, which is precisely the limit the declaration states.
  try {
    await dialect.respond({
      plan: planned,
      identity: dialect.identity(runtime.uuid),
      events: opened.stream,
      response,
      settle,
      promptChars: planned.prompt.length,
      asOmniError,
      log: runtime.log,
    });
  } finally {
    opened.release?.();
  }
}

/* ────────────────────────────── attempts and accounts ────────────────────────────── */

type Opened =
  | { kind: 'ok'; stream: AsyncGenerator<UMSEvent>; account?: Account; release?: Release }
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
async function openWithRetry<T>(
  options: GatewayOptions,
  runtime: Runtime,
  plan: RequestPlan<T>,
): Promise<Opened> {
  const route = plan.route;
  const needsAccount = route.provider.auth.kind !== 'none';
  const attempts = needsAccount ? Math.max(1, options.accounts.size(route.provider.id)) : 1;
  const tried = new Set<string>();
  const channel = pickChannel(route.provider);
  const isBusy = (accountId: string): boolean =>
    runtime.gate.isBusy(gateKey(route.provider.id, channel.id, accountId), channel.concurrency);
  let lastError: OmniError | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let account: Account | undefined;

    if (needsAccount) {
      const lease = options.accounts.nextFor(route.provider.id, tried, isBusy);

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

    // The provider's own limit on simultaneous requests, honoured per account. Taken
    // before anything is sent and given back in `finally`, wherever the response ends.
    let release: Release;
    try {
      release = await runtime.gate.acquire(
        gateKey(route.provider.id, channel.id, account?.id),
        channel.concurrency,
      );
    } catch (error) {
      if (error instanceof GateRefused) return { kind: 'failed', error: gateError(error, route) };
      throw error;
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
        prompt: plan.prompt,
        params: plan.params,
      },
    });

    const opened = await commit(events, route.provider.id);
    if (opened.kind === 'ok') {
      return account ? { ...opened, account, release } : { ...opened, release };
    }

    // The attempt is over; the next one takes its own slot, and may well take it on a
    // different account.
    release();
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

/**
 * A refusal from the gate, in the shape a client can act on.
 *
 * `rate_limit` rather than `internal`, because that is what it is: the limit is the
 * provider's, and we are simply the ones holding the line in front of it.
 */
function gateError(refused: GateRefused, route: Route): OmniError {
  return {
    code: 'rate_limit',
    message: refused.message,
    userAction: refused.userAction,
    retryable: 'same-account',
    ...(refused.reason === 'timed-out' ? { retryAfterMs: 5_000 } : {}),
    provider: route.provider.id,
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

function retryAfterHeader(error: OmniError): Record<string, string> {
  if (typeof error.retryAfterMs !== 'number') return {};
  return { 'retry-after': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) };
}

/**
 * Constant-time comparison of the proxy's own key. True means "refuse this request".
 *
 * Every style is accepted, because every client exists: OpenAI SDKs send
 * `Authorization: Bearer`, Anthropic SDKs send `x-api-key`, Google SDKs send
 * `x-goog-api-key` or a `?key=` parameter. Refusing any of them would defeat the point
 * of serving their protocols.
 *
 * The query parameter is Google's own design and not ours to fix; it is accepted so
 * their SDKs work, and `serve` still refuses a non-loopback bind without a key, which
 * is what keeps a key in a URL from being the weakest link.
 *
 * The key guards someone's accounts, and a length-leaking comparison is a five-minute
 * attack on a service that is, by design, reachable from the machine it runs on.
 */
export function needsApiKey(
  request: IncomingMessage,
  url: URL,
  expected: string | undefined,
): boolean {
  if (!expected) return false;

  const header = (name: string): string => {
    const value = request.headers[name];
    return typeof value === 'string' ? value : '';
  };

  const candidates = [
    header('authorization').replace(/^Bearer\s+/i, ''),
    // Anthropic SDKs.
    header('x-api-key'),
    // Google SDKs, which send either this header or a `key` query parameter.
    header('x-goog-api-key'),
    url.searchParams.get('key') ?? '',
  ];

  const wanted = Buffer.from(expected);
  for (const candidate of candidates) {
    const presented = Buffer.from(candidate);
    if (presented.length === wanted.length && timingSafeEqual(presented, wanted)) return false;
  }
  return true;
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
    'access-control-allow-headers':
      'authorization, content-type, x-api-key, x-goog-api-key, anthropic-version',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  };
}

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const BODY_TOO_LARGE = 'request body too large';

/**
 * The request body, read once and shared.
 *
 * A side endpoint that peeks at the body would otherwise consume the stream the request
 * loop needs, and the symptom — an empty conversation, only when some plugin happens to
 * look first — is the kind of bug that takes an afternoon to find.
 */
interface BodyReader {
  text(): Promise<string>;
  /** The body as JSON, or `undefined` when there is none or it does not parse. */
  json(): Promise<unknown>;
}

function bodyOnce(request: IncomingMessage): BodyReader {
  let raw: Promise<string> | undefined;
  const text = (): Promise<string> => (raw ??= readBody(request));
  return {
    text,
    async json() {
      try {
        return JSON.parse(await text());
      } catch {
        return undefined;
      }
    },
  };
}

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
