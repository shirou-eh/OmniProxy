import {
  flattenConversation,
  type FlattenedPrompt,
  type ToolDef,
  type UContent,
  type UMessage,
} from '@omniproxy/umr';
import { z } from 'zod';

/**
 * The Anthropic Messages request.
 *
 * Same posture as the OpenAI dialect: permissive about fields we do not act on, strict
 * about anything whose silent absence would change the answer. Rejecting a request we
 * could have served is worse than useless, because the caller's code already works
 * against the real API.
 *
 * Three differences from OpenAI shape the converter below, and all three are places a
 * naive port would quietly lose information:
 *
 *  - `system` is a top-level field, not a role;
 *  - a tool result is a *block inside a user turn*, not a message of its own;
 *  - `max_tokens` is required, and clients rely on that being enforced.
 */

export const textBlockSchema = z.object({ type: z.literal('text'), text: z.string() });

export const imageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.looseObject({ type: z.string() }),
});

export const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const toolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

export const thinkingBlockSchema = z.looseObject({
  type: z.literal('thinking'),
  thinking: z.string(),
});

export const contentBlockSchema = z.union([
  textBlockSchema,
  imageBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  thinkingBlockSchema,
  // Anything else is kept and described rather than rejected.
  z.looseObject({ type: z.string() }),
]);

export const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

export const toolSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
});

export const messagesRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  max_tokens: z.number().int().positive(),
  system: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  stop_sequences: z.array(z.string()).optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z.looseObject({ type: z.string() }).optional(),
  thinking: z.looseObject({ type: z.string() }).optional(),
  metadata: z.looseObject({}).optional(),
});

export type MessagesRequest = z.infer<typeof messagesRequestSchema>;
export type AnthropicMessage = z.infer<typeof messageSchema>;
export type AnthropicTool = z.infer<typeof toolSchema>;

export class AnthropicRequestError extends Error {
  override readonly name = 'AnthropicRequestError';
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
  ) {
    super(message);
  }
}

export function parseMessagesRequest(body: unknown): MessagesRequest {
  const result = messagesRequestSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    // `max_tokens` gets its own sentence: it is required by this API and by no other,
    // so a caller porting from OpenAI hits it first and deserves to be told why.
    const detail =
      path === 'max_tokens'
        ? 'max_tokens is required by the Messages API'
        : `${path || 'request'}: ${issue?.message ?? 'invalid request'}`;
    throw new AnthropicRequestError(detail, 400, 'invalid_request_error');
  }
  return result.data;
}

/**
 * An Anthropic request as a universal one.
 *
 * A tool result lives inside a user turn here, and lifting it out into its own `tool`
 * message is what lets one flattener serve both dialects. Splitting a mixed user turn
 * keeps the caller's order: text the user actually typed stays a user turn, and the
 * results stay results, rather than being merged into one blob whose provenance the
 * model has to guess at.
 */
export function toUniversal(request: MessagesRequest): UMessage[] {
  const universal: UMessage[] = [];

  if (request.system !== undefined) {
    const content = toContent(request.system);
    if (content.length > 0) universal.push({ role: 'system', content });
  }

  for (const message of request.messages) {
    const blocks = toContent(message.content);
    if (blocks.length === 0) continue;

    if (message.role === 'assistant') {
      universal.push({ role: 'assistant', content: blocks });
      continue;
    }

    // A user turn may hold tool results, ordinary text, or both.
    let pending: UContent[] = [];
    const flushPending = (): void => {
      if (pending.length > 0) {
        universal.push({ role: 'user', content: pending });
        pending = [];
      }
    };

    for (const block of blocks) {
      if (block.type === 'tool_result') {
        flushPending();
        universal.push({ role: 'tool', content: [block] });
        continue;
      }
      pending.push(block);
    }
    flushPending();
  }

  return universal;
}

export function toUniversalTools(
  tools: readonly AnthropicTool[] | undefined,
): ToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.input_schema !== undefined ? { parameters: tool.input_schema } : {}),
  }));
}

export function flattenRequest(request: MessagesRequest): FlattenedPrompt {
  return flattenConversation(toUniversal(request), toUniversalTools(request.tools));
}

/** Canonical knobs, in the names a declaration maps from. */
export function universalParams(request: MessagesRequest): Record<string, unknown> {
  const params: Record<string, unknown> = { maxTokens: request.max_tokens };
  if (request.temperature !== undefined) params['temperature'] = request.temperature;
  if (request.top_p !== undefined) params['topP'] = request.top_p;
  if (request.top_k !== undefined) params['topK'] = request.top_k;
  if (request.stop_sequences !== undefined) params['stop'] = request.stop_sequences;
  return params;
}

/** True when the caller asked for extended thinking. */
export function wantsThinking(request: MessagesRequest): boolean {
  return request.thinking?.['type'] === 'enabled';
}

function toContent(content: unknown): UContent[] {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];

  const parts: UContent[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push({ type: 'text', text: block });
      continue;
    }
    if (block === null || typeof block !== 'object') continue;

    const record = block as Record<string, unknown>;
    switch (record['type']) {
      case 'text':
        parts.push({ type: 'text', text: String(record['text'] ?? '') });
        break;

      case 'image':
        parts.push({ type: 'image', url: describeSource(record['source']) });
        break;

      case 'tool_use':
        parts.push({
          type: 'tool_call',
          ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
          name: String(record['name'] ?? ''),
          args: JSON.stringify(record['input'] ?? {}),
        });
        break;

      case 'tool_result': {
        const id = record['tool_use_id'];
        const text = renderToolResult(record['content']);
        parts.push({
          type: 'tool_result',
          ...(typeof id === 'string' ? { id } : {}),
          // An error result is labelled as one. A model told only the text will often
          // retry the same call, because nothing told it the call failed.
          text: record['is_error'] === true ? `[error] ${text}` : text,
        });
        break;
      }

      case 'thinking':
        // Dropped on the way in, deliberately: replaying a previous turn's reasoning as
        // if the model had just produced it changes what it does next, and the
        // provider behind us has its own reasoning channel anyway.
        break;

      default:
        parts.push({ type: 'unknown', description: JSON.stringify(block) });
    }
  }

  return parts;
}

/** A tool result's content may be a string or another array of blocks. */
function renderToolResult(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block !== null && typeof block === 'object') {
        const record = block as Record<string, unknown>;
        if (record['type'] === 'text') return String(record['text'] ?? '');
      }
      return JSON.stringify(block);
    })
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * Names an image without carrying it.
 *
 * A base64 image is megabytes and the text channel cannot take it. Saying an image was
 * attached lets the model answer "I cannot see it"; saying nothing makes it answer as
 * though nothing was attached, which reads as the model being wrong.
 */
function describeSource(source: unknown): string {
  if (source === null || typeof source !== 'object') return 'attached';
  const record = source as Record<string, unknown>;
  if (typeof record['url'] === 'string') return record['url'];
  if (record['type'] === 'base64') {
    const data = typeof record['data'] === 'string' ? record['data'] : '';
    return `${String(record['media_type'] ?? 'image')}, ${data.length} base64 characters, not sent`;
  }
  return String(record['type'] ?? 'attached');
}
