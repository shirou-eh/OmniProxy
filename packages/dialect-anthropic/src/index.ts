/**
 * @omniproxy/dialect-anthropic — the Anthropic Messages-compatible surface.
 *
 * Built from UMR and UMS and nothing else (§4), which is the whole point of having
 * them: this package and `@omniproxy/dialect-openai` share one conversation flattener
 * and one tool-markup parser, so a fix to either happens once. A provider quirk that
 * reaches this package is a bug in the engine.
 */

export {
  parseMessagesRequest,
  toUniversal,
  toUniversalTools,
  flattenRequest,
  universalParams,
  wantsThinking,
  messagesRequestSchema,
  messageSchema,
  toolSchema,
  contentBlockSchema,
  AnthropicRequestError,
} from './request.js';
export type { MessagesRequest, AnthropicMessage, AnthropicTool } from './request.js';

export {
  buildMessageResponse,
  toAnthropicStream,
  toAnthropicError,
  anthropicStop,
  estimateUsage,
} from './response.js';
export type {
  AnthropicMessageResponse,
  AnthropicContentBlock,
  AnthropicErrorBody,
  MessageOptions,
  StreamOptions,
  ResponseIdentity,
} from './response.js';
