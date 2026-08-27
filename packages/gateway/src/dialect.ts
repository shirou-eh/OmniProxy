import type { ServerResponse } from 'node:http';
import type { OmniError, ProviderDeclaration, UMSEvent } from '@omniproxy/schema';
import type { Route } from './router.js';

/**
 * What a public dialect has to provide, and nothing more.
 *
 * The request loop — routing, accounts, the concurrency gate, the retry rule, the
 * engine, the error mapping — is shared. A dialect supplies three things: how to read
 * a request, how to write a response, and how to phrase a refusal. Adding Gemini, or
 * a native OmniProxy protocol, or anything a user invents, means writing those three
 * and nothing else.
 *
 * If serving a second dialect had required touching the request loop, the universal
 * layers (UMR in, UMS out) would not be earning their keep. That they did not is the
 * measurable form of §4.
 */

/** A dialect-neutral name for the kind of refusal, which each dialect words its own way. */
export type RefusalKind =
  | 'invalid_request'
  | 'too_large'
  | 'not_found'
  | 'authentication'
  | 'rate_limit'
  | 'api';

export interface Refusal {
  kind: 'refused';
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RequestPlan<T> {
  kind: 'planned';
  /** The parsed request, kept so `respond` can read dialect-specific options off it. */
  request: T;
  route: Route;
  /** The whole conversation as one prompt, ready for the engine. */
  prompt: string;
  /** Canonical knobs a declaration may map onto provider fields. */
  params: Record<string, unknown>;
  stream: boolean;
}

export interface RespondContext<T> {
  plan: RequestPlan<T>;
  identity: { id: string; model: string };
  events: AsyncGenerator<UMSEvent>;
  response: ServerResponse;
  /** Records the outcome against the account that served it. Call exactly once. */
  settle(error?: OmniError): void;
  promptChars: number;
  asOmniError(error: unknown, provider: string): OmniError;
  log(line: string): void;
}

/**
 * Whatever the URL carried that the body does not.
 *
 * Gemini puts the model in the path (`/v1beta/models/x:generateContent`) and the
 * operation after a colon, so its converter cannot work from the body alone.
 */
export interface RouteContext {
  [key: string]: string;
}

export interface DialectHooks<T> {
  name: string;
  /** Reads a request, or refuses it in this dialect's own words. */
  plan(
    body: unknown,
    providers: readonly ProviderDeclaration[],
    context?: RouteContext,
  ): RequestPlan<T> | Refusal;
  /** A response id, in whatever shape this dialect's clients expect. */
  identity(uuid: () => string): { id: string; model: string };
  respond(context: RespondContext<T>): Promise<void>;
  /** An engine or gateway failure, shaped for this dialect. */
  error(error: OmniError): { status: number; body: unknown };
  /** A refusal raised before the request was ever read. */
  refuse(status: number, kind: RefusalKind, message: string, action: string): Refusal;
}

/* ─────────────────────────────── mounting a dialect ─────────────────────────────── */

/**
 * A request to an endpoint that reaches no provider and spends no account.
 *
 * Model lists, capability probes, `countTokens` — the calls a client makes before it
 * asks for anything. They get the declarations and the clock, and nothing that could
 * start a conversation.
 */
export interface SideRequest {
  path: string;
  method: string;
  url: URL;
  providers: readonly ProviderDeclaration[];
  /**
   * The JSON body, or `undefined` when there is none or it does not parse.
   *
   * Read at most once per request however many handlers ask for it, and the completion
   * loop shares the same read — so looking at a body here never consumes it.
   */
  body(): Promise<unknown>;
  now(): number;
}

export interface SideResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * A dialect, mounted on paths.
 *
 * This is the whole extension surface, and it is the same one the four built-in
 * dialects use — there is no privileged path into the gateway that a plugin cannot
 * take. A user who wants a protocol we have never heard of writes one of these and
 * points `--dialect-dir` at it; nothing is forked and nothing here is patched.
 *
 * User plugins are matched **before** the built-ins, so claiming `/v1/chat/completions`
 * replaces ours rather than losing to it. That is deliberate: it is your gateway. The
 * shadowing is announced once in the log and then simply done.
 */
export interface DialectPlugin {
  /** Shown on `/health`. Two plugins may share a name; the first one mounted answers. */
  name: string;
  dialect: DialectHooks<never>;
  /**
   * Whether this dialect answers `path`, and what the URL carried that the body does
   * not. Returning `{}` means "yes, and the body says everything".
   *
   * A matcher rather than a list of paths because Google puts the model and the
   * operation in the URL, which a fixed path cannot express.
   */
  match(path: string, method: string): RouteContext | undefined;
  /**
   * The paths this dialect answers, for humans.
   *
   * Used only to tell someone who asked for a path that does not exist what does. A
   * matcher cannot be enumerated, so this is written out; leaving it off costs nothing
   * but a less helpful 404.
   */
  paths?: readonly string[];
  /** Endpoints that answer without reaching a provider. `undefined` means "not mine". */
  side?(request: SideRequest): SideResult | undefined | Promise<SideResult | undefined>;
}
