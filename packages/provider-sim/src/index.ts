/**
 * @omniproxy/provider-sim — local servers that speak a provider's web protocol.
 *
 * A simulator is faithful to a *client we have*, never to a service we guessed at
 * (§12.1). It exists so the whole pipeline — engine, recorder, sanitizer, analyzer,
 * replay — can be exercised on traffic that actually crossed a socket, without an
 * account and without a network. It does not make a provider "supported": whether the
 * live service still behaves this way is a canary question, not a test question.
 */

export { startDeepSeekSim, simWasmPath } from './deepseek.js';
export type { DeepSeekSim, DeepSeekSimOptions, SimRequest } from './deepseek.js';

export { powWasmBytes, expectedAnswer } from './pow-wasm.js';
