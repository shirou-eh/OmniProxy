/**
 * What the engine needs from the outside world, and nothing more.
 *
 * These interfaces move to `packages/core/ports` in phase 2, when there is a core to
 * move them into. They live here now so the engine can be written and tested without
 * waiting for it — and so that no part of the engine ever reaches for `fetch`,
 * `process.env` or the filesystem directly. That restriction is what makes replay
 * possible, and replay is what makes twenty providers maintainable.
 */

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Explicit order matters for fingerprinting; the transport honours it if it can. */
  headerOrder?: string[];
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HttpStreamResponse {
  status: number;
  headers: Record<string, string>;
  /** Decoded text chunks. Empty when the response was not a success. */
  stream: AsyncIterable<Uint8Array>;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
  stream(request: HttpRequest): Promise<HttpStreamResponse>;
}

/** Per-session upstream state: the provider's own chat id, parent message id, … */
export interface StateStore {
  get(): Record<string, unknown>;
  set(patch: Record<string, unknown>): void;
}

export function memoryStateStore(initial: Record<string, unknown> = {}): StateStore {
  let state = { ...initial };
  return {
    get: () => ({ ...state }),
    set: (patch) => {
      state = { ...state, ...patch };
    },
  };
}
