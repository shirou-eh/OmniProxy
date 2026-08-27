import { isEventStream, parseSseFrame } from '@omniproxy/capture';
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
} from '@omniproxy/engine-declarative';
import type {
  CaptureBundle,
  CaptureEntry,
  CaptureFrame,
  CaptureMethod,
  HeaderPair,
} from '@omniproxy/schema';

/**
 * An HTTP client that writes down everything it does.
 *
 * This is what makes rule 12.1 — no adapter without a capture — affordable rather
 * than merely stated. A capture no longer requires a browser, an extension and a
 * cooperative user: any flow the engine can run, it can run while recording, and what
 * comes out is the same `CaptureBundle` a HAR import produces. Sanitization, analysis,
 * diffing and fixtures all work on it unchanged.
 *
 * Two properties it must have, and a test for each:
 *
 *  - **Recording changes nothing.** The bytes the caller sees are the bytes that
 *    arrived, in the same chunks, at the same times. A recorder that buffers a stream
 *    to disk before passing it on would turn a streaming provider into a batch one and
 *    nobody would notice until a user complained about latency.
 *  - **A recorded bundle is unsanitized by construction.** It holds live cookies. It
 *    is marked `sanitized: false` and belongs in the raw cache, never in `fixtures/`
 *    (§12.7); `writeFixture` refuses it, and that refusal is the safety net.
 */

export interface RecorderOptions {
  providerId: string;
  scenario: string;
  /** How this was recorded. Defaults to `cdp`-equivalent live recording. */
  method?: CaptureMethod;
  /** For the audit trail: which command produced this. */
  source?: string;
  now?: () => number;
  /** Bodies above this many characters are truncated with a note. */
  maxBodyChars?: number;
}

export interface Recording {
  client: HttpClient;
  /** The bundle so far. Safe to call mid-flow. */
  bundle(): CaptureBundle;
  /** How many exchanges have completed. */
  size(): number;
}

const DEFAULT_MAX_BODY = 2_000_000;

export function recordingHttpClient(inner: HttpClient, options: RecorderOptions): Recording {
  const now = options.now ?? (() => Date.now());
  const maxBody = options.maxBodyChars ?? DEFAULT_MAX_BODY;
  const entries: CaptureEntry[] = [];
  const notes: string[] = [];
  const startedAt = now();

  const record = (entry: Omit<CaptureEntry, 'index' | 'classification'>): void => {
    entries.push({ ...entry, index: entries.length, classification: 'unknown' });
  };

  const clip = (body: string, label: string): string => {
    if (body.length <= maxBody) return body;
    notes.push(`${label} was truncated at ${maxBody} characters`);
    return body.slice(0, maxBody);
  };

  const client: HttpClient = {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const began = now();
      try {
        const response = await inner.request(request);
        record({
          startedAt: began,
          durationMs: now() - began,
          request: toCaptureRequest(request),
          response: {
            status: response.status,
            headers: toPairs(response.headers),
            body: clip(response.body, `${request.method} ${request.url}`),
            bodyEncoding: 'utf8',
            ...(response.headers['content-type']
              ? { mimeType: response.headers['content-type'] }
              : {}),
          },
        });
        return response;
      } catch (error) {
        recordFailure(record, began, now, request, error);
        throw error;
      }
    },

    async stream(request: HttpRequest): Promise<HttpStreamResponse> {
      const began = now();
      let upstream: HttpStreamResponse;
      try {
        upstream = await inner.stream(request);
      } catch (error) {
        recordFailure(record, began, now, request, error);
        throw error;
      }

      const mimeType = upstream.headers['content-type'];
      const collected: string[] = [];
      // Binary bodies are kept as bytes and stored base64. Decoding a WASM module as
      // UTF-8 and writing the result down loses it: replacement characters are not a
      // lossless round trip, so a replayed capture could never re-run the proof of
      // work it was recorded solving.
      const binary = !isTextual(mimeType);
      const rawChunks: Uint8Array[] = [];
      let closed = false;

      // Frames are cut as they arrive, not from the finished body, so each one carries
      // the moment it actually landed. That is the whole reason a live recorder beats
      // a HAR file: time-to-first-token and a stall mid-stream are visible here and
      // nowhere else, and they are what a user reports as "it got slow".
      const framer = isEventStream(mimeType) ? new LiveSseFramer(began) : undefined;

      // Written on the first of: stream exhausted, consumer stops early, or the
      // stream errors. A flow that dies halfway is exactly the flow worth having
      // recorded, so the entry must not depend on a clean finish.
      const finish = (): void => {
        if (closed) return;
        closed = true;
        const body = binary
          ? Buffer.concat(rawChunks.map((chunk) => Buffer.from(chunk))).toString('base64')
          : clip(collected.join(''), `${request.method} ${request.url}`);
        record({
          startedAt: began,
          durationMs: now() - began,
          request: toCaptureRequest(request),
          response: {
            status: upstream.status,
            headers: toPairs(upstream.headers),
            body,
            bodyEncoding: binary ? 'base64' : 'utf8',
            ...(mimeType ? { mimeType } : {}),
            ...(framer ? { frames: framer.finish(now()) } : {}),
          },
        });
      };

      const decoder = new TextDecoder();

      return {
        status: upstream.status,
        headers: upstream.headers,
        stream: (async function* () {
          try {
            for await (const chunk of upstream.stream) {
              // Record a copy, yield the original bytes. The consumer must receive
              // exactly what arrived — its own decoder handles the splits.
              if (binary) {
                rawChunks.push(chunk);
              } else {
                const text = decoder.decode(chunk, { stream: true });
                collected.push(text);
                framer?.push(text, now());
              }
              yield chunk;
            }
            if (!binary) {
              const tail = decoder.decode();
              collected.push(tail);
              framer?.push(tail, now());
            }
          } finally {
            finish();
          }
        })(),
      };
    },
  };

  return {
    client,
    size: () => entries.length,
    bundle: () => ({
      id: `${options.providerId}-${options.scenario}-${startedAt}`,
      providerId: options.providerId,
      capturedAt: new Date(startedAt).toISOString(),
      method: options.method ?? 'cdp',
      scenario: options.scenario,
      // Never true here. Sanitization is a separate, explicit step (§8.4).
      sanitized: false,
      entries: entries.map((entry) => ({ ...entry })),
      redactions: {},
      notes: [...notes],
      ...(options.source ? { source: options.source } : {}),
    }),
  };
}

/**
 * Whether a body can survive the round trip through a string.
 *
 * The list is a whitelist rather than a blacklist on purpose: an unrecognised type is
 * treated as binary and base64-encoded, which is merely verbose. Guessing the other
 * way corrupts the body, and the corruption only shows up when someone tries to
 * replay the capture months later.
 */
function isTextual(mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  const type = mimeType.toLowerCase();
  return (
    type.startsWith('text/') ||
    type.includes('json') ||
    type.includes('xml') ||
    type.includes('x-www-form-urlencoded') ||
    type.includes('javascript')
  );
}

/**
 * Cuts SSE frames as the bytes arrive, stamping each with the time it completed.
 *
 * `parseSseStream` does the same job on a finished body and is the right tool for a
 * HAR import; it cannot recover timings that the file never held. Here they exist, so
 * they are kept.
 */
class LiveSseFramer {
  #buffer = '';
  readonly #frames: CaptureFrame[] = [];

  constructor(private readonly began: number) {}

  push(text: string, at: number): void {
    if (text === '') return;
    this.#buffer += text;

    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.#buffer);
      if (!boundary) break;
      const block = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary[0].length);
      if (block.trim() !== '') this.#frames.push(parseSseFrame(block, at - this.began));
    }
  }

  /** Keeps a trailing frame with no blank line: a cut-off stream ends exactly so. */
  finish(at: number): CaptureFrame[] {
    const remainder = this.#buffer;
    this.#buffer = '';
    if (remainder.trim() !== '') this.#frames.push(parseSseFrame(remainder, at - this.began));
    return this.#frames;
  }
}

/**
 * A request that never got an answer is still evidence — often the most valuable
 * kind, since "it fails and I do not know why" is the case a capture is being taken
 * for. Status 0 marks it as having no response rather than an empty one.
 */
function recordFailure(
  record: (entry: Omit<CaptureEntry, 'index' | 'classification'>) => void,
  began: number,
  now: () => number,
  request: HttpRequest,
  error: unknown,
): void {
  record({
    startedAt: began,
    durationMs: now() - began,
    request: toCaptureRequest(request),
    response: {
      status: 0,
      statusText: error instanceof Error ? error.message : String(error),
      headers: [],
    },
  });
}

function toCaptureRequest(request: HttpRequest) {
  return {
    method: request.method,
    url: request.url,
    headers: toPairs(request.headers, request.headerOrder),
    ...(request.body !== undefined ? { body: request.body, bodyEncoding: 'utf8' as const } : {}),
  };
}

/** Header order is fingerprint material, so it is preserved as the caller meant it. */
function toPairs(
  headers: Record<string, string>,
  order?: readonly string[],
): HeaderPair[] {
  const pairs: HeaderPair[] = Object.entries(headers);
  if (!order || order.length === 0) return pairs;

  const rank = new Map(order.map((name, index) => [name.toLowerCase(), index]));
  return pairs.sort(([a], [b]) => {
    const left = rank.get(a.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const right = rank.get(b.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}
