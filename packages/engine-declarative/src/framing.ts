import type { StreamSpec } from '@omniproxy/schema';
import { selectJsonPath } from './jsonpath.js';

/**
 * Stream framing: bytes from an upstream turned into channel deltas.
 *
 * Three formats are implemented, because three formats are what actually occur:
 *
 *  - `sse`      — `data:` lines carrying JSON, mapped by JSONPath. The common case.
 *  - `ndjson`   — one JSON object per line.
 *  - `json-patch` — a stream of patch operations against a document the client is
 *    expected to be assembling. DeepSeek Web uses it, and it is the reason this
 *    engine exists in a declarative form at all: the format is intricate enough that
 *    every provider using it would otherwise need bespoke code.
 *
 * The json-patch parser reproduces the behaviour of `legacy/server.js`, including the
 * detail that is easy to miss and impossible to guess: **the path is sticky**. An
 * event with no `p` field applies to the path of the previous event. Miss that and
 * the stream decodes into silence.
 */

export type FrameEvent =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'search'; text: string }
  | { kind: 'messageId'; id: string }
  | { kind: 'finish'; reason: string }
  | { kind: 'usage'; usage: unknown }
  | { kind: 'toolCalls'; value: unknown }
  | { kind: 'warning'; code: string; message: string }
  | { kind: 'upstreamError'; message: string };

export interface Framer {
  /** Feed decoded text. Returns whatever became complete. */
  push(chunk: string): FrameEvent[];
  /** Flush anything held back at end of stream. */
  end(): FrameEvent[];
}

export function createFramer(spec: StreamSpec): Framer {
  switch (spec.format) {
    case 'sse':
      return new MappedFramer(spec, splitSseData);
    case 'ndjson':
      return new MappedFramer(spec, splitLines);
    case 'json-patch':
      return new JsonPatchFramer(spec);
    case 'plain':
      return new PlainFramer();
    case 'websocket':
    case 'poll':
      throw new Error(
        `stream format "${spec.format}" is not executed by the declarative engine yet; ` +
          'use flow.poll for job providers, or a code adapter for websocket protocols',
      );
  }
}

/* ────────────────────────────── line/frame splitting ────────────────────────────── */

/** Yields the payload of each `data:` line of an SSE stream. */
function splitSseData(buffered: string): { payloads: string[]; rest: string } {
  const lines = buffered.split('\n');
  const rest = lines.pop() ?? '';
  const payloads: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) continue;
    let payload = line.slice(5);
    if (payload.startsWith(' ')) payload = payload.slice(1);
    payloads.push(payload);
  }

  return { payloads, rest };
}

function splitLines(buffered: string): { payloads: string[]; rest: string } {
  const lines = buffered.split('\n');
  const rest = lines.pop() ?? '';
  return { payloads: lines.map((line) => line.replace(/\r$/, '')).filter((l) => l !== ''), rest };
}

/* ─────────────────────────────── mapped formats ─────────────────────────────── */

class MappedFramer implements Framer {
  #buffer = '';
  #done = false;

  constructor(
    private readonly spec: StreamSpec,
    private readonly split: (buffered: string) => { payloads: string[]; rest: string },
  ) {}

  push(chunk: string): FrameEvent[] {
    this.#buffer += chunk;
    const { payloads, rest } = this.split(this.#buffer);
    this.#buffer = rest;
    return this.#consume(payloads);
  }

  end(): FrameEvent[] {
    const remainder = this.#buffer.trim();
    this.#buffer = '';
    if (remainder === '') return [];
    const { payloads } = this.split(`${remainder}\n`);
    return this.#consume(payloads);
  }

  #consume(payloads: string[]): FrameEvent[] {
    const events: FrameEvent[] = [];

    for (const payload of payloads) {
      const trimmed = payload.trim();
      if (trimmed === '') continue;

      if (this.spec.doneWhen && trimmed === this.spec.doneWhen.data) {
        this.#done = true;
        continue;
      }
      if (this.#done) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Not JSON. Providers do send the occasional bare keep-alive; saying so once
        // is more useful than either crashing or pretending it did not happen.
        events.push({
          kind: 'warning',
          code: 'unparsable_frame',
          message: `a stream frame was not JSON: ${trimmed.slice(0, 60)}`,
        });
        continue;
      }

      events.push(...this.#map(parsed));
    }

    return events;
  }

  #map(parsed: unknown): FrameEvent[] {
    const map = this.spec.map;
    if (!map) return [];
    const events: FrameEvent[] = [];

    const text = map.text ? selectJsonPath(parsed, map.text) : undefined;
    if (typeof text === 'string' && text !== '') events.push({ kind: 'text', text });

    const reasoning = map.reasoning ? selectJsonPath(parsed, map.reasoning) : undefined;
    if (typeof reasoning === 'string' && reasoning !== '') {
      events.push({ kind: 'reasoning', text: reasoning });
    }

    const search = map.search ? selectJsonPath(parsed, map.search) : undefined;
    if (typeof search === 'string' && search !== '') events.push({ kind: 'search', text: search });

    const messageId = map.messageId ? selectJsonPath(parsed, map.messageId) : undefined;
    if (messageId !== undefined && messageId !== null) {
      events.push({ kind: 'messageId', id: String(messageId) });
    }

    const toolCalls = map.toolCalls ? selectJsonPath(parsed, map.toolCalls) : undefined;
    if (toolCalls !== undefined && toolCalls !== null) events.push({ kind: 'toolCalls', value: toolCalls });

    const usage = map.usage ? selectJsonPath(parsed, map.usage) : undefined;
    if (usage !== undefined && usage !== null) events.push({ kind: 'usage', usage });

    const finish = map.finish ? selectJsonPath(parsed, map.finish) : undefined;
    if (typeof finish === 'string' && finish !== '') events.push({ kind: 'finish', reason: finish });

    return events;
  }
}

class PlainFramer implements Framer {
  push(chunk: string): FrameEvent[] {
    return chunk === '' ? [] : [{ kind: 'text', text: chunk }];
  }
  end(): FrameEvent[] {
    return [];
  }
}

/* ─────────────────────────────── json-patch format ─────────────────────────────── */

interface Fragment {
  type?: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Rebuilds a document from patch operations and reports what changed.
 *
 * State is the assembled text, and every push recomputes it and emits the *tail* that
 * has not been sent yet. That is deliberate: the upstream sometimes replaces the whole
 * fragment list rather than appending to it, and a parser that assumed append-only
 * would either duplicate text or drop it.
 */
class JsonPatchFramer implements Framer {
  #buffer = '';
  #lastPath: string | null = null;
  #fragments: Fragment[] = [];
  #content = '';
  #emitted = { text: '', reasoning: '', search: '' };
  #messageId: string | null = null;

  constructor(private readonly spec: StreamSpec) {}

  push(chunk: string): FrameEvent[] {
    this.#buffer += chunk;
    const { payloads, rest } = splitSseData(this.#buffer);
    this.#buffer = rest;

    const events: FrameEvent[] = [];
    for (const payload of payloads) {
      const trimmed = payload.trim();
      if (trimmed === '') continue;
      if (this.spec.doneWhen && trimmed === this.spec.doneWhen.data) continue;

      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        events.push({
          kind: 'warning',
          code: 'unparsable_frame',
          message: `a patch frame was not JSON: ${trimmed.slice(0, 60)}`,
        });
        continue;
      }

      events.push(...this.#apply(event));
    }

    events.push(...this.#drain());
    return events;
  }

  end(): FrameEvent[] {
    const remainder = this.#buffer.trim();
    this.#buffer = '';
    if (remainder === '') return this.#drain();
    const { payloads } = splitSseData(`${remainder}\n`);
    const events: FrameEvent[] = [];
    for (const payload of payloads) {
      try {
        events.push(...this.#apply(JSON.parse(payload)));
      } catch {
        // A truncated final frame is normal when a stream is cut off.
      }
    }
    events.push(...this.#drain());
    return events;
  }

  #apply(event: unknown): FrameEvent[] {
    if (event === null || typeof event !== 'object') return [];
    const patch = event as Record<string, unknown>;
    const events: FrameEvent[] = [];

    const pathField = this.spec.patch?.pathField ?? 'p';
    const valueField = this.spec.patch?.valueField ?? 'v';
    const opField = this.spec.patch?.opField ?? 'o';

    if (patch['type'] === 'error') {
      events.push({
        kind: 'upstreamError',
        message: String(patch['content'] ?? 'the provider reported an error'),
      });
    }

    const responseMessageId = patch['response_message_id'];
    if (responseMessageId !== undefined && this.#messageId === null) {
      this.#messageId = String(responseMessageId);
      events.push({ kind: 'messageId', id: this.#messageId });
    }

    const topFinish = patch['finish_reason'];
    if (typeof topFinish === 'string' && topFinish !== '') {
      events.push({ kind: 'finish', reason: topFinish });
    }

    // The sticky path. An event with no `p` continues the previous one.
    const path = patch[pathField];
    if (path !== undefined) this.#lastPath = path === null ? null : String(path);

    const value = patch[valueField];
    if (value === undefined) return events;

    // The whole-response form: `v.response` carries the assembled object.
    if (value !== null && typeof value === 'object' && 'response' in value) {
      const response = (value as Record<string, unknown>)['response'] as Record<string, unknown>;
      if (response['message_id'] !== undefined && this.#messageId === null) {
        this.#messageId = String(response['message_id']);
        events.push({ kind: 'messageId', id: this.#messageId });
      }
      if (typeof response['content'] === 'string') this.#content = response['content'];
      if (Array.isArray(response['fragments'])) {
        this.#fragments = (response['fragments'] as Fragment[]).map((f) => ({ ...f }));
      }
      if (typeof response['finish_reason'] === 'string' && response['finish_reason'] !== '') {
        events.push({ kind: 'finish', reason: response['finish_reason'] });
      }
      return events;
    }

    switch (this.#lastPath) {
      case 'response/fragments':
        this.#appendFragments(value);
        break;

      case 'response':
        // A batch of operations, each targeting a sub-path.
        if (Array.isArray(value)) {
          for (const operation of value) {
            if (operation === null || typeof operation !== 'object') continue;
            const op = operation as Record<string, unknown>;
            if (op[pathField] === 'fragments' && op[opField] === 'APPEND' && op[valueField] !== undefined) {
              this.#appendFragments(op[valueField]);
            }
          }
        }
        break;

      case 'response/fragments/-1/content':
        if (typeof value !== 'object' && this.#fragments.length > 0) {
          const last = this.#fragments[this.#fragments.length - 1] as Fragment;
          last.content = `${last.content ?? ''}${String(value)}`;
        }
        break;

      case 'response/content':
        if (typeof value !== 'object') this.#content += String(value);
        break;

      case 'response/finish_reason':
        if (value !== null) events.push({ kind: 'finish', reason: String(value) });
        break;

      case 'response/status':
        // A status that is not FINISHED is the upstream telling us why it stopped —
        // it is the only signal for a filtered or aborted response on this provider.
        if (value !== 'FINISHED' && value !== null) {
          events.push({ kind: 'finish', reason: String(value) });
        }
        break;

      default:
        break;
    }

    return events;
  }

  #appendFragments(value: unknown): void {
    const incoming = Array.isArray(value) ? value : [value];
    for (const fragment of incoming) {
      if (fragment !== null && typeof fragment === 'object') {
        this.#fragments.push({ ...(fragment as Fragment) });
      }
    }
  }

  /** Emits the not-yet-sent tail of each channel. */
  #drain(): FrameEvent[] {
    const routes = this.spec.patch?.routes ?? {
      RESPONSE: 'text' as const,
      SEARCH: 'text' as const,
      THINK: 'reasoning' as const,
      REASONING: 'reasoning' as const,
    };

    const assembled = { text: '', reasoning: '', search: '' };
    for (const fragment of this.#fragments) {
      if (typeof fragment.content !== 'string') continue;
      const channel = routes[String(fragment.type)];
      if (channel) assembled[channel] += fragment.content;
    }

    // `response/content` is the fallback channel used when no fragments arrive.
    if (assembled.text === '' && this.#content !== '') assembled.text = this.#content;

    const events: FrameEvent[] = [];
    for (const channel of ['text', 'reasoning', 'search'] as const) {
      const next = assembled[channel];
      const already = this.#emitted[channel];
      if (next === already) continue;

      if (next.startsWith(already)) {
        events.push({ kind: channel, text: next.slice(already.length) });
      } else {
        // The upstream rewrote what it had already sent. Rare, but silently emitting
        // the difference would corrupt the output, so say it out loud.
        events.push({
          kind: 'warning',
          code: 'stream_rewritten',
          message: `the provider replaced text it had already sent on the ${channel} channel`,
        });
        events.push({ kind: channel, text: next });
      }
      this.#emitted[channel] = next;
    }

    return events;
  }
}
