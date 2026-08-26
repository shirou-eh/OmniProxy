/**
 * OmniProxy — core type contracts (proposal, ADR-pending).
 *
 * This file is documentation-grade: it is the reference the implementation in
 * `packages/schema` must satisfy. Runtime validators are Zod schemas; these types
 * are inferred from them, not hand-written twice.
 */

/* ────────────────────────── Modalities & capabilities ────────────────────────── */

export type Modality = 'text' | 'image' | 'video' | 'audio' | 'music' | 'speech' | '3d';

/** Web channels have no native tool calling anywhere; `unmeasured` is the honest
 *  default until the emulation success-rate has actually been measured (risk R-5). */
export type EmulationSupport = 'text-emulated' | 'none' | 'unmeasured';

export interface Capability {
  input: Modality[];
  output: Modality[];
  streaming: boolean;
  /** Requires the job model: video, music, 3d. */
  async: boolean;
  toolCalling: EmulationSupport;
  structuredOutput: EmulationSupport;
  /** Emits a separate reasoning channel. */
  reasoning: boolean;
  webSearch: boolean;
  vision: boolean;
  fileUpload: boolean;
  /** Empirically measured, never taken from marketing claims. */
  contextChars: number;
  maxOutputChars: number;
  editing?: { inpaint?: boolean; outpaint?: boolean; upscale?: boolean; refine?: boolean };
  refs?: { image?: boolean; video?: boolean; audio?: boolean; character?: boolean };
  /** The scarce resource in web channels is quota, not money. */
  quota?: { unit: 'message' | 'generation' | 'credit'; perDay?: number; perHour?: number };
  /** Measured quality of the text-emulated tool protocol, 0..1. Absent = never measured. */
  toolCallAccuracy?: { value: number; samples: number; measuredAt: string };
}

/* ────────────────────────────── Universal request ────────────────────────────── */

export type UPart =
  | { type: 'text'; text: string }
  | { type: 'media'; ref: MediaRef }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };

export interface UMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  parts: UPart[];
  name?: string;
}

export interface MediaRef {
  kind: Modality;
  /** Exactly one of these is set. */
  url?: string;
  dataUri?: string;
  artifactId?: string;
  localPath?: string;
  mime?: string;
  bytes?: number;
}

/** Canonical params. Adapters map these to native names via provider.yaml.
 *  Anything not listed travels in `providerRaw` unvalidated, with a warning. */
export interface CanonicalParams {
  aspectRatio?: string;
  resolution?: string;
  durationSec?: number;
  fps?: number;
  seed?: number;
  steps?: number;
  guidance?: number;
  quality?: 'draft' | 'standard' | 'high';
  style?: string;
  voice?: string;
  language?: string;
  format?: string;
  topology?: 'quad' | 'tri';
  polycount?: number;
  pbr?: boolean;
  webSearch?: boolean;
  reasoning?: boolean;
  providerRaw?: Record<string, unknown>;
}

export interface UMR {
  id: string;
  tenantId: string;
  sessionKey?: string;
  idempotencyKey?: string;
  task: 'chat' | 'generate' | 'edit' | 'transcribe' | 'synthesize';
  target: {
    alias: string;
    require?: Partial<Capability>;
    /** Provider ids to exclude (already failed, user-banned, etc). */
    exclude?: string[];
  };
  input: {
    messages?: UMessage[];
    prompt?: string;
    negativePrompt?: string;
    refs?: MediaRef[];
    params?: CanonicalParams;
  };
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  responseSchema?: unknown; // JSON Schema
  stream: boolean;
  deadlineMs: number;
  deliver?: { mode: 'inline' | 'url' | 'webhook'; webhookUrl?: string };
  /** Set by protocols; used for dialect-specific quirks at the edge only. */
  origin: { dialect: 'openai' | 'anthropic' | 'google' | 'native'; endpoint: string };
}

export interface ToolDef {
  name: string;
  description?: string;
  parameters: unknown; // JSON Schema
}

/* ─────────────────────────────── Universal stream ─────────────────────────────── */

export type UMSEvent =
  | { type: 'start'; requestId: string; provider: string; channel: string; model: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'text.delta'; text: string }
  | { type: 'tool_call.delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'tool_call.done'; index: number; id: string; name: string; args: unknown }
  /** Progress previews for long-running generations. */
  | { type: 'artifact.partial'; jobId: string; progress: number; preview?: MediaRef }
  | { type: 'artifact.final'; artifact: Artifact }
  | { type: 'usage'; usage: Usage }
  | { type: 'warning'; code: string; message: string; detail?: unknown }
  | { type: 'error'; error: OmniError }
  | { type: 'done'; finishReason: FinishReason };

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'canceled' | 'error';

export interface Usage {
  /** Estimated for web channels — providers do not report token counts. */
  promptTokens?: number;
  completionTokens?: number;
  estimated: boolean;
  /** What the request actually consumed from the account's quota. */
  quotaSpent?: { unit: 'message' | 'generation' | 'credit'; amount: number };
}

/* ──────────────────────────────────── Errors ──────────────────────────────────── */

export type ErrorCode =
  | 'auth_expired' | 'auth_missing' | 'challenge' | 'rate_limit' | 'quota_exhausted'
  | 'context_too_long' | 'upstream_schema_changed' | 'upstream_unavailable'
  | 'endpoint_gone' | 'content_filtered' | 'timeout' | 'canceled'
  | 'not_implemented' | 'needs_capture' | 'invalid_request' | 'internal';

export type RetryScope =
  | 'no' | 'same-account' | 'same-account-shrunk' | 'other-account' | 'other-provider';

export interface OmniError {
  code: ErrorCode;
  message: string;
  /** What the user should actually do. The current project does this well; keep it. */
  userAction?: string;
  retryable: RetryScope;
  retryAfterMs?: number;
  provider?: string;
  channel?: string;
  traceId: string;
}

/* ─────────────────────────────────── Adapter ─────────────────────────────────── */

export interface ChannelDescriptor {
  id: string;
  kind: 'web-http' | 'web-browser' | 'gateway-protocol';
  /** Higher = tried first; degradation walks down this list. */
  priority: number;
  requiresImpersonation: boolean;
  concurrencyPerAccount: number;
}

export interface ModelDescriptor {
  alias: string;
  native: string;
  capability: Capability;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'quarantined' | 'unconfigured';
  checkedAt: string;
  lastSuccessAt?: string;
  latencyMs?: number;
  reason?: OmniError;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly channels: ChannelDescriptor[];
  readonly models: ModelDescriptor[];

  health(ctx: AdapterCtx): Promise<HealthReport>;

  auth: {
    describe(): AuthRequirement;
    harvest?(ctx: HarvestCtx): Promise<Credential>;
    refresh?(cred: Credential, ctx: AdapterCtx): Promise<Credential>;
    validate(cred: Credential, ctx: AdapterCtx): Promise<boolean>;
  };

  /** Synchronous path. Must yield UMS events. */
  execute?(req: UMR, ctx: AdapterCtx): AsyncIterable<UMSEvent>;

  /** Asynchronous path for long modalities. */
  submit?(req: UMR, ctx: AdapterCtx): Promise<{ externalId: string; pollAfterMs: number }>;
  poll?(externalId: string, ctx: AdapterCtx): Promise<JobUpdate>;
  cancel?(externalId: string, ctx: AdapterCtx): Promise<void>;
}

export interface AuthRequirement {
  kind: 'cookie' | 'bearer' | 'cookie+bearer' | 'custom';
  domains: string[];
  cookies: { required: string[]; optional: string[] };
  localStorage: { required: string[]; optional: string[] };
  instruction?: string;
}

export interface Credential {
  id: string;
  providerId: string;
  /** Decrypted only inside the process; never logged, never serialized to responses. */
  cookies: Record<string, string>;
  cookieHeader: string;
  local: Record<string, string>;
  extra: Record<string, string>;
  expiresAt?: number;
  /** sha256(cred)[:8] — the only form allowed in logs and metrics. */
  fingerprint: string;
}

/**
 * Everything an adapter is allowed to touch. Adapters MUST NOT call fetch,
 * read process.env, or write files directly — record/replay depends on it.
 */
export interface AdapterCtx {
  readonly traceId: string;
  readonly providerId: string;
  readonly channelId: string;
  readonly account: { id: string; fingerprint: string };
  readonly credential: Credential;

  http: HttpClient;
  browser?: BrowserSession;      // only for web-browser channels
  media: MediaStore;
  state: SessionStateStore;      // per (account, client session) upstream state
  antibot: AntibotRegistry;
  transforms: TransformRegistry; // ADR-0002 level 2
  log: Logger;
  metrics: Metrics;
  clock: Clock;
  signal: AbortSignal;
  /** Declaration for this provider — code adapters override `flow` only. */
  declaration: ProviderDeclaration;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  stream(req: HttpRequest): AsyncIterable<Uint8Array>;
  /** Escalate to the next degradation tier (§6.3) and retry. */
  escalate(reason: 'challenge' | 'tls' | 'js-required'): Promise<void>;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Explicit order matters for fingerprinting; overrides the channel default. */
  headerOrder?: string[];
  body?: Uint8Array | string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Which degradation tier actually served this. Surfaced as a response header. */
  tier: 'undici' | 'impersonate' | 'browser';
}

/* ──────────────────────────────────── Jobs ──────────────────────────────────── */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface Job {
  id: string;
  tenantId: string;
  idempotencyKey?: string;
  request: UMR;
  provider: string;
  channel: string;
  accountId: string;
  externalId?: string;
  status: JobStatus;
  progress: number;              // 0..1
  artifacts: Artifact[];
  error?: OmniError;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  expiresAt: number;
  attempts: number;
  nextPollAt?: number;
  webhookUrl?: string;
}

export interface JobUpdate {
  status: JobStatus;
  progress?: number;
  /** URLs on the provider CDN — the worker downloads them immediately (§6.7). */
  artifactUrls?: string[];
  preview?: MediaRef;
  error?: OmniError;
  pollAfterMs?: number;
}

export interface Artifact {
  id: string;
  jobId?: string;
  tenantId: string;
  modality: Modality;
  /** Sniffed from the byte signature, not from the provider's Content-Type. */
  mime: string;
  bytes: number;
  sha256: string;
  storageKey: string;
  width?: number;
  height?: number;
  durationSec?: number;
  createdAt: number;
  expiresAt?: number;
  sourceUrl?: string;            // provider CDN origin, for audit only
}

/* ─────────────────────────────────── Capture ─────────────────────────────────── */

export interface CaptureBundle {
  id: string;
  providerId: string;
  capturedAt: string;
  method: 'cdp' | 'extension' | 'har-import';
  /** Which user scenario was recorded: chat-stream, image-generate, poll-job... */
  scenario: string;
  /** True only after the sanitizer ran; unsanitized bundles must never be persisted. */
  sanitized: boolean;
  entries: CaptureEntry[];
  /** Placeholder -> what kind of secret it replaced. Values are never stored. */
  redactions: Record<string, 'cookie' | 'token' | 'email' | 'id' | 'pii'>;
  notes: string[];
}

export interface CaptureEntry {
  index: number;
  startedAt: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    headerOrder: string[];
    body?: string;
    bodyEncoding?: 'utf8' | 'base64';
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body?: string;
    bodyEncoding?: 'utf8' | 'base64';
    /** Reassembled SSE / chunked frames, in arrival order. */
    frames?: { at: number; data: string }[];
  };
  /** Analyzer output. */
  classification?: 'auth' | 'session' | 'send' | 'stream' | 'poll' | 'upload'
                 | 'artifact' | 'telemetry' | 'static' | 'unknown';
  /** Fields whose values differed across runs of the same scenario. */
  volatileFields?: string[];
}

/* ─────────────────────────────────── Routing ─────────────────────────────────── */

export interface RoutingPolicy {
  /** Ordering strategy for candidates that satisfy the capability requirement. */
  strategy: 'most-quota-left' | 'fastest' | 'best-quality' | 'least-loaded' | 'manual';
  /** strategy: manual — explicit weights per (provider, channel). */
  weights?: Record<string, number>;
  maxCandidates: number;
  /** Which error scopes are allowed to move the request to another provider. */
  crossProviderOn: RetryScope[];
  /** Refuse a candidate whose canary has been failing for longer than this. */
  maxCanaryAgeMs: number;
  /** Never send a request carrying media refs to a provider without fileUpload. */
  strictCapabilityMatch: boolean;
  stickySession: 'prefer' | 'require' | 'off';
  /** Reserve part of the daily quota for canaries and interactive use. */
  quotaReservePct: number;
}

export interface RouteCandidate {
  providerId: string;
  channelId: string;
  nativeModel: string;
  accountId: string;
  score: number;
  reasons: string[];             // explainable routing, surfaced in debug headers
}

/* ──────────────────── Ports referenced above (abridged) ──────────────────── */

export interface MediaStore {
  put(bytes: Uint8Array, meta: Partial<Artifact>): Promise<Artifact>;
  fetchAndStore(url: string, meta: Partial<Artifact>, ctx: AdapterCtx): Promise<Artifact>;
  get(id: string): Promise<{ artifact: Artifact; stream: ReadableStream }>;
  presign(id: string, ttlMs: number): Promise<string>;
}

export interface SessionStateStore {
  get<T = Record<string, unknown>>(): Promise<T>;
  set(patch: Record<string, unknown>): Promise<void>;
  clear(): Promise<void>;
}

export interface TransformRegistry {
  run(name: string, args: Record<string, unknown>): Promise<string>;
  has(name: string): boolean;
}

export interface AntibotRegistry {
  solve(challenge: string, args: Record<string, unknown>): Promise<string>;
  detect(res: HttpResponse): 'ok' | 'challenge' | 'rate_limit' | 'banned';
}

export interface BrowserSession {
  goto(url: string): Promise<void>;
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  waitForResponse(urlPattern: string, timeoutMs: number): Promise<HttpResponse>;
}

export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void>; }
export interface Logger { debug(o: object, m?: string): void; info(o: object, m?: string): void;
                          warn(o: object, m?: string): void; error(o: object, m?: string): void; }
export interface Metrics { counter(n: string, l?: Record<string, string>): void;
                           histogram(n: string, v: number, l?: Record<string, string>): void; }
export interface HarvestCtx { browser: BrowserSession; log: Logger; instruction(text: string): void; }
export type ProviderDeclaration = unknown; // z.infer<typeof providerSchema>, see packages/schema
