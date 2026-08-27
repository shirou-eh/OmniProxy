import type {
  Channel,
  ErrorRule,
  OmniError,
  ProviderDeclaration,
  RequestSpec,
  StepSpec,
  UMSEvent,
  FinishReason,
} from '@omniproxy/schema';
import { createFramer, type FrameEvent } from './framing.js';
import { selectJsonPath } from './jsonpath.js';
import type { HttpClient, HttpRequest, StateStore } from './ports.js';
import { renderTemplate, renderValue, type TemplateContext } from './template.js';
import type { TransformContext, TransformRegistry } from './transforms.js';

/**
 * Runs a declaration's `flow` and yields UMS events.
 *
 * The order is fixed and deliberate: `prepare` steps, then `createSession`, then the
 * `vars` transforms, then `send`. Transforms run last because they usually depend on
 * something the earlier steps extracted — a proof-of-work challenge, an upload token —
 * and a value cannot be computed from data that has not arrived.
 *
 * Everything the flow learns lands in one of two places: `extracted`, which lives for
 * this one execution, and `state`, which is the session's memory of the upstream and
 * survives between requests. Keeping them apart is what makes a lost session
 * recoverable instead of mysterious.
 */

export interface ExecuteOptions {
  declaration: ProviderDeclaration;
  /** Which channel to use. Defaults to the first HTTP-ish one. */
  channelId?: string;
  http: HttpClient;
  transforms: TransformRegistry;
  transformContext: TransformContext;
  /** Credential fields, already decrypted. */
  auth?: Record<string, unknown>;
  state: StateStore;
  request: EngineRequest;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  now?: () => number;
}

export interface EngineRequest {
  /** Public alias; resolved to the provider's native model name. */
  model: string;
  prompt?: string;
  messages?: unknown[];
  params?: Record<string, unknown>;
}

export class DeclarationExecutionError extends Error {
  override readonly name = 'DeclarationExecutionError';
  constructor(
    message: string,
    readonly omni: OmniError,
  ) {
    super(message);
  }
}

export async function* executeFlow(options: ExecuteOptions): AsyncGenerator<UMSEvent> {
  const { declaration } = options;
  const channel = pickChannel(declaration, options.channelId);
  const model = resolveModel(declaration, options.request.model);

  yield {
    type: 'start',
    provider: declaration.id,
    channel: channel.id,
    model: model.native,
  };

  const extracted: Record<string, unknown> = {};
  const vars: Record<string, unknown> = {};
  const now = options.now ?? (() => Date.now());

  const context = (): TemplateContext => {
    const timestamp = now();
    return {
      req: {
        ...options.request,
        model: model.native,
        alias: model.alias,
        params: options.request.params ?? {},
      },
      auth: options.auth ?? {},
      state: options.state.get(),
      vars,
      extracted,
      env: options.env ?? {},
      channel: { id: channel.id, base: channel.base ?? '' },
      now: {
        unixMs: timestamp,
        unixS: Math.floor(timestamp / 1000),
        iso: new Date(timestamp).toISOString(),
      },
    };
  };

  const runStep = async (step: StepSpec, label: string): Promise<void> => {
    if (!shouldRun(step, context())) return;

    const request = buildRequest(step.request, channel, declaration, context(), label);
    // Before the request, not after: a declaration can come from a stranger, and a
    // host check that runs once the cookies are already on the wire checks nothing.
    assertAllowedHost(declaration, channel, request.url, label);

    const response = await options.http.request({ ...request, signal: options.signal });
    throwOnErrorRules(declaration, response.status, response.body, label);

    if (step.extract) {
      const parsed = parseJson(response.body, label);
      for (const [name, path] of Object.entries(step.extract)) {
        const value = selectJsonPath(parsed, path);
        if (value === undefined) {
          throw new DeclarationExecutionError(`${label}: ${path} matched nothing`, {
            code: 'upstream_schema_changed',
            message: `${declaration.id}: ${label} expected ${path} in the response and it was not there.`,
            userAction:
              `Re-record this scenario and compare: omniproxy capture analyze. ` +
              `If the provider changed shape, fix ${path} in the declaration.`,
            retryable: 'no',
            provider: declaration.id,
            channel: channel.id,
          });
        }
        extracted[name] = value;
      }
    }

    applyPersist(step, context(), options.state);
  };

  for (const [index, step] of declaration.flow.prepare.entries()) {
    await runStep(step, `flow.prepare[${index}]`);
  }

  if (declaration.flow.createSession) {
    await runStep(declaration.flow.createSession, 'flow.createSession');
  }

  for (const [name, spec] of Object.entries(declaration.vars)) {
    const rendered = renderValue(spec.with, context());
    vars[name] = await options.transforms.run(
      spec.transform,
      (rendered.value ?? {}) as Record<string, unknown>,
      options.transformContext,
    );
  }

  const send = declaration.flow.send;
  if (!send) {
    throw new DeclarationExecutionError('this declaration has no flow.send', {
      code: 'not_implemented',
      message: `${declaration.id} declares no flow.send, so it cannot answer a chat request.`,
      userAction: 'Add a flow.send step, or route this request to a job flow (flow.submit).',
      retryable: 'no',
      provider: declaration.id,
    });
  }

  if (!shouldRun(send, context())) {
    throw new DeclarationExecutionError('flow.send was skipped by its own condition', {
      code: 'internal',
      message: `${declaration.id}: flow.send has a when/unless that skipped it.`,
      userAction: 'Remove the condition from flow.send — it must always run.',
      retryable: 'no',
      provider: declaration.id,
    });
  }

  const sendRequest = buildRequest(send.request, channel, declaration, context(), 'flow.send', model.extra);
  assertAllowedHost(declaration, channel, sendRequest.url, 'flow.send');

  if (!send.stream) {
    const response = await options.http.request({ ...sendRequest, signal: options.signal });
    throwOnErrorRules(declaration, response.status, response.body, 'flow.send');
    yield* emitNonStreamed(response.body, send, extracted, options.state, context);
    return;
  }

  const streamed = await options.http.stream({ ...sendRequest, signal: options.signal });
  if (streamed.status >= 400) {
    const body = await readAll(streamed.stream);
    throwOnErrorRules(declaration, streamed.status, body, 'flow.send');
    throw new DeclarationExecutionError(`flow.send failed with HTTP ${streamed.status}`, {
      code: streamed.status === 429 ? 'rate_limit' : 'upstream_unavailable',
      message: `${declaration.id} answered HTTP ${streamed.status}.`,
      userAction:
        streamed.status === 429
          ? 'Wait for the quota to reset, or add another account.'
          : 'Run omniproxy doctor; if the endpoint is gone, re-record the scenario.',
      retryable: streamed.status === 429 ? 'other-account' : 'same-account',
      provider: declaration.id,
      channel: channel.id,
    });
  }

  const framer = createFramer(send.stream);
  // One decoder for the whole stream: a multi-byte character split across two chunks
  // must not become two broken ones. (Cyrillic and emoji hit this immediately.)
  const decoder = new TextDecoder();
  let finish: string | undefined;
  let sawText = false;

  for await (const chunk of streamed.stream) {
    for (const event of framer.push(decoder.decode(chunk, { stream: true }))) {
      const emitted = toUmsEvent(event, declaration, extracted, options.state);
      if (emitted) {
        if (emitted.type === 'text.delta') sawText = true;
        yield emitted;
      }
      if (event.kind === 'finish') finish = event.reason;
    }
  }

  for (const event of framer.end()) {
    const emitted = toUmsEvent(event, declaration, extracted, options.state);
    if (emitted) {
      if (emitted.type === 'text.delta') sawText = true;
      yield emitted;
    }
    if (event.kind === 'finish') finish = event.reason;
  }

  applyPersist(send, context(), options.state);

  if (!sawText) {
    yield {
      type: 'warning',
      code: 'empty_response',
      message:
        'The provider streamed no text. Either the stream mapping no longer matches the ' +
        'response shape, or the account hit a silent limit.',
    };
  }

  yield { type: 'done', finishReason: normaliseFinish(finish) };
}

/* ─────────────────────────────── request building ─────────────────────────────── */

export function buildRequest(
  spec: RequestSpec,
  channel: Channel,
  declaration: ProviderDeclaration,
  context: TemplateContext,
  label: string,
  extra?: Record<string, unknown>,
): HttpRequest {
  const unresolved: string[] = [];

  const collect = <T extends { unresolved: string[] }>(result: T): T => {
    unresolved.push(...result.unresolved);
    return result;
  };

  const base = channel.base ?? '';
  const rawUrl = spec.url ?? `${base.replace(/\/$/, '')}${spec.path ?? ''}`;
  const url = new URL(collect(renderTemplate(rawUrl, context)).value);

  for (const [name, value] of Object.entries(spec.query ?? {})) {
    url.searchParams.set(name, collect(renderTemplate(value, context)).value);
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(channel.fingerprint.static)) {
    headers[name.toLowerCase()] = value;
  }
  for (const [name, value] of Object.entries(declaration.auth.present.headers)) {
    headers[name.toLowerCase()] = collect(renderTemplate(value, context)).value;
  }
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    headers[name.toLowerCase()] = collect(renderTemplate(value, context)).value;
  }

  let body: string | undefined;
  if (spec.json !== undefined) {
    const rendered = collect(renderValue(spec.json, context));
    const merged =
      extra && rendered.value !== null && typeof rendered.value === 'object'
        ? { ...(rendered.value as Record<string, unknown>), ...renderValue(extra, context).value as Record<string, unknown> }
        : rendered.value;
    body = JSON.stringify(merged ?? null);
    headers['content-type'] ??= 'application/json';
  } else if (spec.form !== undefined) {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(spec.form)) {
      params.append(name, collect(renderTemplate(value, context)).value);
    }
    body = params.toString();
    headers['content-type'] ??= 'application/x-www-form-urlencoded';
  } else if (spec.body !== undefined) {
    body = collect(renderTemplate(spec.body, context)).value;
  }

  if (unresolved.length > 0) {
    // Every one of these would have become an empty string in a request that then
    // fails somewhere far away with a message about nothing in particular.
    throw new DeclarationExecutionError(
      `${label}: unresolved template placeholders: ${[...new Set(unresolved)].join(', ')}`,
      {
        code: 'internal',
        message:
          `${declaration.id}: ${label} refers to ${[...new Set(unresolved)].join(', ')}, ` +
          'which is empty at this point in the flow.',
        userAction:
          'Check the order of your flow steps — a value has to be extracted before it can be used.',
        retryable: 'no',
        provider: declaration.id,
        channel: channel.id,
      },
    );
  }

  const request: HttpRequest = {
    method: spec.method,
    url: url.toString(),
    headers,
  };
  if (body !== undefined) request.body = body;
  if (spec.timeoutMs !== undefined) request.timeoutMs = spec.timeoutMs;
  if (channel.fingerprint.headerOrder) request.headerOrder = channel.fingerprint.headerOrder;
  return request;
}

/* ──────────────────────────────────── helpers ──────────────────────────────────── */

export function pickChannel(declaration: ProviderDeclaration, channelId?: string): Channel {
  if (channelId) {
    const found = declaration.channels.find((channel) => channel.id === channelId);
    if (!found) {
      throw new DeclarationExecutionError(`no channel "${channelId}"`, {
        code: 'invalid_request',
        message: `${declaration.id} has no channel called "${channelId}".`,
        userAction: `Available channels: ${declaration.channels.map((c) => c.id).join(', ')}.`,
        retryable: 'no',
        provider: declaration.id,
      });
    }
    return found;
  }

  const executable = declaration.channels.find(
    (channel) => channel.kind === 'web-http' || channel.kind === 'app-backend',
  );
  if (!executable) {
    throw new DeclarationExecutionError('no HTTP channel to execute', {
      code: 'not_implemented',
      message: `${declaration.id} has no web-http or app-backend channel.`,
      userAction:
        'The declarative engine runs HTTP channels. Browser and local-process channels arrive in phase 2.',
      retryable: 'no',
      provider: declaration.id,
    });
  }
  return executable;
}

export function resolveModel(
  declaration: ProviderDeclaration,
  alias: string,
): { alias: string; native: string; extra?: Record<string, unknown> } {
  const found = declaration.models.find((model) => model.alias === alias);
  if (found) {
    const result: { alias: string; native: string; extra?: Record<string, unknown> } = {
      alias: found.alias,
      native: found.native,
    };
    if (found.extra) result.extra = found.extra;
    return result;
  }

  // No silent substitution. A client that asked for one model and got another has
  // been lied to, and will not find out until the answers are subtly wrong.
  throw new DeclarationExecutionError(`unknown model alias "${alias}"`, {
    code: 'invalid_request',
    message: `${declaration.id} has no model called "${alias}".`,
    userAction: `Available: ${declaration.models.map((m) => m.alias).join(', ') || '(none declared)'}.`,
    retryable: 'no',
    provider: declaration.id,
  });
}

function shouldRun(step: StepSpec, context: TemplateContext): boolean {
  if (step.when !== undefined) {
    const { value } = renderTemplate(step.when, context);
    if (value.trim() === '' || value === 'false') return false;
  }
  if (step.unless !== undefined) {
    const { value } = renderTemplate(step.unless, context);
    if (value.trim() !== '' && value !== 'false') return false;
  }
  return true;
}

function applyPersist(step: StepSpec, context: TemplateContext, state: StateStore): void {
  if (!step.persist) return;
  const patch: Record<string, unknown> = {};
  for (const [name, template] of Object.entries(step.persist)) {
    const { value, unresolved } = renderTemplate(template, context);
    if (unresolved.length === 0) patch[name] = value;
  }
  if (Object.keys(patch).length > 0) state.set(patch);
}

function parseJson(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new DeclarationExecutionError(`${label}: response was not JSON`, {
      code: 'upstream_schema_changed',
      message: `${label} expected JSON and got something else: ${body.slice(0, 120)}`,
      userAction:
        'This is usually an anti-bot challenge page or an expired session. ' +
        'Re-authenticate, then re-record the scenario if it persists.',
      retryable: 'no',
    });
  }
}

export function matchErrorRule(
  rules: readonly ErrorRule[],
  status: number,
  body: string,
): ErrorRule | undefined {
  let parsed: unknown;
  let parsedOnce = false;

  for (const rule of rules) {
    const { match } = rule;
    if (match.status !== undefined && match.status !== status) continue;
    if (match.bodyContains !== undefined && !body.includes(match.bodyContains)) continue;

    if (match.jsonPath !== undefined) {
      if (!parsedOnce) {
        parsedOnce = true;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }
      }
      const value = selectJsonPath(parsed, match.jsonPath);
      if (value === undefined) continue;
      if (match.equals !== undefined && String(value) !== String(match.equals)) continue;
    }

    return rule;
  }

  return undefined;
}

function throwOnErrorRules(
  declaration: ProviderDeclaration,
  status: number,
  body: string,
  label: string,
): void {
  const rule = matchErrorRule(declaration.errors, status, body);
  if (rule) {
    throw new DeclarationExecutionError(`${label}: ${rule.as}`, {
      code: rule.as,
      message: rule.userMessage ?? `${declaration.id} returned ${rule.as} on ${label}.`,
      userAction: rule.userMessage ?? 'See the provider documentation in docs/providers.',
      retryable: rule.retryable,
      provider: declaration.id,
    });
  }

  if (status >= 400) {
    throw new DeclarationExecutionError(`${label}: HTTP ${status}`, {
      code: status === 401 || status === 403 ? 'auth_expired' : 'upstream_unavailable',
      message: `${declaration.id} answered HTTP ${status} on ${label}: ${body.slice(0, 200)}`,
      userAction:
        status === 401 || status === 403
          ? `Re-authenticate: omniproxy auth add ${declaration.id}`
          : 'Run omniproxy doctor. If the endpoint is gone, re-record the scenario.',
      retryable: status === 401 || status === 403 ? 'no' : 'same-account',
      provider: declaration.id,
    });
  }
}

function assertAllowedHost(
  declaration: ProviderDeclaration,
  channel: Channel,
  url: string,
  label: string,
): void {
  const host = new URL(url).host;
  const allowed = new Set(declaration.allowedHosts);
  for (const candidate of declaration.channels) {
    if (candidate.base) allowed.add(new URL(candidate.base).host);
    if (candidate.entryUrl) allowed.add(new URL(candidate.entryUrl).host);
  }

  if (allowed.has(host)) return;

  // A declaration is data, and data can arrive from a stranger (ADR-0003). Without
  // this, a shared declaration could quietly post your cookies somewhere else.
  throw new DeclarationExecutionError(`${label}: host ${host} is not allowed`, {
    code: 'invalid_request',
    message: `${declaration.id} tried to reach ${host}, which is not in its channels or allowedHosts.`,
    userAction: `If this is legitimate, add "${host}" to allowedHosts in the declaration.`,
    retryable: 'no',
    provider: declaration.id,
    channel: channel.id,
  });
}

function toUmsEvent(
  event: FrameEvent,
  declaration: ProviderDeclaration,
  extracted: Record<string, unknown>,
  state: StateStore,
): UMSEvent | undefined {
  switch (event.kind) {
    case 'text':
      return { type: 'text.delta', text: event.text };
    case 'reasoning':
      return { type: 'reasoning.delta', text: event.text };
    case 'search':
      return { type: 'search.delta', text: event.text };
    case 'messageId':
      extracted['messageId'] = event.id;
      state.set({ parentMessageId: event.id });
      return undefined;
    case 'usage':
      return { type: 'usage', usage: { estimated: true, ...(event.usage as object) } };
    case 'toolCalls':
      return {
        type: 'tool_call.delta',
        index: 0,
        argsDelta: JSON.stringify(event.value),
      };
    case 'warning':
      return { type: 'warning', code: event.code, message: event.message };
    case 'upstreamError':
      return {
        type: 'error',
        error: {
          code: 'upstream_unavailable',
          message: `${declaration.id}: ${event.message}`,
          userAction: 'Try again; if it repeats, check the provider status and your quota.',
          retryable: 'other-account',
          provider: declaration.id,
        },
      };
    case 'finish':
      return undefined;
  }
}

async function* emitNonStreamed(
  body: string,
  step: StepSpec,
  extracted: Record<string, unknown>,
  state: StateStore,
  context: () => TemplateContext,
): AsyncGenerator<UMSEvent> {
  const parsed = parseJson(body, 'flow.send');
  const map = step.response ?? step.stream?.map;

  if (map?.text) {
    const text = selectJsonPath(parsed, map.text);
    if (typeof text === 'string') yield { type: 'text.delta', text };
  }
  if (map?.reasoning) {
    const reasoning = selectJsonPath(parsed, map.reasoning);
    if (typeof reasoning === 'string' && reasoning !== '') {
      yield { type: 'reasoning.delta', text: reasoning };
    }
  }
  if (map?.usage) {
    const usage = selectJsonPath(parsed, map.usage);
    if (usage !== undefined && usage !== null) {
      yield { type: 'usage', usage: { estimated: true, ...(usage as object) } };
    }
  }
  if (map?.messageId) {
    const id = selectJsonPath(parsed, map.messageId);
    if (id !== undefined) {
      extracted['messageId'] = id;
      state.set({ parentMessageId: String(id) });
    }
  }

  applyPersist(step, context(), state);

  const finish = map?.finish ? selectJsonPath(parsed, map.finish) : undefined;
  yield { type: 'done', finishReason: normaliseFinish(typeof finish === 'string' ? finish : undefined) };
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

function normaliseFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'length':
    case 'LENGTH':
      return 'length';
    case 'content_filter':
    case 'CONTENT_FILTER':
      return 'content_filter';
    case 'tool_calls':
      return 'tool_calls';
    default:
      return 'stop';
  }
}
