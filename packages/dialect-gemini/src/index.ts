/**
 * @omniproxy/dialect-gemini — the Gemini `generateContent`-compatible surface.
 *
 * Built from UMR and UMS and nothing else (§4). The third dialect on the same two
 * layers: one conversation flattener, one tool-markup parser, one request loop.
 */

export {
  parseGenerateContentRequest,
  parseModelPath,
  toUniversal,
  toUniversalTools,
  flattenRequest,
  universalParams,
  generateContentRequestSchema,
  contentSchema,
  toolSchema,
  GeminiRequestError,
} from './request.js';
export type { GenerateContentRequest, GeminiContent } from './request.js';

export {
  buildGenerateContentResponse,
  toGeminiStream,
  toGeminiError,
  geminiFinish,
  estimateUsage,
  approxTokens,
} from './response.js';
export type {
  GenerateContentResponse,
  GeminiPart,
  GeminiErrorBody,
  GenerateOptions,
  StreamOptions,
  ResponseIdentity,
} from './response.js';
