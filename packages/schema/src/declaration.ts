import { z } from 'zod';
import { capabilitySchema } from './capability.js';
import { modalitySchema } from './modality.js';

/**
 * The `provider.yaml` contract.
 *
 * This schema is a public API (ADR-0003): once people author their own provider
 * modules, changing it breaks their work. Two consequences show up as design choices
 * here:
 *
 *  - **Objects are strict.** An unknown key is an error, not something silently
 *    ignored. A typo in a declaration must fail at validation with a path to the
 *    offending line, not at 3am with an empty response from a provider.
 *  - **The whole documented format is modelled, not just the part the engine runs
 *    today.** A declaration written against the documentation validates now, even
 *    where execution lands in a later phase; the unimplemented sections are marked in
 *    the comments below. Validating less than we document would teach authors to
 *    write things that quietly do nothing.
 */

/* ────────────────────────────── shared fragments ────────────────────────────── */

/** A `{{...}}` template, a literal, or any JSON the request body needs. */
export const templateValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(templateValueSchema),
    z.record(z.string(), templateValueSchema),
  ]),
);

/** A JSONPath subset expression, e.g. `$.data.biz_data.id`. */
export const jsonPathSchema = z.string().refine((value) => value.startsWith('$'), {
  message: 'must be a JSONPath expression starting with $',
});

export const httpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export const requestSpecSchema = z
  .strictObject({
    method: httpMethodSchema.default('GET'),
    /** Path appended to the channel base, or an absolute URL. Templated. */
    path: z.string().optional(),
    url: z.string().optional(),
    query: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** JSON body; every string inside is templated. */
    json: templateValueSchema.optional(),
    /** Raw body, templated. Mutually exclusive with `json`. */
    body: z.string().optional(),
    form: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .refine((spec) => spec.path !== undefined || spec.url !== undefined, {
    message: 'a request needs either `path` (relative to the channel base) or `url`',
  })
  .refine((spec) => !(spec.json !== undefined && spec.body !== undefined), {
    message: 'a request cannot have both `json` and `body`',
  });

/* ─────────────────────────────────── channels ─────────────────────────────────── */

export const channelKindSchema = z.enum([
  'web-http',
  'web-browser',
  'gateway-protocol',
  /** The endpoint a desktop application talks to (ADR-0006). */
  'app-backend',
  /** A third-party proxy OmniProxy supervises (ADR-0006). Requires explicit trust. */
  'local-process',
]);

export const fingerprintSchema = z.strictObject({
  /** A name from the transport profile registry, not a position on a scale. */
  profile: z.string().default('node-undici'),
  /** Requires the TLS impersonation sidecar. */
  impersonate: z.boolean().default(false),
  headerOrder: z.array(z.string()).optional(),
  static: z.record(z.string(), z.string()).default({}),
});

export const processSpecSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  port: z.union([z.literal('auto'), z.number().int().positive()]).default('auto'),
  readyWhen: z
    .strictObject({
      request: requestSpecSchema,
      timeoutMs: z.number().int().positive().default(15000),
    })
    .optional(),
  restart: z
    .strictObject({
      maxAttempts: z.number().int().nonnegative().default(5),
      backoffMs: z.number().int().positive().default(1000),
      maxBackoffMs: z.number().int().positive().default(30000),
    })
    .default({ maxAttempts: 5, backoffMs: 1000, maxBackoffMs: 30000 }),
});

export const channelSchema = z.strictObject({
  id: z.string().min(1),
  kind: channelKindSchema,
  base: z.string().optional(),
  entryUrl: z.string().optional(),
  fingerprint: fingerprintSchema.default({ profile: 'node-undici', impersonate: false, static: {} }),
  http2: z.boolean().default(true),
  proxy: z.enum(['inherit', 'required', 'none']).default('inherit'),
  concurrency: z.number().int().positive().default(1),
  rateLimit: z
    .strictObject({
      perMinute: z.number().int().positive().optional(),
      perHour: z.number().int().positive().optional(),
    })
    .optional(),
  /** Only for kind: local-process. Not executed before phase 2. */
  process: processSpecSchema.optional(),
  /** Dialect a local-process channel answers in. */
  speaks: z.enum(['openai', 'anthropic', 'google']).optional(),
  /** Path to a code adapter (ADR-0002 level 3). Loading it requires trust. */
  adapter: z.string().optional(),
});

/* ──────────────────────────────────── auth ──────────────────────────────────── */

export const authKindSchema = z.enum([
  'cookie',
  'bearer',
  'cookie+bearer',
  /** Token read from a desktop application's local state file (ADR-0006). */
  'local-file',
  'none',
  'custom',
]);

export const localFileSourceSchema = z.strictObject({
  win32: z.string().optional(),
  linux: z.string().optional(),
  darwin: z.string().optional(),
});

export const harvestSchema = z.strictObject({
  domains: z.array(z.string()).default([]),
  cookies: z
    .strictObject({
      required: z.array(z.string()).default([]),
      optional: z.array(z.string()).default([]),
    })
    .default({ required: [], optional: [] }),
  localStorage: z
    .strictObject({
      required: z.array(z.string()).default([]),
      optional: z.array(z.string()).default([]),
    })
    .default({ required: [], optional: [] }),
  indexedDB: z.array(z.string()).default([]),
  /** For auth.kind: local-file. */
  file: localFileSourceSchema.optional(),
  extract: z.record(z.string(), jsonPathSchema).optional(),
  /** Re-read the file when the application rewrites it, instead of refreshing. */
  watch: z.boolean().default(false),
  afterLogin: z.strictObject({ instruction: z.string() }).optional(),
});

export const authSchema = z.strictObject({
  kind: authKindSchema,
  harvest: harvestSchema.optional(),
  present: z
    .strictObject({
      headers: z.record(z.string(), z.string()).default({}),
    })
    .default({ headers: {} }),
  /** Not executed before phase 2. */
  validate: z
    .strictObject({
      request: requestSpecSchema,
      expect: z.strictObject({
        status: z.number().int().optional(),
        jsonPath: jsonPathSchema.optional(),
        exists: z.boolean().optional(),
      }),
    })
    .optional(),
  refresh: z
    .strictObject({
      mode: z.enum(['none', 'endpoint', 'browser-reauth']).default('none'),
      ttlHint: z.number().int().positive().optional(),
      request: requestSpecSchema.optional(),
      extract: z.record(z.string(), jsonPathSchema).optional(),
    })
    .optional(),
  quota: z
    .strictObject({
      unit: z.enum(['message', 'generation', 'credit']),
      perDay: z.number().int().positive().optional(),
      perHour: z.number().int().positive().optional(),
      resetAt: z.string().optional(),
    })
    .optional(),
});

/* ─────────────────────────────────── antibot ─────────────────────────────────── */

export const matchSchema = z.strictObject({
  status: z.number().int().optional(),
  bodyContains: z.string().optional(),
  jsonPath: jsonPathSchema.optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const antibotSchema = z.strictObject({
  challenges: z.array(z.string()).default([]),
  detect: z
    .array(
      z.strictObject({
        match: matchSchema,
        as: z.enum(['challenge', 'rate_limit', 'banned']),
        escalate: z.enum(['impersonate', 'browser']).optional(),
        cooldownFrom: z.string().optional(),
      }),
    )
    .default([]),
});

/* ──────────────────────────────────── vars ──────────────────────────────────── */

export const varSpecSchema = z.strictObject({
  /** Name from the transform registry (ADR-0002 level 2). Never inline code. */
  transform: z.string().min(1),
  with: z.record(z.string(), templateValueSchema).default({}),
});

/* ──────────────────────────────────── flow ──────────────────────────────────── */

export const streamFormatSchema = z.enum([
  'sse',
  'ndjson',
  'json-patch',
  'websocket',
  'poll',
  'plain',
]);

export const streamMapSchema = z.strictObject({
  text: jsonPathSchema.optional(),
  reasoning: jsonPathSchema.optional(),
  search: jsonPathSchema.optional(),
  messageId: jsonPathSchema.optional(),
  finish: jsonPathSchema.optional(),
  usage: jsonPathSchema.optional(),
  toolCalls: jsonPathSchema.optional(),
});

/**
 * JSON-patch framing: a stream of `{p, o, v}` operations, as DeepSeek Web uses. The
 * fragment a patch belongs to is decided by the path prefix it targets.
 */
export const streamPatchSchema = z.strictObject({
  pathField: z.string().default('p'),
  opField: z.string().default('o'),
  valueField: z.string().default('v'),
  /** Fragment type -> which UMS channel it feeds. */
  routes: z.record(z.string(), z.enum(['text', 'reasoning', 'search'])),
  /** Where the fragment type lives inside an insert operation. */
  typeField: z.string().default('type'),
});

export const streamSpecSchema = z.strictObject({
  format: streamFormatSchema,
  doneWhen: z.strictObject({ data: z.string() }).optional(),
  map: streamMapSchema.optional(),
  patch: streamPatchSchema.optional(),
});

export const stepSchema = z.strictObject({
  /** Run only when this template resolves to something truthy. */
  when: z.string().optional(),
  /** Run only when this template resolves to nothing. */
  unless: z.string().optional(),
  request: requestSpecSchema,
  extract: z.record(z.string(), jsonPathSchema).optional(),
  persist: z.record(z.string(), z.string()).optional(),
  stream: streamSpecSchema.optional(),
  /**
   * How to read a whole-body answer, for providers that do not stream. Without it a
   * one-shot provider would have to be written as a code adapter for want of two
   * JSONPaths — which is exactly the outcome this engine exists to avoid.
   */
  response: streamMapSchema.optional(),
  pollAfterMs: z.number().int().nonnegative().optional(),
});

export const pollSpecSchema = z.strictObject({
  request: requestSpecSchema,
  intervalMs: z.number().int().positive().default(5000),
  backoff: z
    .strictObject({
      factor: z.number().positive().default(1.5),
      maxMs: z.number().int().positive().default(30000),
    })
    .optional(),
  timeoutMs: z.number().int().positive().default(1800000),
  map: z.strictObject({
    status: z.strictObject({
      from: jsonPathSchema,
      values: z.record(z.string(), z.enum(['queued', 'running', 'succeeded', 'failed'])),
    }),
    progress: jsonPathSchema.optional(),
    progressRange: z.tuple([z.number(), z.number()]).optional(),
    artifacts: jsonPathSchema.optional(),
    error: jsonPathSchema.optional(),
  }),
});

export const flowSchema = z.strictObject({
  /**
   * Ordered steps that run before anything else: fetching a challenge, warming a
   * session, asking for an upload token. DeepSeek needs one (the PoW challenge), and
   * a flow that could not express "do this first" would push every such provider into
   * a code adapter for the sake of a single extra GET.
   */
  prepare: z.array(stepSchema).default([]),
  createSession: stepSchema.optional(),
  send: stepSchema.optional(),
  submit: stepSchema.optional(),
  poll: pollSpecSchema.optional(),
  cancel: stepSchema.optional(),
  upload: z
    .strictObject({
      negotiate: stepSchema.optional(),
      put: z.strictObject({
        method: httpMethodSchema.default('PUT'),
        url: z.string(),
        bodyFrom: z.enum(['ref']).default('ref'),
      }),
      commit: stepSchema.optional(),
    })
    .optional(),
  download: z
    .strictObject({
      auth: z.enum(['inherit', 'none']).default('none'),
      expiresHint: z.number().int().positive().optional(),
    })
    .optional(),
});

/* ─────────────────────────────────── errors ─────────────────────────────────── */

export const errorRuleSchema = z.strictObject({
  match: matchSchema,
  as: z.enum([
    'auth_expired',
    'auth_missing',
    'challenge',
    'rate_limit',
    'quota_exhausted',
    'context_too_long',
    'upstream_unavailable',
    'content_filtered',
    'invalid_request',
    'internal',
  ]),
  retryable: z
    .enum(['no', 'same-account', 'same-account-shrunk', 'other-account', 'other-provider'])
    .default('no'),
  userMessage: z.string().optional(),
});

/* ─────────────────────────────────── models ─────────────────────────────────── */

export const paramMapSchema = z.strictObject({
  path: z.string(),
  type: z.enum(['string', 'int', 'number', 'boolean']).default('string'),
  range: z.tuple([z.number(), z.number()]).optional(),
});

export const modelSchema = z.strictObject({
  alias: z.string().min(1),
  native: z.string().min(1),
  modality: z
    .strictObject({
      input: z.array(modalitySchema).default(['text']),
      output: z.array(modalitySchema).default(['text']),
    })
    .optional(),
  capability: capabilitySchema.partial().optional(),
  params: z
    .strictObject({
      map: z.record(z.string(), paramMapSchema).default({}),
      unsupported: z.array(z.string()).default([]),
    })
    .optional(),
  /** Extra body fields merged into the send request for this model. */
  extra: z.record(z.string(), templateValueSchema).optional(),
});

/* ─────────────────────────────────── context ─────────────────────────────────── */

export const contextSchema = z.strictObject({
  strategy: z.enum(['flatten-to-prompt', 'native-messages']).default('flatten-to-prompt'),
  compaction: z
    .enum(['truncate-middle', 'summarize-oldest', 'sliding-window'])
    .default('truncate-middle'),
  measured: z
    .strictObject({
      contextChars: z.number().int().positive(),
      measuredAt: z.iso.date(),
      method: z.string().optional(),
    })
    .optional(),
});

/* ──────────────────────────────────── probe ──────────────────────────────────── */

export const probeSchema = z.strictObject({
  interval: z.string().default('30m'),
  request: z.strictObject({ prompt: z.string() }),
  expect: z.strictObject({
    contains: z.string().optional(),
    maxLatencyMs: z.number().int().positive().optional(),
    maxFirstByteMs: z.number().int().positive().optional(),
  }),
  onFail: z
    .strictObject({
      after: z.number().int().positive().default(2),
      action: z.enum(['quarantine', 'degrade', 'alert-only']).default('quarantine'),
    })
    .optional(),
});

/* ──────────────────────────────── the declaration ──────────────────────────────── */

export const providerStatusSchema = z.enum([
  'needs-capture',
  'unverified',
  'experimental',
  'broken',
  'stable',
]);

export const providerClassSchema = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'unknown']);

export const providerDeclarationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** Lowercase: NTFS is case-insensitive and ext4 is not (ADR-0005). */
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    displayName: z.string().optional(),
    class: providerClassSchema.default('unknown'),
    status: providerStatusSchema,
    homepage: z.string().optional(),

    capture: z
      .strictObject({
        bundle: z.string().optional(),
        capturedAt: z.iso.date().optional(),
        method: z.enum(['cdp', 'extension', 'har-import']).optional(),
        coverage: z.array(z.string()).default([]),
      })
      .optional(),

    /** Hosts this declaration may talk to, beyond its channel bases. */
    allowedHosts: z.array(z.string()).default([]),

    channels: z.array(channelSchema).min(1),
    auth: authSchema,
    antibot: antibotSchema.optional(),
    vars: z.record(z.string(), varSpecSchema).default({}),
    flow: flowSchema,
    errors: z.array(errorRuleSchema).default([]),
    context: contextSchema.optional(),
    models: z.array(modelSchema).default([]),
    probe: probeSchema.optional(),
  })
  .superRefine((declaration, ctx) => {
    const ids = new Set<string>();
    for (const channel of declaration.channels) {
      if (ids.has(channel.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate channel id: ${channel.id}` });
      }
      ids.add(channel.id);
      if (channel.kind === 'local-process' && !channel.process) {
        ctx.addIssue({
          code: 'custom',
          message: `channel ${channel.id} is a local-process but has no process block`,
        });
      }
      if (channel.kind !== 'local-process' && !channel.base && !channel.entryUrl) {
        ctx.addIssue({
          code: 'custom',
          message: `channel ${channel.id} needs a base URL`,
        });
      }
    }

    const aliases = new Set<string>();
    for (const model of declaration.models) {
      if (aliases.has(model.alias)) {
        ctx.addIssue({ code: 'custom', message: `duplicate model alias: ${model.alias}` });
      }
      aliases.add(model.alias);
    }

    if (declaration.auth.kind === 'local-file' && !declaration.auth.harvest?.file) {
      ctx.addIssue({
        code: 'custom',
        message: 'auth.kind is local-file but no harvest.file paths are given',
      });
    }

    if (declaration.flow.poll && !declaration.flow.submit) {
      ctx.addIssue({ code: 'custom', message: 'flow.poll without flow.submit polls nothing' });
    }
  });

export type ProviderDeclaration = z.infer<typeof providerDeclarationSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type RequestSpec = z.infer<typeof requestSpecSchema>;
export type StepSpec = z.infer<typeof stepSchema>;
export type StreamSpec = z.infer<typeof streamSpecSchema>;
export type ErrorRule = z.infer<typeof errorRuleSchema>;
export type ModelSpec = z.infer<typeof modelSchema>;
export type VarSpec = z.infer<typeof varSpecSchema>;
