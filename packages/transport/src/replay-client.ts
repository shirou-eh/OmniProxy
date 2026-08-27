import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
} from '@omniproxy/engine-declarative';
import type { CaptureBundle, CaptureEntry } from '@omniproxy/schema';

/**
 * An HTTP client that answers from a recorded bundle.
 *
 * This is the maintenance story for twenty providers. A declaration that used to work
 * and no longer does is a five-minute problem when the last known-good exchange can be
 * replayed offline, and an evening otherwise. It also means a provider's contract can
 * run in CI without an account, without a quota, and without touching the network —
 * which is the only way the matrix stays green honestly rather than by being skipped.
 *
 * Matching is by method and path, in recorded order, because that is what a flow is:
 * the same endpoint appears twice with different bodies (poll, retry) and answering
 * the second call with the first response would make a broken flow look healthy.
 * A request the bundle does not contain is a loud failure, never a fabricated 200 —
 * inventing a response is precisely the thing §12.1 forbids.
 */

export interface ReplayOptions {
  /** Compare request bodies too, not just method and path. */
  strictBody?: boolean;
  /** Emit a streamed body in its recorded frames rather than one chunk. */
  replayFrames?: boolean;
  /**
   * Sleep between frames as they were recorded. Off by default: a test that waits out
   * a real conversation is a test nobody runs.
   */
  realTime?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReplayReport {
  /** Entries consumed, in order. */
  used: number[];
  /** Entries the flow never asked for — usually a sign the declaration drifted. */
  unused: number[];
}

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
  constructor(
    message: string,
    readonly userAction: string,
  ) {
    super(message);
  }
}

export function replayHttpClient(
  bundle: CaptureBundle,
  options: ReplayOptions = {},
): HttpClient & { report(): ReplayReport } {
  const remaining = bundle.entries.map((entry, position) => ({ entry, position }));
  const used: number[] = [];
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const take = (request: HttpRequest): CaptureEntry => {
    const wantedPath = pathOf(request.url);
    const index = remaining.findIndex(
      ({ entry }) =>
        entry.request.method.toUpperCase() === request.method.toUpperCase() &&
        pathOf(entry.request.url) === wantedPath &&
        (!options.strictBody || sameBody(entry.request.body, request.body)),
    );

    if (index === -1) {
      const offered = remaining
        .slice(0, 5)
        .map(({ entry }) => `${entry.request.method} ${pathOf(entry.request.url)}`);
      throw new ReplayError(
        `the capture has no unused ${request.method} ${wantedPath}`,
        remaining.length === 0
          ? 'The flow made more requests than were recorded. Re-record the scenario with ' +
            'omniproxy capture record so the bundle covers the whole flow.'
          : `Still unused: ${offered.join(', ')}. The declaration is asking for something ` +
            'the recording does not contain — either the flow changed, or the capture is ' +
            'from a different scenario.',
      );
    }

    const [{ entry, position }] = remaining.splice(index, 1) as [
      { entry: CaptureEntry; position: number },
    ];
    used.push(position);
    return entry;
  };

  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const entry = take(request);
      return {
        status: entry.response.status,
        headers: headersOf(entry),
        body: entry.response.body ?? '',
      };
    },

    async stream(request: HttpRequest): Promise<HttpStreamResponse> {
      const entry = take(request);
      const encoder = new TextEncoder();
      const frames = entry.response.frames ?? [];
      const useFrames = options.replayFrames !== false && frames.length > 0;

      return {
        status: entry.response.status,
        headers: headersOf(entry),
        stream: (async function* () {
          if (entry.response.bodyEncoding === 'base64') {
            // A binary body — a WASM module, an image — comes back as the exact bytes
            // that were recorded, not as a lossy text round trip.
            const bytes = Buffer.from(entry.response.body ?? '', 'base64');
            if (bytes.length > 0) yield new Uint8Array(bytes);
            return;
          }

          if (!useFrames) {
            const body = entry.response.body ?? '';
            if (body !== '') yield encoder.encode(body);
            return;
          }

          let previous = 0;
          for (const frame of frames) {
            if (options.realTime && frame.at !== null) {
              const wait = frame.at - previous;
              previous = frame.at;
              if (wait > 0) await sleep(wait);
            }
            // The blank line is part of the framing, not part of the frame: a replay
            // that drops it produces one enormous frame and no deltas at all.
            yield encoder.encode(`${frame.raw}\n\n`);
          }
        })(),
      };
    },

    report: () => ({
      used: [...used],
      unused: remaining.map(({ position }) => position),
    }),
  };
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function sameBody(recorded: string | undefined, sent: string | undefined): boolean {
  if (recorded === sent) return true;
  if (recorded === undefined || sent === undefined) return false;
  // JSON key order is not meaningful and varies between runs of the same flow.
  try {
    return stable(JSON.parse(recorded)) === stable(JSON.parse(sent));
  } catch {
    return false;
  }
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
}

function headersOf(entry: CaptureEntry): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of entry.response.headers) {
    // Last wins, except for set-cookie, which legitimately repeats and is joined.
    const key = name.toLowerCase();
    headers[key] = key === 'set-cookie' && headers[key] ? `${headers[key]}, ${value}` : value;
  }
  if (!headers['content-type'] && entry.response.mimeType) {
    headers['content-type'] = entry.response.mimeType;
  }
  return headers;
}
