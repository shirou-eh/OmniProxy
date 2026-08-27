/**
 * @omniproxy/transport — how the engine actually reaches a provider, and how that
 * reaching gets written down.
 *
 * Three clients, one interface:
 *  - `fetchHttpClient` talks to the network.
 *  - `recordingHttpClient` wraps any client and produces a `CaptureBundle`, which is
 *    what makes "no adapter without a capture" (§12.1) affordable.
 *  - `replayHttpClient` answers from a bundle, so a provider's contract can be tested
 *    in CI without an account, a network or a quota.
 */

export { fetchHttpClient, TransportError } from './fetch-client.js';
export type { FetchClientOptions } from './fetch-client.js';

export { recordingHttpClient } from './recording-client.js';
export type { RecorderOptions, Recording } from './recording-client.js';

export { replayHttpClient, ReplayError } from './replay-client.js';
export type { ReplayOptions, ReplayReport } from './replay-client.js';
