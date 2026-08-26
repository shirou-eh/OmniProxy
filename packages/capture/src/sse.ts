import type { CaptureFrame } from '@omniproxy/schema';

/**
 * Server-sent events reassembly.
 *
 * A HAR file stores a whole SSE response as one string, so the frame boundaries have
 * to be recovered. Both halves of the frame are kept: `raw` exactly as it arrived
 * (the analyzer needs it — some providers put JSON-patch fragments in there and the
 * indentation matters) and the interpreted `event` / `data` / `id` fields.
 *
 * Deliberately tolerant, because captured traffic is never clean:
 *  - accepts LF and CRLF line endings;
 *  - accepts `data:value` as well as `data: value` (the spec strips one leading space);
 *  - keeps comment-only frames (`: keep-alive`), since a heartbeat is a real signal
 *    about how the provider behaves;
 *  - keeps a trailing frame that has no terminating blank line, because a capture can
 *    end mid-stream and losing the last frame would hide exactly that.
 */

const FRAME_SEPARATOR = /\r?\n\r?\n/;

export interface ParseSseOptions {
  /** Arrival time of the whole body, when the source knows it. */
  at?: number | null;
}

export function parseSseStream(body: string, options: ParseSseOptions = {}): CaptureFrame[] {
  const at = options.at ?? null;
  const frames: CaptureFrame[] = [];

  for (const block of body.split(FRAME_SEPARATOR)) {
    if (block.trim() === '') continue;
    frames.push(parseSseFrame(block, at));
  }

  return frames;
}

export function parseSseFrame(raw: string, at: number | null = null): CaptureFrame {
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        dataLines.push(value);
        break;
      case 'event':
        event = value;
        break;
      case 'id':
        id = value;
        break;
      default:
        // Unknown field: kept in `raw`, ignored here. Providers invent their own.
        break;
    }
  }

  const frame: CaptureFrame = { at, raw };
  if (event !== undefined) frame.event = event;
  if (id !== undefined) frame.id = id;
  if (dataLines.length > 0) frame.data = dataLines.join('\n');
  return frame;
}

/** Whether a response should be reassembled as SSE, judged by its content type. */
export function isEventStream(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return mimeType.split(';')[0]?.trim().toLowerCase() === 'text/event-stream';
}
