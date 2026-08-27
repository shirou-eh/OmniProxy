import type {
  CaptureBundle,
  CaptureClassification,
  CaptureEntry,
} from '@omniproxy/schema';
import { headerValue, headerValues } from '@omniproxy/schema';

/**
 * Capture analysis: separating the API from the noise, naming what each call does,
 * and finding how values flow from one response into the next request.
 *
 * Everything here is a **hint for a human**, never a verdict. Each classification
 * carries the reasons that produced it, so a wrong guess is visible and arguable
 * rather than silently baked into a generated declaration. The analyzer that hides
 * its reasoning is the analyzer nobody can debug at 2am when a provider breaks.
 *
 * The value-flow graph is the part that matters most: it is what turns a flat list of
 * requests into a sequence — session id created here, used there — and it is what the
 * draft generator (PR-5) turns into `{{state.sessionId}}`.
 *
 * It works on sanitized bundles too. Redaction gives one value one stable placeholder
 * everywhere (PR-2), so a link through a redacted session id survives intact.
 */

const TELEMETRY_HOST_MARKERS = [
  'google-analytics.',
  'googletagmanager.',
  'doubleclick.',
  'sentry.io',
  'ingest.sentry',
  'segment.io',
  'segment.com',
  'amplitude.com',
  'mixpanel.com',
  'datadoghq.',
  'hotjar.',
  'clarity.ms',
  'bugsnag.com',
  'newrelic.com',
  'browser-intake-',
  'posthog.com',
];

const TELEMETRY_PATH_MARKERS = [
  '/beacon',
  '/track',
  '/collect',
  '/telemetry',
  '/analytics',
  '/metrics',
  '/rum',
  '/log',
  '/logs',
  '/event',
  '/events',
  '/stats',
  '/ping',
];

const STATIC_MIME_PREFIXES = ['text/css', 'font/', 'image/svg', 'application/wasm'];
const STATIC_EXTENSIONS = [
  '.css', '.js', '.mjs', '.map', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.ico', '.svg', '.webmanifest', '.txt', '.html',
  // A WASM module is fetched like any other asset. When it is an anti-bot solver the
  // declaration reaches it through a transform, not through a flow step, so leaving it
  // in the flow would only invite a generated declaration to make a step out of it.
  '.wasm',
];

const MEDIA_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'model/'];

const AUTH_PATH_MARKERS = ['/login', '/signin', '/oauth', '/token', '/auth'];

/** Values shorter than this are too common to link on without false positives. */
const MIN_LINKABLE_LENGTH = 6;

/** A value that appears in this share of entries is boilerplate, not a link. */
const MAX_LINK_UBIQUITY = 0.5;

export interface ValueLink {
  /** Entry index whose response produced the value. */
  from: number;
  /** Entry index whose request consumed it. */
  to: number;
  /** Where it came from: a JSON path, a cookie name, a header. */
  sourcePath: string;
  /** Where it was used: url, header name, or a body path. */
  targetPath: string;
  /** Masked, so an analysis report never becomes a place secrets appear. */
  sample: string;
}

export interface AnalyzedStep {
  index: number;
  method: string;
  url: string;
  status: number;
  classification: CaptureClassification;
  /** Why this classification — always populated, so a wrong guess is arguable. */
  reasons: string[];
  /** Links into this entry's request, from earlier responses. */
  consumes: ValueLink[];
  /** Links out of this entry's response, into later requests. */
  produces: ValueLink[];
}

export interface AnalysisResult {
  /** The bundle with `classification` filled in on every entry. */
  bundle: CaptureBundle;
  /** Meaningful calls, in order: the candidate flow. */
  flow: AnalyzedStep[];
  /** What was set aside, and why. Nothing is deleted — only labelled. */
  noise: AnalyzedStep[];
  links: ValueLink[];
  warnings: string[];
}

export function analyzeBundle(bundle: CaptureBundle): AnalysisResult {
  const links = findValueLinks(bundle.entries);
  const pollGroups = findPollGroups(bundle.entries);

  const steps: AnalyzedStep[] = bundle.entries.map((entry) => {
    const consumes = links.filter((link) => link.to === entry.index);
    const produces = links.filter((link) => link.from === entry.index);
    const { classification, reasons } = classifyEntry(entry, {
      produces,
      isPolled: pollGroups.has(entry.index),
      artifactLinked: consumes.length > 0 || linkedFromApi(entry, links),
    });

    return {
      index: entry.index,
      method: entry.request.method,
      url: entry.request.url,
      status: entry.response.status,
      classification,
      reasons,
      consumes,
      produces,
    };
  });

  const byIndex = new Map(steps.map((step) => [step.index, step]));
  const entries: CaptureEntry[] = bundle.entries.map((entry) => ({
    ...entry,
    classification: byIndex.get(entry.index)?.classification ?? 'unknown',
  }));

  const isNoise = (step: AnalyzedStep): boolean =>
    step.classification === 'telemetry' || step.classification === 'static';

  const warnings: string[] = [];
  const flow = steps.filter((step) => !isNoise(step));
  if (flow.length === 0 && steps.length > 0) {
    warnings.push(
      'Every call in this capture looks like telemetry or a static asset. ' +
        'The scenario was probably recorded before the interesting request happened.',
    );
  }
  const unknowns = flow.filter((step) => step.classification === 'unknown').length;
  if (unknowns > 0) {
    warnings.push(
      `${unknowns} call(s) could not be classified. They are kept in the flow — ` +
        'look at them yourself before trusting the generated draft.',
    );
  }
  if (links.length === 0 && flow.length > 1) {
    warnings.push(
      'No value flows between these calls. Either they are independent, or the capture ' +
        'is missing response bodies (re-export the HAR with content).',
    );
  }

  return { bundle: { ...bundle, entries }, flow, noise: steps.filter(isNoise), links, warnings };
}

/* ─────────────────────────────── classification ─────────────────────────────── */

interface ClassifyContext {
  produces: ValueLink[];
  isPolled: boolean;
  artifactLinked: boolean;
}

/**
 * Rules are ordered from cheap and certain to expensive and inferential. A streaming
 * POST is classified `send`, not `stream`: it is the call that carries the user's
 * input, and the fact that it streams is already recorded in `response.frames`.
 * `stream` is reserved for a separate stream endpoint, which some providers open on
 * its own after the send.
 */
export function classifyEntry(
  entry: CaptureEntry,
  context: ClassifyContext,
): { classification: CaptureClassification; reasons: string[] } {
  const reasons: string[] = [];
  const url = safeUrl(entry.request.url);
  const path = url?.pathname ?? entry.request.url;
  const host = url?.host ?? '';
  const method = entry.request.method.toUpperCase();
  const mime = (entry.response.mimeType ?? '').toLowerCase();
  const hasFrames = (entry.response.frames?.length ?? 0) > 0;

  if (method === 'OPTIONS') {
    return { classification: 'static', reasons: ['CORS preflight'] };
  }

  const telemetryHost = TELEMETRY_HOST_MARKERS.find((marker) => host.includes(marker));
  if (telemetryHost) {
    return { classification: 'telemetry', reasons: [`known telemetry host (${telemetryHost})`] };
  }

  const telemetryPath = TELEMETRY_PATH_MARKERS.find((marker) => pathHasSegment(path, marker));
  if (telemetryPath && !hasFrames) {
    return { classification: 'telemetry', reasons: [`telemetry-shaped path (${telemetryPath})`] };
  }

  if (isStaticAsset(path, mime)) {
    return { classification: 'static', reasons: [`static asset (${mime || 'by extension'})`] };
  }

  if (MEDIA_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
    // A media response that an earlier API call pointed at is a generated result.
    // The same response with no link is site furniture — a logo, an avatar.
    if (context.artifactLinked) {
      return { classification: 'artifact', reasons: [`media (${mime}) linked from an earlier response`] };
    }
    return { classification: 'static', reasons: [`media (${mime}) not linked from any API call`] };
  }

  if ((entry.response.webSocketMessages?.length ?? 0) > 0 || entry.response.status === 101) {
    return {
      classification: 'stream',
      reasons: ['websocket connection — the traffic is in response.webSocketMessages'],
    };
  }

  if (hasFrames || mime.startsWith('text/event-stream')) {
    if (method === 'POST') {
      reasons.push('POST with a streamed response — the call that carries user input');
      return { classification: 'send', reasons };
    }
    return { classification: 'stream', reasons: ['streamed response on a separate endpoint'] };
  }

  if (isUpload(entry)) {
    return { classification: 'upload', reasons: ['binary or multipart request body'] };
  }

  if (context.isPolled) {
    return { classification: 'poll', reasons: ['same endpoint requested repeatedly with a changing response'] };
  }

  const setsCookie = headerValues(entry.response.headers, 'set-cookie').length > 0;
  const authPath = AUTH_PATH_MARKERS.find((marker) => pathHasSegment(path, marker));
  if (authPath && setsCookie) {
    return { classification: 'auth', reasons: [`auth-shaped path (${authPath})`, 'sets cookies'] };
  }

  if (context.produces.length > 0 && method === 'POST') {
    reasons.push(
      `response value reused by ${context.produces.length} later request(s): ` +
        context.produces.map((link) => link.sourcePath).join(', '),
    );
    return { classification: 'session', reasons };
  }

  if (setsCookie) {
    return { classification: 'auth', reasons: ['sets cookies'] };
  }

  if (authPath) {
    return { classification: 'auth', reasons: [`auth-shaped path (${authPath})`] };
  }

  return {
    classification: 'unknown',
    reasons: ['nothing distinctive: no stream, no links, no cookies, not media'],
  };
}

/* ──────────────────────────────── value linking ──────────────────────────────── */

interface ProducedValue {
  entryIndex: number;
  path: string;
  value: string;
}

export function findValueLinks(entries: readonly CaptureEntry[]): ValueLink[] {
  const produced: ProducedValue[] = [];
  for (const entry of entries) {
    collectProducedValues(entry, produced);
  }

  // A value present nearly everywhere is boilerplate ("application/json", a version
  // string), not a dependency. Drop it before it fills the graph with noise.
  const ubiquity = new Map<string, number>();
  for (const entry of entries) {
    const text = requestText(entry);
    for (const candidate of new Set(produced.map((p) => p.value))) {
      if (text.includes(candidate)) ubiquity.set(candidate, (ubiquity.get(candidate) ?? 0) + 1);
    }
  }
  const ubiquityLimit = Math.max(2, Math.ceil(entries.length * MAX_LINK_UBIQUITY));

  const links: ValueLink[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    for (const source of produced) {
      if (source.entryIndex >= entry.index) continue; // only forward in time
      if ((ubiquity.get(source.value) ?? 0) > ubiquityLimit) continue;

      const targetPath = findInRequest(entry, source.value);
      if (!targetPath) continue;

      const key = `${source.entryIndex}->${entry.index}:${source.path}:${targetPath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      links.push({
        from: source.entryIndex,
        to: entry.index,
        sourcePath: source.path,
        targetPath,
        sample: mask(source.value),
      });
    }
  }

  return links;
}

function collectProducedValues(entry: CaptureEntry, into: ProducedValue[]): void {
  for (const cookie of headerValues(entry.response.headers, 'set-cookie')) {
    const eq = cookie.indexOf('=');
    if (eq === -1) continue;
    const name = cookie.slice(0, eq);
    const value = cookie.slice(eq + 1).split(';')[0]?.trim() ?? '';
    if (isLinkable(value)) into.push({ entryIndex: entry.index, path: `set-cookie.${name}`, value });
  }

  const location = headerValue(entry.response.headers, 'location');
  if (location && isLinkable(location)) {
    into.push({ entryIndex: entry.index, path: 'header.location', value: location });
  }

  if (entry.response.bodyEncoding !== 'base64' && entry.response.body !== undefined) {
    collectJsonValues(entry.response.body, entry.index, into);
  }

  for (const frame of entry.response.frames ?? []) {
    if (frame.data !== undefined) collectJsonValues(frame.data, entry.index, into, 'frame');
  }
}

function collectJsonValues(
  text: string,
  entryIndex: number,
  into: ProducedValue[],
  prefix = '$',
): void {
  const parsed = tryParseJson(text);
  if (parsed === undefined) return;

  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (isLinkable(node)) into.push({ entryIndex, path, value: node });
      return;
    }
    if (typeof node === 'number' && String(node).length >= 10) {
      into.push({ entryIndex, path, value: String(node) });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
    }
  };

  walk(parsed, prefix);
}

/** Where in this request the value appears, or undefined if it does not. */
function findInRequest(entry: CaptureEntry, value: string): string | undefined {
  if (entry.request.url.includes(value)) return 'url';

  for (const [name, headerText] of entry.request.headers) {
    if (headerText.includes(value)) return `header.${name.toLowerCase()}`;
  }

  if (entry.request.bodyEncoding !== 'base64' && entry.request.body?.includes(value)) {
    return bodyPathOf(entry.request.body, value) ?? 'body';
  }

  return undefined;
}

function bodyPathOf(body: string, value: string): string | undefined {
  const parsed = tryParseJson(body);
  if (parsed === undefined) return undefined;

  let found: string | undefined;
  const walk = (node: unknown, path: string): void => {
    if (found !== undefined) return;
    if (typeof node === 'string' || typeof node === 'number') {
      if (String(node) === value) found = path;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
    }
  };

  walk(parsed, 'body');
  return found;
}

/* ────────────────────────────────── polling ────────────────────────────────── */

/** Entry indexes that belong to a repeated GET against the same endpoint. */
export function findPollGroups(entries: readonly CaptureEntry[]): Set<number> {
  const byEndpoint = new Map<string, CaptureEntry[]>();

  for (const entry of entries) {
    if (entry.request.method.toUpperCase() !== 'GET') continue;
    const url = safeUrl(entry.request.url);
    const key = `${url?.host ?? ''}${url?.pathname ?? entry.request.url}`;
    const group = byEndpoint.get(key);
    if (group) group.push(entry);
    else byEndpoint.set(key, [entry]);
  }

  const polled = new Set<number>();
  for (const group of byEndpoint.values()) {
    if (group.length < 2) continue;
    const bodies = new Set(group.map((entry) => entry.response.body ?? ''));
    // Identical responses mean a cached asset, not a poll.
    if (bodies.size < 2) continue;
    for (const entry of group) polled.add(entry.index);
  }

  return polled;
}

/* ────────────────────────────────── helpers ────────────────────────────────── */

function linkedFromApi(entry: CaptureEntry, links: readonly ValueLink[]): boolean {
  return links.some((link) => link.to === entry.index && link.targetPath === 'url');
}

function isStaticAsset(path: string, mime: string): boolean {
  if (STATIC_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return true;
  if (mime.startsWith('application/javascript') || mime.startsWith('text/javascript')) return true;
  const lower = path.toLowerCase();
  return STATIC_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function isUpload(entry: CaptureEntry): boolean {
  const method = entry.request.method.toUpperCase();
  if (method !== 'PUT' && method !== 'POST') return false;
  if (entry.request.bodyEncoding === 'base64') return true;
  const mime = (entry.request.mimeType ?? '').toLowerCase();
  return mime.startsWith('multipart/form-data') || mime.startsWith('application/octet-stream');
}

function pathHasSegment(path: string, marker: string): boolean {
  const lower = path.toLowerCase();
  return lower === marker || lower.startsWith(`${marker}/`) || lower.includes(`${marker}/`) ||
    lower.endsWith(marker);
}

function isLinkable(value: string): boolean {
  if (value.length < MIN_LINKABLE_LENGTH) return false;
  if (/^\s*$/.test(value)) return false;
  // Content types, booleans and prose are not identifiers.
  if (value.includes(' ')) return false;
  if (value.includes('/') && value.includes('.') && !value.includes('-')) return false;
  return true;
}

function requestText(entry: CaptureEntry): string {
  const headers = entry.request.headers.map(([name, value]) => `${name}:${value}`).join('\n');
  return `${entry.request.url}\n${headers}\n${entry.request.body ?? ''}`;
}

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '' || !'{['.includes(trimmed[0] ?? '')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Analysis output is read by humans and pasted into issues. Never print a value whole. */
function mask(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 3)}…`;
  return `${value.slice(0, 6)}…${value.slice(-2)}`;
}
