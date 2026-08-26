import type { CaptureBundle, CaptureEntry, HeaderPair } from '@omniproxy/schema';

/**
 * Comparing two captures of the same scenario.
 *
 * What changes between two runs of the same actions is what a declaration must
 * template: a session id, a message id, a nonce, a timestamp, a signature. What stays
 * identical is a constant and can be written literally. Nothing else distinguishes the
 * two reliably — a single capture cannot tell a fixed API version header from an id
 * that happens to look stable.
 *
 * So this is not a nice-to-have: without a second run, the draft generator has to
 * guess which fields are variables, and guessing is exactly what this project refuses
 * to do. One capture produces a draft full of hardcoded ids; two produce a template.
 */

export interface EntryDiff {
  /** Index in the first bundle. */
  index: number;
  /** Index of the matched entry in the second bundle, or undefined if unmatched. */
  matchedWith?: number;
  method: string;
  url: string;
  /** Request fields that differed between the runs — the future `{{...}}`. */
  volatileFields: string[];
  notes: string[];
}

export interface CaptureDiff {
  entries: EntryDiff[];
  /** Entries present in one run only, by index. */
  unmatchedInA: number[];
  unmatchedInB: number[];
  warnings: string[];
}

export function diffCaptures(a: CaptureBundle, b: CaptureBundle): CaptureDiff {
  const warnings: string[] = [];
  if (a.providerId !== b.providerId) {
    warnings.push(
      `These captures are from different providers (${a.providerId} and ${b.providerId}). ` +
        'Comparing them says nothing useful.',
    );
  }
  if (a.scenario !== b.scenario) {
    warnings.push(
      `Different scenarios (${a.scenario} and ${b.scenario}). Volatility found this way ` +
        'reflects the difference in what you did, not what the provider varies.',
    );
  }

  // Two-pass matching. Exact endpoints pair first; only what is left over is paired
  // by path *shape*, with id-looking segments wildcarded. Without the second pass an
  // id in the path — `/task/111` against `/task/222`, the commonest shape there is for
  // a job provider — would never match, and the very variable we are hunting for
  // would be the reason we cannot see it.
  const pairs = matchEntries(a.entries, b.entries);

  const entries: EntryDiff[] = a.entries.map((entry) => {
    const match = pairs.get(entry.index);

    if (!match) {
      return {
        index: entry.index,
        method: entry.request.method,
        url: entry.request.url,
        volatileFields: [],
        notes: ['no matching call in the second capture'],
      };
    }

    return {
      index: entry.index,
      matchedWith: match.entry.index,
      method: entry.request.method,
      url: entry.request.url,
      volatileFields: compareRequests(entry, match.entry),
      notes: match.byShape ? ['matched by path shape: an identifier in the path differs'] : [],
    };
  });

  const matchedInB = new Set([...pairs.values()].map((match) => match.entry.index));

  const unmatchedInA = entries.filter((e) => e.matchedWith === undefined).map((e) => e.index);
  const unmatchedInB = b.entries
    .filter((entry) => !matchedInB.has(entry.index))
    .map((entry) => entry.index);

  if (entries.length > 0 && entries.every((e) => e.volatileFields.length === 0)) {
    warnings.push(
      'Nothing differs between these two captures. Either they are the same recording, ' +
        'or the requests really are constant — check before templating anything.',
    );
  }

  return { entries, unmatchedInA, unmatchedInB, warnings };
}

/** Writes the discovered volatility back onto a bundle, for the draft generator. */
export function applyVolatileFields(bundle: CaptureBundle, diff: CaptureDiff): CaptureBundle {
  const byIndex = new Map(diff.entries.map((entry) => [entry.index, entry.volatileFields]));
  return {
    ...bundle,
    entries: bundle.entries.map((entry) => {
      const fields = byIndex.get(entry.index);
      if (!fields || fields.length === 0) return entry;
      return { ...entry, volatileFields: fields };
    }),
  };
}

/* ────────────────────────────────── comparison ────────────────────────────────── */

function compareRequests(a: CaptureEntry, b: CaptureEntry): string[] {
  const fields = new Set<string>();

  comparePaths(a.request.url, b.request.url, fields);
  compareQuery(a.request.url, b.request.url, fields);
  compareHeaders(a.request.headers, b.request.headers, fields);
  compareBodies(a.request.body, b.request.body, a.request.bodyEncoding, b.request.bodyEncoding, fields);

  return [...fields].sort();
}

function comparePaths(urlA: string, urlB: string, into: Set<string>): void {
  const a = safeUrl(urlA);
  const b = safeUrl(urlB);
  if (!a || !b) return;
  if (a.pathname === b.pathname) return;

  const segmentsA = a.pathname.split('/');
  const segmentsB = b.pathname.split('/');
  if (segmentsA.length !== segmentsB.length) {
    into.add('request.path');
    return;
  }
  segmentsA.forEach((segment, i) => {
    if (segment !== segmentsB[i]) into.add(`request.path[${i}]`);
  });
}

function compareQuery(urlA: string, urlB: string, into: Set<string>): void {
  const a = safeUrl(urlA);
  const b = safeUrl(urlB);
  if (!a || !b) return;

  const names = new Set([...a.searchParams.keys(), ...b.searchParams.keys()]);
  for (const name of names) {
    if (a.searchParams.get(name) !== b.searchParams.get(name)) into.add(`request.query.${name}`);
  }
}

function compareHeaders(a: readonly HeaderPair[], b: readonly HeaderPair[], into: Set<string>): void {
  const mapA = headerMap(a);
  const mapB = headerMap(b);
  for (const name of new Set([...mapA.keys(), ...mapB.keys()])) {
    if (mapA.get(name) !== mapB.get(name)) into.add(`request.headers.${name}`);
  }
}

function headerMap(headers: readonly HeaderPair[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    // Repeated headers are joined, so a change in any of them shows up.
    map.set(key, map.has(key) ? `${map.get(key)}, ${value}` : value);
  }
  return map;
}

function compareBodies(
  bodyA: string | undefined,
  bodyB: string | undefined,
  encodingA: string | undefined,
  encodingB: string | undefined,
  into: Set<string>,
): void {
  if (encodingA === 'base64' || encodingB === 'base64') {
    if (bodyA !== bodyB) into.add('request.body(binary)');
    return;
  }
  if (bodyA === undefined && bodyB === undefined) return;
  if (bodyA === undefined || bodyB === undefined) {
    into.add('request.body');
    return;
  }
  if (bodyA === bodyB) return;

  const parsedA = tryParseJson(bodyA);
  const parsedB = tryParseJson(bodyB);
  if (parsedA === undefined || parsedB === undefined) {
    into.add('request.body');
    return;
  }

  compareJson(parsedA, parsedB, 'request.body', into);
}

function compareJson(a: unknown, b: unknown, path: string, into: Set<string>): void {
  if (a === b) return;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      into.add(`${path}[]`);
      return;
    }
    a.forEach((item, i) => compareJson(item, b[i], `${path}[${i}]`, into));
    return;
  }

  const bothObjects =
    a !== null && b !== null && typeof a === 'object' && typeof b === 'object' &&
    !Array.isArray(a) && !Array.isArray(b);

  if (bothObjects) {
    const keys = new Set([
      ...Object.keys(a as Record<string, unknown>),
      ...Object.keys(b as Record<string, unknown>),
    ]);
    for (const key of keys) {
      compareJson(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
        into,
      );
    }
    return;
  }

  into.add(path);
}

interface Match {
  entry: CaptureEntry;
  byShape: boolean;
}

function matchEntries(
  a: readonly CaptureEntry[],
  b: readonly CaptureEntry[],
): Map<number, Match> {
  const pairs = new Map<number, Match>();
  const exact = groupBy(b, (entry) => endpointKey(entry));
  const pending: CaptureEntry[] = [];

  for (const entry of a) {
    const counterpart = exact.get(endpointKey(entry))?.shift();
    if (counterpart) pairs.set(entry.index, { entry: counterpart, byShape: false });
    else pending.push(entry);
  }

  if (pending.length > 0) {
    const leftovers = [...exact.values()].flat();
    const byShape = groupBy(leftovers, (entry) => endpointShapeKey(entry));
    for (const entry of pending) {
      const counterpart = byShape.get(endpointShapeKey(entry))?.shift();
      if (counterpart) pairs.set(entry.index, { entry: counterpart, byShape: true });
    }
  }

  return pairs;
}

function groupBy(
  entries: readonly CaptureEntry[],
  key: (entry: CaptureEntry) => string,
): Map<string, CaptureEntry[]> {
  const map = new Map<string, CaptureEntry[]>();
  for (const entry of entries) {
    const k = key(entry);
    const list = map.get(k);
    if (list) list.push(entry);
    else map.set(k, [entry]);
  }
  return map;
}

function endpointKey(entry: CaptureEntry): string {
  const url = safeUrl(entry.request.url);
  return `${entry.request.method.toUpperCase()} ${url?.host ?? ''}${url?.pathname ?? entry.request.url}`;
}

function endpointShapeKey(entry: CaptureEntry): string {
  const url = safeUrl(entry.request.url);
  if (!url) return endpointKey(entry);
  const shape = url.pathname.split('/').map(normalizeSegment).join('/');
  return `${entry.request.method.toUpperCase()} ${url.host}${shape}`;
}

/**
 * Segments that look like identifiers become a wildcard. Deliberately narrow: `v1`
 * and `completions` must survive, or two unrelated endpoints would be paired and the
 * diff would invent volatility that is not there.
 */
function normalizeSegment(segment: string): string {
  if (segment === '') return segment;
  if (/^\d+$/.test(segment)) return '{id}';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i.test(segment)) return '{id}';
  if (segment.length >= 8 && /\d/.test(segment) && /^[A-Za-z0-9._~-]+$/.test(segment)) {
    return '{id}';
  }
  return segment;
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
