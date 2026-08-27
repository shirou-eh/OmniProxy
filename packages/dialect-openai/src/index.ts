/**
 * @omniproxy/dialect-openai — the OpenAI-compatible surface.
 *
 * Built from UMR and UMS and nothing else (§4). A provider quirk that reaches this
 * package is a bug in the engine: the same universal stream drives the Anthropic and
 * Gemini dialects when they land, and a fix to reasoning or finish reasons has to
 * happen once rather than three times.
 */

export {
  parseChatCompletionRequest,
  flattenMessages,
  normalizeContent,
  formatToolDefinitions,
  compactSchema,
  chatCompletionRequestSchema,
  messageSchema,
  toolSchema,
  OpenAiRequestError,
} from './request.js';
export type {
  ChatCompletionRequest,
  ChatMessage,
  ChatTool,
  FlattenedPrompt,
} from './request.js';

export {
  buildChatCompletion,
  toOpenAiStream,
  toOpenAiError,
  openAiFinish,
  estimateUsage,
} from './response.js';
export type {
  ChatCompletion,
  CompletionOptions,
  StreamOptions,
  ResponseIdentity,
  OpenAiErrorBody,
} from './response.js';

export { toUniversal, toUniversalTools } from './request.js';

/**
 * Re-exported from @omniproxy/umr, which is where they live now: reading a model's
 * tool markup back out of ordinary text has nothing to do with OpenAI, and the
 * Anthropic dialect needs exactly the same parser.
 */
export {
  parseEmulatedToolCall,
  looksLikeToolMarkup,
  buildToolCall,
  extractBalancedJson,
} from '@omniproxy/umr';
export type { EmulatedToolCall, ToolCallParse } from '@omniproxy/umr';
