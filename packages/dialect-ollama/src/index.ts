/**
 * @omniproxy/dialect-ollama — the Ollama-compatible surface.
 *
 * Built from UMR and UMS and nothing else (§4). The fourth dialect on the same two
 * layers, and the one that stresses them differently: NDJSON rather than SSE, and
 * streaming on by default rather than off.
 */

export {
  parseChatRequest,
  parseGenerateRequest,
  wantsStream,
  isChatRequest,
  toUniversal,
  toUniversalTools,
  flattenRequest,
  universalParams,
  chatRequestSchema,
  generateRequestSchema,
  OllamaRequestError,
} from './request.js';
export type {
  OllamaChatRequest,
  OllamaGenerateRequest,
  OllamaRequest,
} from './request.js';

export {
  buildOllamaResponse,
  toOllamaStream,
  toOllamaError,
  ollamaDoneReason,
  approxTokens,
} from './response.js';
export type {
  OllamaRecord,
  OllamaToolCall,
  OllamaErrorBody,
  OllamaOptions,
  ResponseIdentity,
} from './response.js';
