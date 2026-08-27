import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
} from '@omniproxy/engine-declarative';

/**
 * The ordinary HTTP client: Node's built-in fetch, and nothing clever.
 *
 * It is deliberately thin. Everything interesting — retries, account rotation,
 * fingerprinting, TLS impersonation — belongs to layers above and beside this one,
 * where it can be tested without a socket. What lives here is the part that genuinely
 * needs the network, so that everything else can be run without it.
 *
 * `headerOrder` is honoured as far as this transport can: `fetch` gives no control
 * over the wire order of headers, so the ordering here is best-effort and the
 * impersonating sidecar (ADR-0001) is what a provider needing real order will use.
 * Saying that out loud matters — a fingerprint that is quietly not applied is worse
 * than one that is openly missing, because it produces bans nobody can explain.
 */

export interface FetchClientOptions {
  /** Applied when a request does not carry its own. */
  defaultTimeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
}

export class TransportError extends Error {
  override readonly name = 'TransportError';
  constructor(
    message: string,
    readonly userAction: string,
    readonly kind: 'timeout' | 'network' | 'aborted',
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function fetchHttpClient(options: FetchClientOptions = {}): HttpClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;

  const send = async (request: HttpRequest): Promise<Response> => {
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? anySignal([request.signal, timeout]) : timeout;

    const init: RequestInit = {
      method: request.method,
      headers: orderHeaders(request.headers, request.headerOrder),
      signal,
      redirect: 'follow',
    };
    if (request.body !== undefined) init.body = request.body;

    try {
      return await doFetch(request.url, init);
    } catch (error) {
      throw describe(error, request, timeoutMs);
    }
  };

  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const response = await send(request);
      return {
        status: response.status,
        headers: collectHeaders(response),
        body: await response.text(),
      };
    },

    async stream(request: HttpRequest): Promise<HttpStreamResponse> {
      const response = await send(request);
      return {
        status: response.status,
        headers: collectHeaders(response),
        stream: iterate(response),
      };
    },
  };
}

/** Turns a fetch body into the async iterable the engine consumes. */
async function* iterate(response: Response): AsyncIterable<Uint8Array> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    // Releasing matters on an early return: an abandoned reader keeps the socket.
    reader.releaseLock();
  }
}

function collectHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/**
 * Orders headers as the declaration asked, with anything unlisted appended in its
 * original order. Best-effort by nature — see the note at the top of this file.
 */
function orderHeaders(
  headers: Record<string, string>,
  order: readonly string[] | undefined,
): [string, string][] {
  const entries = Object.entries(headers);
  if (!order || order.length === 0) return entries;

  const rank = new Map(order.map((name, index) => [name.toLowerCase(), index]));
  return entries.sort(([a], [b]) => {
    const left = rank.get(a.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const right = rank.get(b.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

/**
 * `AbortSignal.any` exists on Node 20+, but a project that runs on whatever the user
 * has installed cannot assume it. The fallback is small enough to be obviously right.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyOf = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyOf === 'function') return anyOf(signals);

  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * A network failure with a name and a next step.
 *
 * `fetch failed` with no further detail is the single least useful message in this
 * whole system: it is what the user sees when their proxy is misconfigured, when the
 * provider is down, and when their DNS is broken, and it distinguishes none of them.
 */
function describe(error: unknown, request: HttpRequest, timeoutMs: number): TransportError {
  const host = safeHost(request.url);

  if (error instanceof Error && error.name === 'TimeoutError') {
    return new TransportError(
      `${request.method} ${host} timed out after ${timeoutMs}ms`,
      'Raise timeoutMs for this step if the provider is simply slow; if every request ' +
        'times out, check the proxy settings and whether the host is reachable at all.',
      'timeout',
      { cause: error },
    );
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new TransportError(
      `${request.method} ${host} was cancelled`,
      'This is normal when a client disconnects mid-stream.',
      'aborted',
      { cause: error },
    );
  }

  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined;
  const detail = cause?.message ?? (error instanceof Error ? error.message : String(error));
  return new TransportError(
    `${request.method} ${host} failed: ${detail}`,
    'Check that the host resolves and that any proxy is reachable: omniproxy doctor.',
    'network',
    { cause: error },
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
