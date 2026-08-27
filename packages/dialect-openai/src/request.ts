import {
  compactSchema,
  flattenConversation,
  formatToolDefinitions as renderToolDefinitions,
  renderContent,
  type FlattenedPrompt,
  type ToolDef,
  type UContent,
  type UMessage,
} from '@omniproxy/umr';
import { z } from 'zod';

/**
 * The OpenAI Chat Completions request, as clients actually send it.
 *
 * Deliberately permissive about extra fields and deliberately strict about the ones we
 * act on. A client that sends `seed` or `logit_bias` to a provider that cannot honour
 * them should get an answer with a warning, not a 400 — a gateway that rejects a
 * request it could have served is worse than useless, because the caller's code
 * already works against the real API.
 *
 * What is *not* permissive: anything whose silent absence would change the answer. If
 * a caller asks for JSON mode and the provider cannot do JSON mode, pretending is the
 * failure mode that gets found in production by a parser exception.
 */

export const contentPartSchema = z.union([
  z.string(),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('input_text'), text: z.string() }),
  z.object({ type: z.literal('output_text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string(), detail: z.string().optional() }),
  }),
  // Anything else is kept rather than rejected; the flattener describes it.
  z.looseObject({ type: z.string() }),
]);

export const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

export const messageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
});

export const toolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
  }),
});

export const chatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  tools: z.array(toolSchema).optional(),
  tool_choice: z.unknown().optional(),
  response_format: z.looseObject({ type: z.string() }).optional(),
  user: z.string().optional(),
  n: z.number().int().optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type ChatTool = z.infer<typeof toolSchema>;

export class OpenAiRequestError extends Error {
  override readonly name = 'OpenAiRequestError';
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
    readonly param?: string,
  ) {
    super(message);
  }
}

export function parseChatCompletionRequest(body: unknown): ChatCompletionRequest {
  const result = chatCompletionRequestSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    throw new OpenAiRequestError(
      `${path || 'request'}: ${issue?.message ?? 'invalid request'}`,
      400,
      'invalid_request_error',
      path || undefined,
    );
  }

  const request = result.data;

  // `n > 1` would mean several independent completions. Silently returning one is the
  // kind of half-support that makes a caller's retry logic subtly wrong.
  if (request.n !== undefined && request.n !== 1) {
    throw new OpenAiRequestError(
      'n must be 1: provider web interfaces produce one completion per request',
      400,
      'invalid_request_error',
      'n',
    );
  }

  return request;
}

/**
 * OpenAI's request, as a universal one.
 *
 * The rules about which messages survive are legacy's, verbatim, and they are here
 * rather than in the flattener because they are about what an OpenAI caller wrote: a
 * turn whose `content` is falsy is dropped, and a turn whose `content` is an empty
 * array is kept and renders as an empty line. Those two are the same thing to the
 * flattener and different things to a client, and the golden parity test notices.
 */
export function toUniversal(messages: readonly ChatMessage[]): UMessage[] {
  const universal: UMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      // `developer` is OpenAI's newer name for the same role.
      if (message.content) universal.push({ role: 'system', content: toContent(message.content) });
      continue;
    }

    if (message.role === 'user') {
      if (message.content) universal.push({ role: 'user', content: toContent(message.content) });
      continue;
    }

    if (message.role === 'assistant') {
      if (message.tool_calls && message.tool_calls.length > 0) {
        universal.push({
          role: 'assistant',
          content: message.tool_calls.map((call) => ({
            type: 'tool_call' as const,
            ...(call.id ? { id: call.id } : {}),
            name: call.function.name,
            args: call.function.arguments,
          })),
        });
        continue;
      }
      if (message.content) {
        universal.push({ role: 'assistant', content: toContent(message.content) });
      }
      continue;
    }

    // `tool` and `function` are the same thing to a provider that has neither.
    if (message.content) universal.push({ role: 'tool', content: toContent(message.content) });
  }

  return universal;
}

export function toUniversalTools(tools: readonly ChatTool[] | undefined): ToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
  }));
}

/** Flattens an OpenAI conversation. Kept as its own export for the parity test. */
export function flattenMessages(
  messages: readonly ChatMessage[],
  tools?: readonly ChatTool[],
): FlattenedPrompt {
  return flattenConversation(toUniversal(messages), toUniversalTools(tools));
}

function toContent(content: unknown): UContent[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: String(content ?? '') }];

  const parts: UContent[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
      continue;
    }
    if (part === null || typeof part !== 'object') continue;

    const record = part as Record<string, unknown>;
    const type = record['type'];

    if (type === 'text' || type === 'input_text' || type === 'output_text') {
      parts.push({ type: 'text', text: typeof record['text'] === 'string' ? record['text'] : '' });
      continue;
    }
    if (type === 'tool_result') {
      const id = record['tool_use_id'];
      parts.push({
        type: 'tool_result',
        ...(typeof id === 'string' ? { id } : {}),
        text: normalizeContent(record['content']),
      });
      continue;
    }
    if (type === 'image_url') {
      const image = record['image_url'] as { url?: string } | undefined;
      parts.push({ type: 'image', url: image?.url ?? '' });
      continue;
    }
    if (typeof record['text'] === 'string') {
      parts.push({ type: 'text', text: record['text'] });
      continue;
    }
    if (typeof record['content'] === 'string') {
      parts.push({ type: 'text', text: record['content'] });
      continue;
    }
    // Kept as JSON rather than dropped: a model that cannot use the attachment can at
    // least say so, which beats answering as if nothing had been attached.
    parts.push({ type: 'unknown', description: JSON.stringify(part) });
  }

  return parts;
}

/**
 * Content as one string, in OpenAI's terms.
 *
 * Retained because it is part of this package's surface and is what several call sites
 * want; it is the same walk as `toContent` followed by `renderContent`.
 */
export function normalizeContent(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return renderContent(toContent(content));
}

/** Tool definitions as prompt instructions, in OpenAI's `{type, function}` shape. */
export function formatToolDefinitions(tools: readonly ChatTool[]): string {
  return renderToolDefinitions(toUniversalTools(tools) ?? []);
}

export { compactSchema };
export type { FlattenedPrompt };
