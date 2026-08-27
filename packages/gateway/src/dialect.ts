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
