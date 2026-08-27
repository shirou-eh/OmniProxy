/**
 * Reading a tool call out of ordinary text.
 *
 * Provider web interfaces have no tool-calling API. What they have is a model that
 * will follow a format if asked clearly, so the format is asked for in the prompt
 * (`formatToolDefinitions`) and read back here. That is emulation, it is labelled
 * `text-emulated` in the capability model, and how reliably it works is *unmeasured* —
 * risk R-5, and the honest word rather than a number nobody has checked.
 *
 * This is a port of the parser in `legacy/server.js`, which has been in production
 * against DeepSeek and has had every one of these branches added in response to
 * something a model actually did. The golden test runs both on the same inputs.
 *
 * **Not ported:** the DSML markup family (`｜DSML｜`, `<invoke>`, `<direct>`) that some
 * agent prompts produce. It is a substantial state machine and it is recorded as
 * missing rather than half-done (§12.5). Text carrying that markup returns `null`
 * here with a reason, so the caller can say so instead of returning the raw markup to
 * a client that will try to display it.
 */

const MAX_TOOL_MARKUP_CHARS = 256 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 128 * 1024;

/** A tool name a client can actually route: the same shape OpenAI accepts. */
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;

const DSML_MARKUP =
  /[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i;

export interface EmulatedToolCall {
  name: string;
  /** JSON, always — the OpenAI shape carries arguments as a string. */
  arguments: string;
}

export interface ToolCallParse {
  call?: EmulatedToolCall;
  /** Why nothing was returned, when the text looked like it was trying. */
  unparsed?: string;
}

export function parseEmulatedToolCall(text: string | undefined): ToolCallParse {
  if (!text || typeof text !== 'string') return {};
  if (text.length > MAX_TOOL_MARKUP_CHARS) {
    return { unparsed: `refusing ${text.length} characters of candidate tool markup` };
  }

  if (DSML_MARKUP.test(text)) {
    return {
      unparsed:
        'the model answered with DSML tool markup, which this build does not parse. ' +
        'The reply is returned as text rather than as a tool call.',
    };
  }

  // XML-ish wrappers, used by several agent prompt styles.
  const xml = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i.exec(text);
  if (xml) {
    const call = coerceToolCall(safeJson(xml[1]?.trim()), { allowBare: true });
    if (call) return { call };
  }

  // Fenced JSON blocks.
  const fences = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const fence of fences) {
    const call = coerceToolCall(safeJson(fence[1]?.trim()), {});
    if (call) return { call };
  }

  // The documented form: `TOOL_CALL: name` followed by one balanced JSON object.
  const marker = /TOOL_CALL:\s*([\w-]+)\s*/i.exec(text);
  if (marker) {
    const rest = text.slice(marker.index + marker[0].length);
    const brace = rest.indexOf('{');
    if (brace !== -1) {
      const raw = extractBalancedJson(rest, brace);
      const call = raw ? buildToolCall(marker[1], raw) : undefined;
      if (call) return { call };
      return {
        unparsed: `the model wrote TOOL_CALL: ${marker[1]} but the JSON after it did not parse`,
      };
    }
    return { unparsed: `the model wrote TOOL_CALL: ${marker[1]} with no arguments object` };
  }

  // A bare envelope anywhere in the text. Only explicit ones: a model explaining
  // `{"name": "get_weather"}` in prose is documentation, not a call, and executing it
  // would be the worst possible misreading.
  for (const raw of balancedJsonObjects(text)) {
    const call = coerceToolCall(safeJson(raw), {});
    if (call) return { call };
  }

  return {};
}

/** Whether text looks like an attempt at a tool call, for deciding how to report it. */
export function looksLikeToolMarkup(text: string | undefined): boolean {
  if (!text) return false;
  return (
    DSML_MARKUP.test(text) ||
    /TOOL_CALL:/i.test(text) ||
    /<tool_call[^>]*>/i.test(text) ||
    /"tool_call"|"tool_calls"|"function_call"/.test(text)
  );
}

/* ─────────────────────────────────── internals ─────────────────────────────────── */

function coerceToolCall(
  value: unknown,
  options: { allowBare?: boolean },
): EmulatedToolCall | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;

  let candidate: unknown;
  if (Object.hasOwn(object, 'tool_call')) candidate = object['tool_call'];
  else if (Object.hasOwn(object, 'function_call')) candidate = object['function_call'];
  else if (Object.hasOwn(object, 'tool_calls')) {
    const calls = object['tool_calls'];
    // More than one is ambiguous, and picking the first would be a guess about which
    // the model meant. Zero is not a call at all.
    if (!Array.isArray(calls) || calls.length !== 1) return undefined;
    candidate = calls[0];
  } else if (options.allowBare) candidate = object;

  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  const fn =
    record['function'] !== null && typeof record['function'] === 'object'
      ? (record['function'] as Record<string, unknown>)
      : record;

  return buildToolCall(
    (fn['name'] ?? record['name']) as unknown,
    (fn['arguments'] ?? record['arguments'] ?? record['input'] ?? {}) as unknown,
  );
}

export function buildToolCall(name: unknown, args: unknown): EmulatedToolCall | undefined {
  const toolName = typeof name === 'string' ? name.trim() : '';
  if (!TOOL_NAME.test(toolName)) return undefined;

  let parsed: unknown = args;
  if (typeof parsed === 'string') {
    if (parsed.length > MAX_TOOL_ARGUMENT_CHARS) return undefined;
    parsed = safeJson(parsed);
    if (parsed === undefined) return undefined;
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  let serialized: string;
  try {
    serialized = JSON.stringify(parsed);
  } catch {
    // Circular structures cannot come from JSON.parse, but `args` may arrive from a
    // caller rather than from a parse.
    return undefined;
  }
  if (serialized.length > MAX_TOOL_ARGUMENT_CHARS) return undefined;

  return { name: toolName, arguments: serialized };
}

/** The balanced object starting at `start`, respecting strings and escapes. */
export function extractBalancedJson(text: string, start: number): string | undefined {
  if (text[start] !== '{') return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (character === '\\' && inString) {
      escape = true;
      continue;
    }
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return undefined;
}

/** Every top-level balanced object in the text, scanned once. */
function* balancedJsonObjects(text: string): Iterable<string> {
  let index = text.indexOf('{');
  while (index !== -1) {
    const raw = extractBalancedJson(text, index);
    if (!raw) return;
    yield raw;
    index = text.indexOf('{', index + raw.length);
  }
}

function safeJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
