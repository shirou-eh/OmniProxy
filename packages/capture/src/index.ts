/**
 * @omniproxy/capture — turning real traffic into a provider adapter.
 *
 * Implemented so far: HAR import and stream reassembly (PR-1), sanitization and the
 * fixture gate (PR-2). Still to come: the analyzer (PR-3), the declaration draft
 * generator (PR-5) and the CDP recorder (PR-7).
 * See docs/omniproxy/04-phase-1-plan.md.
 */

export { importHar, harSchema, HarImportError } from './har.js';
export type { Har, ImportHarOptions } from './har.js';

export { parseSseStream, parseSseFrame, isEventStream } from './sse.js';
export type { ParseSseOptions } from './sse.js';

export { sanitizeBundle, findResidualSecretShapes, SanitizeError } from './sanitize.js';
export type { SanitizeResult, SanitizeStats, ResidualSecret } from './sanitize.js';

export {
  Redactor,
  isSecretHeader,
  isSecretKey,
  looksHighEntropy,
  parseCookieHeader,
  parseSetCookie,
  authorizationCredential,
  MIN_GLOBAL_REPLACE_LENGTH,
} from './redact.js';
export type { Redaction } from './redact.js';

export {
  omniproxyHome,
  rawCacheDir,
  providerDir,
  providerFixtureDir,
  writeRawBundle,
  writeFixture,
  pruneRawCache,
  FixtureRefused,
  RAW_CACHE_TTL_MS,
} from './store.js';
export type { WriteRawBundleResult } from './store.js';
