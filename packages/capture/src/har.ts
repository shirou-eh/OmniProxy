import {
  captureBundleSchema,
  type CaptureBundle,
  type CaptureEntry,
  type CaptureFrame,
  type CaptureRequest,
  type CaptureResponse,
  type HeaderPair,
  type WebSocketMessage,
} from '@omniproxy/schema';
import { z } from 'zod';
import { isEventStream, parseSseStream } from './sse.js';

/**
 * HAR 1.2 import.
 *
 * Only the fields OmniProxy actually reads are described; everything else in the file
 * is ignored rather than rejected, because every tool writes a slightly different HAR
 * and a strict parser would fail on files that are perfectly usable.
 *
 * What this importer deliberately does NOT do: filter, classify or interpret. Every
 * entry in the file becomes an entry in the bundle, in order. Deciding what is
 * telemetry and what is the real API is the analyzer's job (PR-3) — and it can only
 * make that call honestly if nothing was thrown away first.
 */

const harHeaderSchema = z.object({ name: z.string(), value: z.string() });

const harPostDataSchema = z.object({
  mimeType: z.string().optional(),
  text: z.string().optional(),
});

const harContentSchema = z.object({
  size: z.number().optional(),
  mimeType: z.string().optional(),
  text: z.string().optional(),
  encoding: z.string().optional(),
});

const harWebSocketMessageSchema = z.object({
  type: z.string(),
  time: z.number().optional(),
  data: z.string(),
});

const harEntrySchema = z.object({
  startedDateTime: z.string().optional(),
  time: z.number().optional(),
  request: z.object({
    method: z.string(),
    url: z.string(),
    httpVersion: z.string().optional(),
    headers: z.array(harHeaderSchema).default([]),
    postData: harPostDataSchema.optional(),
  }),
  response: z.object({
    status: z.number(),
    statusText: z.string().optional(),
    httpVersion: z.string().optional(),
    headers: z.array(harHeaderSchema).default([]),
    content: harContentSchema.default({}),
  }),
  _webSocketMessages: z.array(harWebSocketMessageSchema).optional(),
});

export const harSchema = z.object({
  log: z.object({
    version: z.string().optional(),
    entries: z.array(harEntrySchema),
  }),
});

export type Har = z.infer<typeof harSchema>;

export interface ImportHarOptions {
  providerId: string;
  scenario: string;
  /** Where the file came from, kept for the audit trail. */
  source?: string;
  /** Overrides the capture time; by default the first entry's timestamp is used. */
  capturedAt?: string;
  /** Injectable for deterministic tests. */
  bundleId?: string;
}

export class HarImportError extends Error {
  override readonly name = 'HarImportError';
  constructor(
    message: string,
    readonly userAction: string,
  ) {
    super(message);
  }
}

export function importHar(input: unknown, options: ImportHarOptions): CaptureBundle {
  const parsed = harSchema.safeParse(input);
  if (!parsed.success) {
    throw new HarImportError(
      `This does not look like a HAR 1.2 file: ${z.prettifyError(parsed.error)}`,
      'Export it again with "Save all as HAR with content" in the browser DevTools Network panel.',
    );
  }

  const harEntries = parsed.data.log.entries;
  const notes: string[] = [];
  const entries: CaptureEntry[] = harEntries.map((harEntry, index) => {
    const startedAt = parseStartedAt(harEntry.startedDateTime);

    const request: CaptureRequest = {
      method: harEntry.request.method,
      url: harEntry.request.url,
      headers: toHeaderPairs(harEntry.request.headers),
    };
    if (harEntry.request.httpVersion) request.httpVersion = harEntry.request.httpVersion;
    if (harEntry.request.postData?.text !== undefined) {
      request.body = harEntry.request.postData.text;
      request.bodyEncoding = 'utf8';
    }
    if (harEntry.request.postData?.mimeType) {
      request.mimeType = harEntry.request.postData.mimeType;
    }

    const content = harEntry.response.content;
    const response: CaptureResponse = {
      status: harEntry.response.status,
      headers: toHeaderPairs(harEntry.response.headers),
    };
    if (harEntry.response.statusText) response.statusText = harEntry.response.statusText;
    if (harEntry.response.httpVersion) response.httpVersion = harEntry.response.httpVersion;
    if (content.mimeType) response.mimeType = content.mimeType;

    if (content.text !== undefined) {
      response.body = content.text;
      response.bodyEncoding = content.encoding === 'base64' ? 'base64' : 'utf8';

      if (response.bodyEncoding === 'utf8' && isEventStream(content.mimeType)) {
        const frames: CaptureFrame[] = parseSseStream(content.text);
        if (frames.length > 0) response.frames = frames;
      }
    } else if ((content.size ?? 0) > 0) {
      // A HAR exported without bodies is the single most common reason a capture is
      // useless. Say so here rather than letting the analyzer produce nonsense later.
      notes.push(
        `entry ${index} (${harEntry.request.method} ${stripQuery(harEntry.request.url)}): ` +
          'response body missing from the HAR — re-export with "Save all as HAR with content".',
      );
    }

    const wsMessages = toWebSocketMessages(harEntry._webSocketMessages, startedAt);
    if (wsMessages.length > 0) response.webSocketMessages = wsMessages;

    const entry: CaptureEntry = {
      index,
      startedAt,
      request,
      response,
      classification: 'unknown',
    };
    if (harEntry.time !== undefined) entry.durationMs = harEntry.time;
    return entry;
  });

  const capturedAt =
    options.capturedAt ??
    firstIsoTimestamp(harEntries.map((e) => e.startedDateTime)) ??
    new Date().toISOString();

  const bundle: CaptureBundle = {
    id: options.bundleId ?? buildBundleId(options.providerId, options.scenario, capturedAt),
    providerId: options.providerId,
    capturedAt,
    method: 'har-import',
    scenario: options.scenario,
    // Raw until the sanitizer has run. Nothing may persist it to fixtures/ in this state.
    sanitized: false,
    entries,
    redactions: {},
    notes,
  };
  if (options.source !== undefined) bundle.source = options.source;

  // Validate our own output: the bundle is a contract other packages rely on.
  return captureBundleSchema.parse(bundle);
}

/**
 * HTTP/2 pseudo-headers (`:method`, `:authority`) are transport framing, not headers a
 * request can carry. The protocol they imply is already recorded in `httpVersion`.
 */
function toHeaderPairs(headers: readonly { name: string; value: string }[]): HeaderPair[] {
  return headers
    .filter((h) => !h.name.startsWith(':'))
    .map((h): HeaderPair => [h.name, h.value]);
}

function toWebSocketMessages(
  messages: readonly { type: string; time?: number | undefined; data: string }[] | undefined,
  startedAt: number,
): WebSocketMessage[] {
  if (!messages) return [];
  return messages.map((message) => ({
    direction: message.type === 'send' ? ('send' as const) : ('receive' as const),
    // HAR stores websocket message time in seconds since the epoch, unlike everything
    // else in the format. Normalise to ms relative to the entry.
    at: message.time === undefined ? null : Math.round(message.time * 1000 - startedAt),
    data: message.data,
  }));
}

function parseStartedAt(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function firstIsoTimestamp(values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

function buildBundleId(providerId: string, scenario: string, capturedAt: string): string {
  const stamp = capturedAt.replace(/[-:]/g, '').replace(/\.\d+/, '').replace('T', '-');
  return `${providerId}-${scenario}-${stamp}`;
}

function stripQuery(url: string): string {
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}
