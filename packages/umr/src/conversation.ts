/**
 * One conversation shape, which every public dialect converts into.
 *
 * OpenAI, Anthropic and Gemini describe the same conversation three different ways —
 * a string or an array of parts, a `system` field or a `system` role, tool results as
 * their own message or as a block inside a user turn. Behind all three sits one
 * provider that takes a string.
 *
 * If each dialect flattened that conversation itself, the prompt a model sees would
 * depend on which SDK the caller happened to use, and a fix to how tool results are
 * rendered would have to be made three times and would be made twice. So the
 * conversion happens once per dialect, into the shape below, and the flattening
 * happens once for everybody.
 *
 * This is the phase-2 subset of the UMR in `docs/omniproxy/03-interfaces.ts`: the parts
 * a text request needs. Media references, jobs and tenancy join it when the modalities
 * that require them land, and they join it here rather than somewhere new.
 */

export type URole = 'system' | 'user' | 'assistant' | 'tool';

export type UContent =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string }
  /** A tool the assistant asked for. `args` is JSON text, as every dialect carries it. */
  | { type: 'tool_call'; id?: string; name: string; args: string }
  | { type: 'tool_result'; id?: string; text: string }
  /**
   * Something no dialect converter recognised. Kept, not dropped: a model that cannot
   * use an attachment can at least say so, which is a far better failure than
   * answering as though nothing was attached.
   */
  | { type: 'unknown'; description: string };

export interface UMessage {
  role: URole;
  content: UContent[];
}

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema, as the caller supplied it. */
  parameters?: unknown;
}

export interface UniversalRequest {
  /** The alias the caller asked for, exactly as written. */
  model: string;
  messages: UMessage[];
  tools?: ToolDef[];
  stream: boolean;
  /** Canonical knobs. A declaration maps these onto whatever the provider calls them. */
  params: {
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    stop?: string[];
  };
}

/* ─────────────────────────────────── flattening ─────────────────────────────────── */

export interface FlattenedPrompt {
  prompt: string;
  systemPrompt: string;
}

/**
 * Flattens a conversation into one prompt.
 *
 * Most provider web interfaces have no notion of a message array — they take a string
 * and keep their own history server-side. This is the shape `legacy/server.js` used
 * against DeepSeek for months, kept deliberately: the role labels, the blank lines and
 * the `[Tool Result]` marker are all things the model has been observed to follow, and
 * changing them for elegance would change the answers. A golden test in
 * `@omniproxy/dialect-openai` holds the output to byte parity with the legacy
 * formatter, which is why this function looks the way it does rather than the way one
 * would write it fresh.
 *
 * Every message handed to it is rendered. Deciding that a message has nothing worth
 * sending belongs to the dialect converter, which can still see what the caller wrote:
 * here, an empty user turn and one whose parts all rendered to nothing look identical,
 * and treating them alike would silently change one dialect's behaviour to match
 * another's.
 */
export function flattenConversation(
  messages: readonly UMessage[],
  tools?: readonly ToolDef[],
): FlattenedPrompt {
  let systemPrompt = '';
  for (const message of messages) {
    if (message.role === 'system') systemPrompt += `${renderContent(message.content)}\n`;
  }
  if (tools && tools.length > 0) systemPrompt += formatToolDefinitions(tools);

  let conversation = '';
  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'user') {
      conversation += `User: ${renderContent(message.content)}\n\n`;
      continue;
    }

    if (message.role === 'assistant') {
      const calls = message.content.filter(
        (part): part is Extract<UContent, { type: 'tool_call' }> => part.type === 'tool_call',
      );
      if (calls.length > 0) {
        for (const call of calls) {
          conversation += `Assistant: TOOL_CALL: ${call.name}\narguments: ${call.args}\n\n`;
        }
        continue;
      }
      conversation += `Assistant: ${renderContent(message.content)}\n\n`;
      continue;
    }

    // role === 'tool'. No per-result size limit: one large tool result may be the
    // essential input, and the prompt budget is applied once, later, keeping the tail.
    conversation += `[Tool Result]\n${renderContent(message.content)}\n\n`;
  }

  return { prompt: conversation.trim(), systemPrompt: systemPrompt.trim() };
}

/** Content blocks as one string, in the order the caller sent them. */
export function renderContent(content: readonly UContent[]): string {
  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
          return part.text;
        case 'image':
          // Named, not dropped: see the note on `unknown` above.
          return `[Image: ${part.url}]`;
        case 'tool_call':
          return `TOOL_CALL: ${part.name}\narguments: ${part.args}`;
        case 'tool_result':
          return part.id ? `[Tool Result ${part.id}]\n${part.text}` : part.text;
        case 'unknown':
          return part.description;
      }
    })
    .filter((text) => text !== '')
    .join('\n');
}

/* ──────────────────────────────── tool definitions ──────────────────────────────── */

/**
 * Tool definitions as instructions in the prompt.
 *
 * This is emulation, and it is labelled as such everywhere it appears
 * (`emulationSupport: 'text-emulated'`). A provider web interface has no tool-calling
 * API; what it has is a model that will follow a format if you ask clearly. How well
 * it follows is unmeasured (risk R-5), and the capability model says `unmeasured`
 * rather than claiming a number nobody has checked.
 */
export function formatToolDefinitions(tools: readonly ToolDef[]): string {
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
    lines.push(`- ${tool.name}: ${tool.description ?? '(no description)'}`);
    if (tool.parameters !== undefined) {
      lines.push(`  arguments schema: ${JSON.stringify(compactSchema(tool.parameters))}`);
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
