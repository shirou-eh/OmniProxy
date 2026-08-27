/**
 * @omniproxy/gateway — the HTTP surface.
 *
 * Routing, accounts and the request loop. The gateway knows nothing about any specific
 * provider: it resolves a model name to a declaration, hands the declaration to the
 * engine, and turns the resulting UMS events into whichever dialect the caller asked
 * for. There is no `if (provider === …)` here, and there never will be (§12.3).
 */

export { createGatewayHandler, asOmniError, needsApiKey, corsHeaders, MAX_BODY_BYTES } from './server.js';
export type { GatewayOptions, GatewayHandler } from './server.js';

export { openAiDialect, numericParams } from './openai.js';
export { anthropicDialect } from './anthropic.js';
export { geminiDialect, geminiModels, countTokens } from './gemini.js';
export { ollamaDialect, ollamaTags, ollamaShow, ollamaVersion } from './ollama.js';
export type { DialectHooks, RequestPlan, Refusal, RefusalKind, RespondContext } from './dialect.js';

export { serve, isLoopback, ServeError } from './serve.js';
export type { ServeOptions, RunningGateway } from './serve.js';

export { resolveRoute, listModelIds, RoutingError } from './router.js';
export type { Route } from './router.js';

export { ConcurrencyGate, GateRefused, gateKey } from './gate.js';
export type { GateOptions, Release } from './gate.js';

export { AccountPool, parseAccountsFile, AccountFileError } from './accounts.js';
export type { Account, AccountLease, AccountSnapshot, PoolOptions } from './accounts.js';
