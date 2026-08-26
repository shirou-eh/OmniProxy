/**
 * @omniproxy/capture — turning real traffic into a provider adapter.
 *
 * Implemented so far (PR-1): HAR import and stream reassembly.
 * Still to come: the sanitizer (PR-2), the analyzer (PR-3), the declaration draft
 * generator (PR-5) and the CDP recorder (PR-7). See docs/omniproxy/04-phase-1-plan.md.
 */

export { importHar, harSchema, HarImportError } from './har.js';
export type { Har, ImportHarOptions } from './har.js';

export { parseSseStream, parseSseFrame, isEventStream } from './sse.js';
export type { ParseSseOptions } from './sse.js';

export {
  omniproxyHome,
  rawCacheDir,
  writeRawBundle,
  pruneRawCache,
  RAW_CACHE_TTL_MS,
} from './store.js';
export type { WriteRawBundleResult } from './store.js';
