import {
  flattenConversation,
  type FlattenedPrompt,
  type ToolDef,
  type UContent,
  type UMessage,
} from '@omniproxy/umr';
import { z } from 'zod';

/**
 * The Ollama request, for `/api/chat` and `/api/generate`.
 *
 * Two of its habits are the opposite of every other protocol here, and both would be
 * silent bugs if missed:
 *
 *  - **`stream` defaults to `true`.** Everyone else defaults to false. A client that
 *    omits the field is asking for a stream, and answering with a single JSON object
 *    leaves it waiting for lines that never come.
 *  - **the wire format is NDJSON, not SSE.** One JSON object per line, no `data:`
 *    prefix and no blank-line separator.
 *
 * `/api/generate` is the older single-prompt endpoint, still what a lot of scripts and
 * embedded tools use, so it is served rather than redirected.
 */

export const ollamaMessageSchema = z.looseObject({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().default(''),
  /** Base64 images. Named rather than carried; see `toContent`. */
  images: z.array(z.string()).optional(),
  tool_calls: z
    .array(
      z.looseObject({
        function: z.looseObject({ name: z.string(), arguments: z.unknown().optional() }),
      }),
    )
    .optional(),
});

export const ollamaOptionsSchema = z.looseObject({
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().int().optional(),
  num_predict: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
});

export const ollamaToolSchema = z.looseObject({
  type: z.literal('function').optional(),
  function: z.looseObject({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.unknown().optional(),
  }),
});

export const chatRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(ollamaMessageSchema).min(1),
  stream: z.boolean().optional(),
  format: z.unknown().optional(),
  options: ollamaOptionsSchema.optional(),
  tools: z.array(ollamaToolSchema).optional(),
  keep_alive: z.unknown().optional(),
});

export const generateRequestSchema = z.looseObject({
  model: z.string().min(1),
  prompt: z.string().default(''),
  suffix: z.string().optional(),
  system: z.string().optional(),
  template: z.string().optional(),
  context: z.array(z.number()).optional(),
  stream: z.boolean().optional(),
  raw: z.boolean().optional(),
  format: z.unknown().optional(),
  options: ollamaOptionsSchema.optional(),
  images: z.array(z.string()).optional(),
});

export type OllamaChatRequest = z.infer<typeof chatRequestSchema>;
export type OllamaGenerateRequest = z.infer<typeof generateRequestSchema>;
export type OllamaRequest = OllamaChatRequest | OllamaGenerateRequest;

export class OllamaRequestError extends Error {
  override readonly name = 'OllamaRequestError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function parseChatRequest(body: unknown): OllamaChatRequest {
  const result = chatRequestSchema.safeParse(body);
  if (!result.success) throw refuse(result.error.issues[0]);
  return result.data;
}

export function parseGenerateRequest(body: unknown): OllamaGenerateRequest {
  const result = generateRequestSchema.safeParse(body);
  if (!result.success) throw refuse(result.error.issues[0]);
  return result.data;
}

function refuse(issue: { path: PropertyKey[]; message: string } | undefined): OllamaRequestError {
  const path = issue?.path.join('.') ?? '';
  return new OllamaRequestError(
    `${path || 'request'}: ${issue?.message ?? 'invalid request'}`,
    400,
  );
}

/**
 * Whether to stream.
 *
 * Ollama's default is `true`, and this is the one place where copying another
 * dialect's default would break every client that omits the field — which is most of
 * them, because the default is what they were written against.
 */
export function wantsStream(request: { stream?: boolean | undefined }): boolean {
  return request.stream !== false;
}

export function isChatRequest(request: OllamaRequest): request is OllamaChatRequest {
  return Array.isArray((request as OllamaChatRequest).messages);
}

/** A chat request as a universal conversation. */
export function toUniversal(request: OllamaRequest): UMessage[] {
  if (!isChatRequest(request)) {
    const universal: UMessage[] = [];
    if (request.system) universal.push({ role: 'system', content: [{ type: 'text', text: request.system }] });

    const content = toContent(request.prompt, request.images);
    if (content.length > 0) universal.push({ role: 'user', content });
    return universal;
  }

  const universal: UMessage[] = [];
  for (const message of request.messages) {
    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      universal.push({
        role: 'assistant',
        content: message.tool_calls.map((call) => ({
          type: 'tool_call' as const,
          name: call.function.name,
          // Ollama carries arguments as an object, unlike OpenAI's string.
          args:
            typeof call.function.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function.arguments ?? {}),
        })),
      });
      continue;
    }

    const content = toContent(message.content, message.images);
    if (content.length === 0) continue;

    universal.push({
      role: message.role === 'tool' ? 'tool' : message.role,
      content,
    });
  }
  return universal;
}

export function toUniversalTools(
  tools: readonly z.infer<typeof ollamaToolSchema>[] | undefined,
): ToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    ...(tool.function.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
  }));
}

export function flattenRequest(request: OllamaRequest): FlattenedPrompt {
  const tools = isChatRequest(request) ? toUniversalTools(request.tools) : undefined;
  return flattenConversation(toUniversal(request), tools);
}

/** Canonical knobs, out of Ollama's `options` block. */
export function universalParams(request: OllamaRequest): Record<string, unknown> {
  const options = request.options;
  const params: Record<string, unknown> = {};
  if (!options) return params;
  if (options.temperature !== undefined) params['temperature'] = options.temperature;
  if (options.top_p !== undefined) params['topP'] = options.top_p;
  if (options.top_k !== undefined) params['topK'] = options.top_k;
  // `num_predict: -1` means "no limit" and is not a token budget.
  if (options.num_predict !== undefined && options.num_predict > 0) {
    params['maxTokens'] = options.num_predict;
  }
  if (options.stop !== undefined) {
    params['stop'] = typeof options.stop === 'string' ? [options.stop] : options.stop;
  }
  return params;
}

function toContent(text: string | undefined, images: readonly string[] | undefined): UContent[] {
  const content: UContent[] = [];
  if (text) content.push({ type: 'text', text });

  for (const image of images ?? []) {
    // Named with its size, not carried: the text channel cannot take megabytes of
    // base64, and a model told an image was attached can say it cannot see it — which
    // is a far better failure than answering as though nothing was attached.
    content.push({ type: 'image', url: `${image.length} base64 characters, not sent` });
  }
  return content;
}
