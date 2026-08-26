import { z } from 'zod';

/**
 * Captured traffic — the only legitimate input for writing a provider adapter.
 *
 * The rule this type exists to enforce (promt section 8.1): no adapter is written
 * without a real capture. A guessed URL looks like working code right up until the
 * first run, so a provider with no bundle gets the status `needs-capture` and nothing
 * more is written for it.
 */

export const captureMethodSchema = z.enum(['cdp', 'extension', 'har-import']);
export type CaptureMethod = z.infer<typeof captureMethodSchema>;

/** Filled in by the analyzer (PR-3); an importer leaves every entry `unknown`. */
export const captureClassificationSchema = z.enum([
  'auth',
  'session',
  'send',
  'stream',
  'poll',
  'upload',
  'artifact',
  'telemetry',
  'static',
  'unknown',
]);
export type CaptureClassification = z.infer<typeof captureClassificationSchema>;

/** What kind of secret a placeholder replaced. The value itself is never stored. */
export const redactionKindSchema = z.enum(['cookie', 'token', 'email', 'id', 'pii']);
export type RedactionKind = z.infer<typeof redactionKindSchema>;

export const bodyEncodingSchema = z.enum(['utf8', 'base64']);
export type BodyEncoding = z.infer<typeof bodyEncodingSchema>;

/**
 * Headers are ordered pairs rather than a dictionary, on purpose: order is part of a
 * browser's fingerprint, and duplicates are real (several `set-cookie` in one
 * response). A dictionary would quietly lose both.
 */
export const headerPairSchema = z.tuple([z.string(), z.string()]);
export type HeaderPair = z.infer<typeof headerPairSchema>;

/**
 * One frame of a streamed response. `at` is the arrival time in ms since the entry
 * started, or null when the source could not provide it — a HAR file stores the whole
 * stream as a single string, so only a live recorder (CDP) has real timings.
 */
export const captureFrameSchema = z.object({
  at: z.number().nullable(),
  /** The frame exactly as it arrived, before any interpretation. */
  raw: z.string(),
  /** SSE `event:` name, when present. */
  event: z.string().optional(),
  /** SSE `data:` lines joined with newlines, when present. */
  data: z.string().optional(),
  id: z.string().optional(),
});
export type CaptureFrame = z.infer<typeof captureFrameSchema>;

export const captureRequestSchema = z.object({
  method: z.string(),
  url: z.string(),
  httpVersion: z.string().optional(),
  headers: z.array(headerPairSchema),
  body: z.string().optional(),
  bodyEncoding: bodyEncodingSchema.optional(),
  mimeType: z.string().optional(),
});
export type CaptureRequest = z.infer<typeof captureRequestSchema>;

export const webSocketMessageSchema = z.object({
  direction: z.enum(['send', 'receive']),
  at: z.number().nullable(),
  data: z.string(),
});
export type WebSocketMessage = z.infer<typeof webSocketMessageSchema>;

export const captureResponseSchema = z.object({
  status: z.number().int(),
  statusText: z.string().optional(),
  httpVersion: z.string().optional(),
  headers: z.array(headerPairSchema),
  body: z.string().optional(),
  bodyEncoding: bodyEncodingSchema.optional(),
  mimeType: z.string().optional(),
  /** Reassembled stream frames, in arrival order. */
  frames: z.array(captureFrameSchema).optional(),
  webSocketMessages: z.array(webSocketMessageSchema).optional(),
});
export type CaptureResponse = z.infer<typeof captureResponseSchema>;

export const captureEntrySchema = z.object({
  index: z.number().int().nonnegative(),
  /** Epoch milliseconds. */
  startedAt: z.number(),
  durationMs: z.number().nonnegative().optional(),
  request: captureRequestSchema,
  response: captureResponseSchema,
  classification: captureClassificationSchema.default('unknown'),
  /** Fields that differed between two runs of the same scenario — future `{{...}}`. */
  volatileFields: z.array(z.string()).optional(),
});
export type CaptureEntry = z.infer<typeof captureEntrySchema>;

export const captureBundleSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  /** ISO-8601 timestamp of the capture itself, not of the import. */
  capturedAt: z.iso.datetime({ offset: true }),
  method: captureMethodSchema,
  /** Which user scenario was recorded: chat-stream, image-generate, poll-job... */
  scenario: z.string().min(1),
  /**
   * True only after the sanitizer has run. A bundle with `sanitized: false` holds live
   * cookies and tokens: it may live in the local temp cache, never in fixtures/ and
   * never in git.
   */
  sanitized: z.boolean(),
  entries: z.array(captureEntrySchema),
  /** placeholder -> what kind of secret it replaced. Values are never stored. */
  redactions: z.record(z.string(), redactionKindSchema).default({}),
  notes: z.array(z.string()).default([]),
  /** Where the bundle came from, for the audit trail: a HAR filename, a CDP session. */
  source: z.string().optional(),
});
export type CaptureBundle = z.infer<typeof captureBundleSchema>;

/** First matching header value, case-insensitive. */
export function headerValue(headers: readonly HeaderPair[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of headers) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Every value for a header that may legitimately repeat, such as `set-cookie`. */
export function headerValues(headers: readonly HeaderPair[], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter(([key]) => key.toLowerCase() === wanted).map(([, value]) => value);
}
