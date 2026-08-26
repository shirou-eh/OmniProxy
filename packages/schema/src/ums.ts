/**
 * The universal output stream.
 *
 * Every provider, every channel and every modality produces exactly this. Every public
 * API dialect is built from it and from nothing else — which is what stops
 * provider-specific quirks leaking into the protocol layer, and what makes a video
 * requested through /v1/chat/completions and the same video requested through /v1/jobs
 * two views of one thing rather than two implementations.
 *
 * Types rather than Zod schemas: these never cross a trust boundary — they are
 * produced inside the process and consumed inside the process. Validating them at
 * runtime would cost on every delta and prove nothing.
 */

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'canceled'
  | 'error';

export interface Usage {
  /** Estimated: web channels do not report token counts. */
  promptTokens?: number;
  completionTokens?: number;
  estimated: boolean;
  quotaSpent?: { unit: 'message' | 'generation' | 'credit'; amount: number };
}

export type ErrorCode =
  | 'auth_expired'
  | 'auth_missing'
  | 'challenge'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'context_too_long'
  | 'upstream_schema_changed'
  | 'upstream_unavailable'
  | 'endpoint_gone'
  | 'content_filtered'
  | 'timeout'
  | 'canceled'
  | 'not_implemented'
  | 'needs_capture'
  | 'invalid_request'
  | 'internal';

export type RetryScope =
  | 'no'
  | 'same-account'
  | 'same-account-shrunk'
  | 'other-account'
  | 'other-provider';

export interface OmniError {
  code: ErrorCode;
  message: string;
  /** What the person should actually do. Invariant I-2: never absent. */
  userAction: string;
  retryable: RetryScope;
  retryAfterMs?: number;
  provider?: string;
  channel?: string;
  traceId?: string;
}

export type UMSEvent =
  | { type: 'start'; provider: string; channel: string; model: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'text.delta'; text: string }
  | { type: 'search.delta'; text: string }
  | { type: 'tool_call.delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'warning'; code: string; message: string }
  | { type: 'error'; error: OmniError }
  | { type: 'done'; finishReason: FinishReason };

/** Convenience for tests and for the non-streaming path. */
export interface CollectedResponse {
  text: string;
  reasoning: string;
  search: string;
  finishReason: FinishReason;
  usage?: Usage;
  warnings: { code: string; message: string }[];
  error?: OmniError;
}

export async function collectUms(events: AsyncIterable<UMSEvent>): Promise<CollectedResponse> {
  const collected: CollectedResponse = {
    text: '',
    reasoning: '',
    search: '',
    finishReason: 'stop',
    warnings: [],
  };

  for await (const event of events) {
    switch (event.type) {
      case 'text.delta':
        collected.text += event.text;
        break;
      case 'reasoning.delta':
        collected.reasoning += event.text;
        break;
      case 'search.delta':
        collected.search += event.text;
        break;
      case 'usage':
        collected.usage = event.usage;
        break;
      case 'warning':
        collected.warnings.push({ code: event.code, message: event.message });
        break;
      case 'error':
        collected.error = event.error;
        collected.finishReason = 'error';
        break;
      case 'done':
        collected.finishReason = event.finishReason;
        break;
      default:
        break;
    }
  }

  return collected;
}
