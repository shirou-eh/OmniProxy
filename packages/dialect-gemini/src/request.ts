import {
  flattenConversation,
  type FlattenedPrompt,
  type ToolDef,
  type UContent,
  type UMessage,
} from '@omniproxy/umr';
import { z } from 'zod';

/**
 * The Gemini `generateContent` request.
 *
 * Google's shape diverges from the other two more than they diverge from each other,
 * and in ways that matter here:
 *
 *  - **the model is in the URL**, not the body, so routing needs it passed in;
 *  - the assistant's role is called `model`;
 *  - a turn is `contents[].parts[]`, and a function result is a `functionResponse`
 *    part inside a user turn, keyed by the function's *name* rather than by a call id;
 *  - generation knobs live in a nested `generationConfig`;
 *  - tools are `tools[].functionDeclarations[]` — a list of lists.
 *
 * Each of those is a place where a converter that assumed OpenAI's layout would drop
 * something silently, which is why each has its own test.
 */

export const partSchema = z.union([
  z.object({ text: z.string() }),
  z.looseObject({ inlineData: z.looseObject({ mimeType: z.string().optional() }) }),
  z.looseObject({ fileData: z.looseObject({ fileUri: z.string().optional() }) }),
  z.looseObject({ functionCall: z.looseObject({ name: z.string() }) }),
  z.looseObject({ functionResponse: z.looseObject({ name: z.string() }) }),
  z.looseObject({}),
]);

export const contentSchema = z.looseObject({
  role: z.enum(['user', 'model', 'function']).optional(),
  parts: z.array(partSchema).default([]),
});

export const functionDeclarationSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.unknown().optional(),
});

export const toolSchema = z.looseObject({
  functionDeclarations: z.array(functionDeclarationSchema).optional(),
});

export const generationConfigSchema = z.looseObject({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  stopSequences: z.array(z.string()).optional(),
  candidateCount: z.number().int().optional(),
  responseMimeType: z.string().optional(),
});

export const generateContentRequestSchema = z.looseObject({
  contents: z.array(contentSchema).min(1),
  systemInstruction: contentSchema.optional(),
  tools: z.array(toolSchema).optional(),
  toolConfig: z.looseObject({}).optional(),
  generationConfig: generationConfigSchema.optional(),
  safetySettings: z.array(z.looseObject({})).optional(),
});

export type GenerateContentRequest = z.infer<typeof generateContentRequestSchema>;
export type GeminiContent = z.infer<typeof contentSchema>;

export class GeminiRequestError extends Error {
  override readonly name = 'GeminiRequestError';
  constructor(
    message: string,
    readonly status: number,
    /** Google's `status` string, which clients switch on. */
    readonly reason: string,
  ) {
    super(message);
  }
}

export function parseGenerateContentRequest(body: unknown): GenerateContentRequest {
  const result = generateContentRequestSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '';
    throw new GeminiRequestError(
      `${path || 'request'}: ${issue?.message ?? 'invalid request'}`,
      400,
      'INVALID_ARGUMENT',
    );
  }

  const request = result.data;
  const candidates = request.generationConfig?.candidateCount;
  if (candidates !== undefined && candidates !== 1) {
    // Silently returning one would make a caller's retry logic subtly wrong, the same
    // way `n > 1` does on the OpenAI endpoint.
    throw new GeminiRequestError(
      'generationConfig.candidateCount must be 1: provider web interfaces produce one candidate per request',
      400,
      'INVALID_ARGUMENT',
    );
  }

  return request;
}

/**
 * A Gemini request as a universal one.
 *
 * `functionResponse` parts become their own `tool` message, keeping the caller's
 * order, for the same reason the Anthropic converter lifts `tool_result` out: leaving
 * a function's output inside a user turn makes the model read its own tool output as
 * something the person said.
 */
export function toUniversal(request: GenerateContentRequest): UMessage[] {
  const universal: UMessage[] = [];

  if (request.systemInstruction) {
    const content = toContent(request.systemInstruction.parts);
    if (content.length > 0) universal.push({ role: 'system', content });
  }

  for (const turn of request.contents) {
    const blocks = toContent(turn.parts);
    if (blocks.length === 0) continue;

    // `model` is Google's name for the assistant. An absent role means user, as the
    // single-turn form of the API allows.
    if (turn.role === 'model') {
      universal.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (turn.role === 'function') {
      universal.push({ role: 'tool', content: blocks });
      continue;
    }

    let pending: UContent[] = [];
    const flush = (): void => {
      if (pending.length > 0) {
        universal.push({ role: 'user', content: pending });
        pending = [];
      }
    };

    for (const block of blocks) {
      if (block.type === 'tool_result') {
        flush();
        universal.push({ role: 'tool', content: [block] });
        continue;
      }
      pending.push(block);
    }
    flush();
  }

  return universal;
}

export function toUniversalTools(
  tools: readonly z.infer<typeof toolSchema>[] | undefined,
): ToolDef[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  // A list of lists: one `tools` entry may declare many functions.
  const flat: ToolDef[] = [];
  for (const tool of tools) {
    for (const declaration of tool.functionDeclarations ?? []) {
      flat.push({
        name: declaration.name,
        ...(declaration.description !== undefined ? { description: declaration.description } : {}),
        ...(declaration.parameters !== undefined ? { parameters: declaration.parameters } : {}),
      });
    }
  }
  return flat.length > 0 ? flat : undefined;
}

export function flattenRequest(request: GenerateContentRequest): FlattenedPrompt {
  return flattenConversation(toUniversal(request), toUniversalTools(request.tools));
}

/** Canonical knobs, lifted out of the nested `generationConfig`. */
export function universalParams(request: GenerateContentRequest): Record<string, unknown> {
  const config = request.generationConfig;
  const params: Record<string, unknown> = {};
  if (!config) return params;
  if (config.temperature !== undefined) params['temperature'] = config.temperature;
  if (config.topP !== undefined) params['topP'] = config.topP;
  if (config.topK !== undefined) params['topK'] = config.topK;
  if (config.maxOutputTokens !== undefined) params['maxTokens'] = config.maxOutputTokens;
  if (config.stopSequences !== undefined) params['stop'] = config.stopSequences;
  return params;
}

/**
 * The model name out of a Gemini URL.
 *
 * `/v1beta/models/deepseek-chat:generateContent`, and also
 * `/v1beta/models/deepseek-web/deepseek-chat:generateContent` — the qualified form
 * contains a slash, so the path segment cannot be taken as one word. The method is
 * whatever follows the last colon.
 */
export function parseModelPath(
  path: string,
): { model: string; method: string } | undefined {
  const match = /^\/v1(?:beta\d*)?\/models\/(.+):([A-Za-z]+)$/.exec(path);
  if (!match) return undefined;

  const model = decodeURIComponent(match[1] as string);
  return { model: model.startsWith('models/') ? model.slice('models/'.length) : model, method: match[2] as string };
}

function toContent(parts: readonly unknown[]): UContent[] {
  const content: UContent[] = [];

  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    const record = part as Record<string, unknown>;

    if (typeof record['text'] === 'string') {
      if (record['text'] !== '') content.push({ type: 'text', text: record['text'] });
      continue;
    }

    if (record['functionCall'] !== undefined) {
      const call = record['functionCall'] as Record<string, unknown>;
      content.push({
        type: 'tool_call',
        name: String(call['name'] ?? ''),
        args: JSON.stringify(call['args'] ?? {}),
      });
      continue;
    }

    if (record['functionResponse'] !== undefined) {
      const answer = record['functionResponse'] as Record<string, unknown>;
      // Keyed by name rather than by a call id — Gemini has no id here, so the name is
      // the only handle the model has for matching a result to its call.
      content.push({
        type: 'tool_result',
        ...(typeof answer['name'] === 'string' ? { id: answer['name'] } : {}),
        text: renderResponse(answer['response']),
      });
      continue;
    }

    if (record['inlineData'] !== undefined) {
      const data = record['inlineData'] as Record<string, unknown>;
      const encoded = typeof data['data'] === 'string' ? data['data'] : '';
      content.push({
        type: 'image',
        url: `${String(data['mimeType'] ?? 'inline')}, ${encoded.length} base64 characters, not sent`,
      });
      continue;
    }

    if (record['fileData'] !== undefined) {
      const file = record['fileData'] as Record<string, unknown>;
      content.push({ type: 'image', url: String(file['fileUri'] ?? 'file') });
      continue;
    }

    // Kept and described rather than dropped: a model that cannot use an attachment
    // can at least say so.
    content.push({ type: 'unknown', description: JSON.stringify(part) });
  }

  return content;
}

function renderResponse(response: unknown): string {
  if (response === null || response === undefined) return '';
  if (typeof response === 'string') return response;
  if (typeof response === 'object') {
    const record = response as Record<string, unknown>;
    // The convention is `{ result: … }` or `{ content: … }`; unwrapping it saves the
    // model a layer of JSON it has no reason to reason about.
    for (const key of ['result', 'content', 'output']) {
      const value = record[key];
      if (typeof value === 'string') return value;
      if (value !== undefined) return JSON.stringify(value);
    }
  }
  return JSON.stringify(response);
}
