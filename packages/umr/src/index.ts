/**
 * @omniproxy/umr — the universal request.
 *
 * Every public dialect converts its own request shape into the types here, and the
 * gateway and the engine see nothing else. The point is not tidiness: it is that a fix
 * to how a tool result is rendered, or to how a model's tool markup is read back,
 * happens once rather than once per dialect — and "once per dialect" means it happens
 * twice out of three times, and the third one is discovered by a user.
 *
 * This is the phase-2 subset of the UMR sketched in `docs/omniproxy/03-interfaces.ts`:
 * what a text request needs. Media, jobs and tenancy join it here when the modalities
 * that require them land.
 */

export {
  flattenConversation,
  renderContent,
  formatToolDefinitions,
  compactSchema,
} from './conversation.js';
export type {
  URole,
  UContent,
  UMessage,
  ToolDef,
  UniversalRequest,
  FlattenedPrompt,
} from './conversation.js';

export {
  parseEmulatedToolCall,
  looksLikeToolMarkup,
  buildToolCall,
  extractBalancedJson,
} from './tool-emulation.js';
export type { EmulatedToolCall, ToolCallParse } from './tool-emulation.js';
