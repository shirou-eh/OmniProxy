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
 * Flattens a conversation into one prompt.
 *
 * Most provider web interfaces have no notion of a message array — they take a string
 * and keep their own history server-side. This is the shape legacy/server.js used
 * against DeepSeek for months, kept deliberately: the role labels, the blank lines,
 * the `[Tool Result]` marker are all things the model has been observed to follow, and
 * changing them for elegance would change the answers.
 */
export interface FlattenedPrompt {
  prompt: string;
  systemPrompt: string;
}

export function flattenMessages(
  messages: readonly ChatMessage[],
  tools?: readonly ChatTool[],
): FlattenedPrompt {
  let systemPrompt = '';
  for (const message of messages) {
    // `developer` is OpenAI's newer name for the same thing.
    if ((message.role === 'system' || message.role === 'developer') && message.content) {
      systemPrompt += `${normalizeContent(message.content)}\n`;
    }
  }
  if (tools && tools.length > 0) systemPrompt += formatToolDefinitions(tools);

  let conversation = '';
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') continue;

    if (message.role === 'user' && message.content) {
      conversation += `User: ${normalizeContent(message.content)}\n\n`;
    } else if (message.role === 'assistant') {
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const call of message.tool_calls) {
          conversation += `Assistant: TOOL_CALL: ${call.function.name}\narguments: ${call.function.arguments}\n\n`;
        }
      } else if (message.content) {
        conversation += `Assistant: ${normalizeContent(message.content)}\n\n`;
      }
    } else if ((message.role === 'tool' || message.role === 'function') && message.content) {
      // No second per-result limit: one large tool result may be the essential input,
      // and the global prompt cap is applied once, later, preserving the latest tail.
      conversation += `[Tool Result]\n${normalizeContent(message.content)}\n\n`;
    }
  }

  return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
}

export function normalizeContent(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part === null || typeof part !== 'object') return '';
        const record = part as Record<string, unknown>;
        const type = record['type'];
        if (type === 'text' || type === 'input_text' || type === 'output_text') {
          return typeof record['text'] === 'string' ? record['text'] : '';
        }
        if (type === 'tool_result') {
          return `[Tool Result ${String(record['tool_use_id'] ?? '')}]\n${normalizeContent(record['content'])}`;
        }
        if (type === 'image_url') {
          const image = record['image_url'] as { url?: string } | undefined;
          // Named, not dropped: a model that cannot see the image can at least say so,
          // which is a far better failure than answering as if nothing was attached.
          return `[Image: ${image?.url ?? ''}]`;
        }
        if (typeof record['text'] === 'string') return record['text'];
        if (typeof record['content'] === 'string') return record['content'];
        return JSON.stringify(part);
      })
      .filter((part) => part !== '')
      .join('\n');
  }

  return String(content);
}

/**
 * Tool definitions as instructions in the prompt.
 *
 * This is emulation, and it is labelled as such everywhere it appears
 * (`emulationSupport: 'text-emulated'`). A provider web interface has no tool-calling
 * API; what it has is a model that will follow a format if you ask clearly. How well
 * it follows is unmeasured (risk R-5), and the capability model says `unmeasured`
 * rather than claiming a number nobody has checked.
 */
export function formatToolDefinitions(tools: readonly ChatTool[]): string {
  if (tools.length === 0) return '';

  const lines = [
    '',
    'You have access to the following tools. To call one, reply with EXACTLY this and nothing else:',
    '',
    'TOOL_CALL: <tool_name>',
    'arguments: <a single line of JSON>',
    '',
    'Call one tool at a time and wait for its result before continuing.',
    'If no tool is needed, answer normally and do not mention the tools.',
    '',
    'Tools:',
  ];

  for (const tool of tools) {
    lines.push(`- ${tool.function.name}: ${tool.function.description ?? '(no description)'}`);
    if (tool.function.parameters !== undefined) {
      lines.push(`  arguments schema: ${JSON.stringify(compactSchema(tool.function.parameters))}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Shrinks a JSON schema to what a model needs to fill it in.
 *
 * Full schemas from real toolchains run to thousands of characters each, and a dozen
 * of them will not fit in a web chat's context alongside the conversation. Names,
 * types, descriptions and which fields are required are what the model uses; `$schema`,
 * `additionalProperties` and `examples` are not.
 */
export function compactSchema(schema: unknown, depth = 0): unknown {
  if (schema === null || typeof schema !== 'object' || depth > 4) return schema;
  if (Array.isArray(schema)) return schema.map((item) => compactSchema(item, depth + 1));

  const source = schema as Record<string, unknown>;
  const compact: Record<string, unknown> = {};

  for (const key of ['type', 'enum', 'required', 'items', 'properties', 'description']) {
    if (source[key] === undefined) continue;
    if (key === 'description' && typeof source[key] === 'string') {
      const text = source[key] as string;
      compact[key] = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      continue;
    }
    if (key === 'properties') {
      // A map of name -> schema, not a schema. Recursing into it as if it were one
      // filters out every property name and leaves the model an empty object to fill.
      const properties = source[key];
      compact[key] =
        properties !== null && typeof properties === 'object' && !Array.isArray(properties)
          ? Object.fromEntries(
              Object.entries(properties as Record<string, unknown>).map(([name, schema]) => [
                name,
                compactSchema(schema, depth + 1),
              ]),
            )
          : properties;
      continue;
    }

    compact[key] = key === 'items' ? compactSchema(source[key], depth + 1) : source[key];
  }

  return compact;
}
