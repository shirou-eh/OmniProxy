import type { ErrorCode, OmniError } from '@omniproxy/schema';

/**
 * The account pool.
 *
 * One account and a hundred accounts run the same code path; one account is the
 * degenerate case, not a special case. That is the whole design rule here, and it is
 * why there is no `if (accounts.length === 1)` anywhere below — a second path is a
 * second set of bugs, and it is always the rarely-taken one that is broken.
 *
 * Nothing in this file ever reads a credential's value. It holds fields, hands them to
 * the engine, and reasons only about which account to use next and when it may be used
 * again. Secrets do not appear in `snapshot()`, in errors, or in anything loggable
 * (§12.7).
 */

export interface Account {
  /** A label for logs and for `omniproxy accounts`. Never a secret. */
  id: string;
  provider: string;
  fields: Record<string, unknown>;
}

interface AccountState {
  account: Account;
  /** Epoch ms of the last time this account was handed out. 0 = never. */
  lastUsedAt: number;
  /** Epoch ms before which this account should not be used again. */
  cooldownUntil: number;
  /**
   * Whether the cooldown came from the provider (a `Retry-After`, a reset timestamp)
   * or from our own guess. We refuse to serve on the provider's word; we do not refuse
   * to serve on our own.
   */
  cooldownAuthoritative: boolean;
  cooldownReason?: string;
  failures: number;
  successes: number;
}

export interface AccountSnapshot {
  id: string;
  provider: string;
  /** Which credential fields exist — the names only, never the values. */
  fields: string[];
  available: boolean;
  cooldownUntil?: number;
  cooldownReason?: string;
  failures: number;
  successes: number;
}

export interface PoolOptions {
  now?: () => number;
}

/**
 * How long an account rests after each kind of failure, when the provider does not say.
 *
 * These are guesses, and they are treated as guesses: see `nextFor`. An authoritative
 * `retryAfterMs` from the provider always wins.
 */
const DEFAULT_COOLDOWN_MS: Partial<Record<ErrorCode, number>> = {
  rate_limit: 60_000,
  quota_exhausted: 15 * 60_000,
  challenge: 5 * 60_000,
  auth_expired: 24 * 60 * 60_000,
  auth_missing: 24 * 60 * 60_000,
  upstream_unavailable: 30_000,
  timeout: 15_000,
};

export class AccountPool {
  private readonly byProvider = new Map<string, AccountState[]>();
  private readonly now: () => number;

  constructor(accounts: readonly Account[] = [], options: PoolOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    for (const account of accounts) this.add(account);
  }

  add(account: Account): void {
    const states = this.byProvider.get(account.provider) ?? [];
    states.push({
      account,
      lastUsedAt: 0,
      cooldownUntil: 0,
      cooldownAuthoritative: false,
      failures: 0,
      successes: 0,
    });
    this.byProvider.set(account.provider, states);
  }

  has(providerId: string): boolean {
    return (this.byProvider.get(providerId)?.length ?? 0) > 0;
  }

  size(providerId: string): number {
    return this.byProvider.get(providerId)?.length ?? 0;
  }

  /**
   * The next account to try, or a refusal that says when to come back.
   *
   * Least-recently-used among the ones that are free — round-robin for a pool, and a
   * constant for a pool of one — preferring an account that is not already at its
   * concurrency limit.
   *
   * When everything is resting the answer depends on *who said so*. If a provider told
   * us to wait — a `Retry-After`, a quota reset — we pass that on rather than spending
   * a request we have been told will fail. If the wait is only our own guess, we try
   * anyway: refusing to work because of our own bookkeeping is the worse mistake, and
   * the provider gets the final word either way.
   */
  nextFor(
    providerId: string,
    exclude: ReadonlySet<string> = new Set(),
    isBusy: (accountId: string) => boolean = () => false,
  ): AccountLease {
    const states = (this.byProvider.get(providerId) ?? []).filter(
      (state) => !exclude.has(state.account.id),
    );
    if (states.length === 0) {
      return { kind: 'none', reason: exclude.size > 0 ? 'exhausted' : 'unconfigured' };
    }

    const now = this.now();
    const free = states.filter((state) => state.cooldownUntil <= now);

    if (free.length > 0) {
      // An account already running its allowance is passed over while another is idle.
      // Advisory only: `isBusy` is the concurrency gate's opinion, and if everything is
      // busy we still hand one out and let the gate do the queueing.
      const idle = free.filter((state) => !isBusy(state.account.id));
      return this.lease(pickLeastRecentlyUsed(idle.length > 0 ? idle : free), now);
    }

    const authoritative = states.filter((state) => state.cooldownAuthoritative);
    if (authoritative.length === states.length) {
      const soonest = states.reduce((a, b) => (a.cooldownUntil <= b.cooldownUntil ? a : b));
      return {
        kind: 'cooling',
        retryAfterMs: Math.max(0, soonest.cooldownUntil - now),
        reason: soonest.cooldownReason ?? 'every account is rate limited',
      };
    }

    // At least one rest is our own guess. Take the soonest of those and try it.
    const guessed = states.filter((state) => !state.cooldownAuthoritative);
    const soonest = guessed.reduce((a, b) => (a.cooldownUntil <= b.cooldownUntil ? a : b));
    return this.lease(soonest, now);
  }

  /** The account worked. Clear any rest it was under. */
  succeed(accountId: string): void {
    const state = this.find(accountId);
    if (!state) return;
    state.successes += 1;
    state.cooldownUntil = 0;
    state.cooldownAuthoritative = false;
    delete state.cooldownReason;
  }

  /**
   * The account failed. Rest it for as long as the failure suggests.
   *
   * A failure that has nothing to do with the account — a malformed request, a schema
   * change upstream — does not rest it. Punishing an account for the caller's typo
   * would slowly disable a whole pool for reasons no log would explain.
   */
  fail(accountId: string, error: OmniError): void {
    const state = this.find(accountId);
    if (!state) return;
    state.failures += 1;

    const authoritative = typeof error.retryAfterMs === 'number';
    const cooldown = error.retryAfterMs ?? DEFAULT_COOLDOWN_MS[error.code];
    if (cooldown === undefined) return;

    state.cooldownUntil = this.now() + cooldown;
    state.cooldownAuthoritative = authoritative;
    state.cooldownReason = `${error.code}: ${error.message}`;
  }

  /** For `/health` and `omniproxy accounts`. Field names only, never values. */
  snapshot(providerId?: string): AccountSnapshot[] {
    const now = this.now();
    const snapshots: AccountSnapshot[] = [];
    for (const [provider, states] of this.byProvider) {
      if (providerId !== undefined && provider !== providerId) continue;
      for (const state of states) {
        const snapshot: AccountSnapshot = {
          id: state.account.id,
          provider,
          fields: Object.keys(state.account.fields).sort(),
          available: state.cooldownUntil <= now,
          failures: state.failures,
          successes: state.successes,
        };
        if (state.cooldownUntil > now) {
          snapshot.cooldownUntil = state.cooldownUntil;
          if (state.cooldownReason) snapshot.cooldownReason = state.cooldownReason;
        }
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  private lease(state: AccountState, now: number): AccountLease {
    state.lastUsedAt = now;
    return { kind: 'account', account: state.account };
  }

  private find(accountId: string): AccountState | undefined {
    for (const states of this.byProvider.values()) {
      const found = states.find((state) => state.account.id === accountId);
      if (found) return found;
    }
    return undefined;
  }
}

export type AccountLease =
  | { kind: 'account'; account: Account }
  | { kind: 'cooling'; retryAfterMs: number; reason: string }
  | { kind: 'none'; reason: 'unconfigured' | 'exhausted' };

function pickLeastRecentlyUsed(states: AccountState[]): AccountState {
  return states.reduce((a, b) => (a.lastUsedAt <= b.lastUsedAt ? a : b));
}

/* ─────────────────────────────── loading from a file ─────────────────────────────── */

export class AccountFileError extends Error {
  override readonly name = 'AccountFileError';
  constructor(
    message: string,
    readonly userAction: string,
  ) {
    super(message);
  }
}

/**
 * Reads an accounts file into accounts.
 *
 * Two shapes are accepted per provider, and both mean the same thing:
 *
 *   "deepseek-web": { "token": "…" }                       — one account
 *   "deepseek-web": [ { "id": "work", "fields": { … } } ]  — a pool
 *
 * A bare object is the fields themselves; an object with a `fields` object is an
 * envelope carrying a label. A provider whose credential is genuinely named `fields`
 * must use the envelope form — the error below says so rather than guessing.
 */
export function parseAccountsFile(raw: unknown): Account[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AccountFileError(
      'the accounts file is not a JSON object',
      'It maps a provider id to its credentials: { "deepseek-web": { "token": "…" } }',
    );
  }

  const accounts: Account[] = [];
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    const entries = Array.isArray(value) ? value : [value];
    entries.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new AccountFileError(
          `${provider}[${index}] is not an object`,
          'Each account is either its credential fields, or { "id": "…", "fields": { … } }.',
        );
      }

      const record = entry as Record<string, unknown>;
      const envelope = record['fields'];
      const isEnvelope = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope);

      const fields = isEnvelope ? (envelope as Record<string, unknown>) : record;
      const label = isEnvelope && typeof record['id'] === 'string' ? record['id'] : undefined;

      if (Object.keys(fields).length === 0) {
        throw new AccountFileError(
          `${provider}[${index}] has no credential fields`,
          'An account with nothing in it cannot authenticate. Remove it or fill it in.',
        );
      }

      accounts.push({
        id: label ?? (entries.length === 1 ? provider : `${provider}#${index + 1}`),
        provider,
        fields,
      });
    });
  }

  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.id)) {
      throw new AccountFileError(
        `two accounts share the id "${account.id}"`,
        'Ids appear in logs and in cooldowns; give each account its own.',
      );
    }
    seen.add(account.id);
  }

  return accounts;
}
