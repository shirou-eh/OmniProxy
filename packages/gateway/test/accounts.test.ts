import type { OmniError } from '@omniproxy/schema';
import { describe, expect, it } from 'vitest';
import {
  AccountFileError,
  AccountPool,
  parseAccountsFile,
  type Account,
} from '../src/accounts.js';

/**
 * The pool exists to make one account and many accounts the same code path.
 *
 * Most of what follows is therefore about the boundaries where a second path would
 * have crept in: the pool of one, the pool that is entirely resting, the account that
 * fails for a reason that is not its fault.
 */

const clock = (start = 1_000_000): { now: () => number; advance: (ms: number) => void } => {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
};

function account(id: string, provider = 'p'): Account {
  return { id, provider, fields: { token: `secret-for-${id}` } };
}

function error(code: OmniError['code'], extra: Partial<OmniError> = {}): OmniError {
  return {
    code,
    message: `${code} happened`,
    userAction: 'do something',
    retryable: 'other-account',
    ...extra,
  };
}

describe('AccountPool selection', () => {
  it('reports what it holds', () => {
    const pool = new AccountPool([account('a'), account('b'), account('c', 'q')]);
    expect(pool.size('p')).toBe(2);
    expect(pool.size('q')).toBe(1);
    expect(pool.size('nobody')).toBe(0);
    expect(pool.has('p')).toBe(true);
    expect(pool.has('nobody')).toBe(false);
  });

  it('says so, rather than throwing, when a provider has no accounts', () => {
    const lease = new AccountPool().nextFor('p');
    expect(lease).toEqual({ kind: 'none', reason: 'unconfigured' });
  });

  it('hands out the only account, again and again', () => {
    // The pool of one is the common case and must not be a special case.
    const pool = new AccountPool([account('solo')]);
    for (let call = 0; call < 5; call += 1) {
      const lease = pool.nextFor('p');
      expect(lease.kind).toBe('account');
      expect(lease.kind === 'account' && lease.account.id).toBe('solo');
    }
  });

  it('rotates through a pool, least recently used first', () => {
    const time = clock();
    const pool = new AccountPool([account('a'), account('b'), account('c')], { now: time.now });

    const order: string[] = [];
    for (let call = 0; call < 6; call += 1) {
      const lease = pool.nextFor('p');
      if (lease.kind === 'account') order.push(lease.account.id);
      time.advance(1);
    }

    expect(order).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('never returns an account the caller has already tried', () => {
    const pool = new AccountPool([account('a'), account('b')]);
    const first = pool.nextFor('p');
    expect(first.kind).toBe('account');

    const second = pool.nextFor('p', new Set(['a']));
    expect(second.kind === 'account' && second.account.id).toBe('b');

    const third = pool.nextFor('p', new Set(['a', 'b']));
    expect(third).toEqual({ kind: 'none', reason: 'exhausted' });
  });

  it("keeps one provider's accounts out of another provider's answer", () => {
    const pool = new AccountPool([account('a', 'p'), account('b', 'q')]);
    const lease = pool.nextFor('q');
    expect(lease.kind === 'account' && lease.account.id).toBe('b');
  });
});

describe('AccountPool cooldowns', () => {
  it('rests an account after a rate limit and comes back to it', () => {
    const time = clock();
    const pool = new AccountPool([account('a'), account('b')], { now: time.now });

    pool.fail('a', error('rate_limit'));

    const during = pool.nextFor('p');
    expect(during.kind === 'account' && during.account.id).toBe('b');

    time.advance(61_000);
    const after = pool.nextFor('p', new Set(['b']));
    expect(after.kind === 'account' && after.account.id).toBe('a');
  });

  it('obeys a provider-supplied Retry-After over its own guess', () => {
    const time = clock();
    const pool = new AccountPool([account('solo')], { now: time.now });

    pool.fail('solo', error('rate_limit', { retryAfterMs: 5_000 }));

    // The provider said five seconds, not the sixty this pool would have guessed.
    const cooling = pool.nextFor('p');
    expect(cooling.kind).toBe('cooling');
    expect(cooling.kind === 'cooling' && cooling.retryAfterMs).toBe(5_000);

    time.advance(5_001);
    expect(pool.nextFor('p').kind).toBe('account');
  });

  it('refuses to serve only when the provider is the one saying wait', () => {
    // Refusing on our own guess would mean the gateway stops working because of its own
    // bookkeeping. The provider gets the final word, so we try anyway.
    const time = clock();
    const pool = new AccountPool([account('solo')], { now: time.now });

    pool.fail('solo', error('rate_limit'));
    const lease = pool.nextFor('p');
    expect(lease.kind).toBe('account');
    expect(lease.kind === 'account' && lease.account.id).toBe('solo');
  });

  it('waits for the soonest account when every rest is authoritative', () => {
    const time = clock();
    const pool = new AccountPool([account('a'), account('b')], { now: time.now });

    pool.fail('a', error('rate_limit', { retryAfterMs: 90_000 }));
    pool.fail('b', error('quota_exhausted', { retryAfterMs: 30_000 }));

    const lease = pool.nextFor('p');
    expect(lease.kind).toBe('cooling');
    expect(lease.kind === 'cooling' && lease.retryAfterMs).toBe(30_000);
    expect(lease.kind === 'cooling' && lease.reason).toMatch(/quota_exhausted/);
  });

  it('does not punish an account for a failure that is not its fault', () => {
    // A malformed request or a changed upstream schema has nothing to do with the
    // credentials. Resting one for it would slowly disable a pool for no logged reason.
    const time = clock();
    const pool = new AccountPool([account('solo')], { now: time.now });

    for (const code of ['invalid_request', 'upstream_schema_changed', 'content_filtered'] as const) {
      pool.fail('solo', error(code, { retryable: 'no' }));
      expect(pool.snapshot()[0]?.available).toBe(true);
    }
    expect(pool.snapshot()[0]?.failures).toBe(3);
  });

  it('clears the rest when the account works again', () => {
    const time = clock();
    const pool = new AccountPool([account('solo')], { now: time.now });

    pool.fail('solo', error('rate_limit', { retryAfterMs: 600_000 }));
    expect(pool.nextFor('p').kind).toBe('cooling');

    pool.succeed('solo');
    expect(pool.nextFor('p').kind).toBe('account');
    expect(pool.snapshot()[0]?.successes).toBe(1);
  });

  it('ignores bookkeeping for an account it has never heard of', () => {
    const pool = new AccountPool([account('solo')]);
    expect(() => pool.fail('ghost', error('rate_limit'))).not.toThrow();
    expect(() => pool.succeed('ghost')).not.toThrow();
  });

  it('rests an expired credential for long enough to be noticed', () => {
    const time = clock();
    const pool = new AccountPool([account('a'), account('b')], { now: time.now });
    pool.fail('a', error('auth_expired'));

    time.advance(60 * 60_000);
    const lease = pool.nextFor('p', new Set(['b']));
    // Still resting an hour later, because a re-capture is a human action.
    expect(lease.kind).toBe('account');
    expect(pool.snapshot().find((s) => s.id === 'a')?.available).toBe(false);
  });
});

describe('AccountPool.snapshot', () => {
  it('names the credential fields and never their values (§12.7)', () => {
    const pool = new AccountPool([
      { id: 'a', provider: 'p', fields: { token: 'ds-super-secret', cookie: 'sid=abc' } },
    ]);

    const snapshot = pool.snapshot();
    expect(snapshot[0]?.fields).toEqual(['cookie', 'token']);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('ds-super-secret');
    expect(serialized).not.toContain('sid=abc');
  });

  it('reports why an account is resting, and until when', () => {
    const time = clock();
    const pool = new AccountPool([account('a')], { now: time.now });
    pool.fail('a', error('quota_exhausted', { retryAfterMs: 1_000, message: 'daily limit' }));

    const [snapshot] = pool.snapshot();
    expect(snapshot?.available).toBe(false);
    expect(snapshot?.cooldownReason).toMatch(/quota_exhausted: daily limit/);
    expect(snapshot?.cooldownUntil).toBe(time.now() + 1_000);
  });

  it('can be narrowed to one provider', () => {
    const pool = new AccountPool([account('a', 'p'), account('b', 'q')]);
    expect(pool.snapshot('q').map((s) => s.id)).toEqual(['b']);
    expect(pool.snapshot().length).toBe(2);
  });
});

describe('parseAccountsFile', () => {
  it('reads the one-account shape', () => {
    expect(parseAccountsFile({ 'deepseek-web': { token: 't' } })).toEqual([
      { id: 'deepseek-web', provider: 'deepseek-web', fields: { token: 't' } },
    ]);
  });

  it('reads a pool and numbers the accounts it was not given names for', () => {
    const accounts = parseAccountsFile({ p: [{ token: 'a' }, { token: 'b' }] });
    expect(accounts.map((entry) => entry.id)).toEqual(['p#1', 'p#2']);
  });

  it('takes the label from the envelope form', () => {
    const accounts = parseAccountsFile({
      p: [
        { id: 'work', fields: { token: 'a' } },
        { id: 'personal', fields: { token: 'b' } },
      ],
    });
    expect(accounts.map((entry) => entry.id)).toEqual(['work', 'personal']);
    expect(accounts[0]?.fields).toEqual({ token: 'a' });
  });

  it('mixes both shapes in one file', () => {
    const accounts = parseAccountsFile({
      p: { token: 'one' },
      q: [{ id: 'q-main', fields: { cookie: 'c' } }],
    });
    expect(accounts).toHaveLength(2);
    expect(accounts.map((entry) => entry.provider)).toEqual(['p', 'q']);
  });

  it('refuses a file that is not a mapping of providers', () => {
    for (const bad of [null, [], 'text', 42]) {
      const failure = refusal(() => parseAccountsFile(bad));
      expect(failure.userAction).toMatch(/provider id/);
    }
  });

  it('refuses an account that is not an object', () => {
    expect(refusal(() => parseAccountsFile({ p: ['just-a-token'] })).message).toMatch(/p\[0\]/);
  });

  it('refuses an account with nothing in it', () => {
    // An empty account cannot authenticate; carrying it would produce a confusing 401
    // much later, from the provider, about a credential the user thinks they supplied.
    expect(refusal(() => parseAccountsFile({ p: {} })).message).toMatch(/no credential fields/);
  });

  it('refuses two accounts sharing an id', () => {
    const failure = refusal(() =>
      parseAccountsFile({
        p: [
          { id: 'same', fields: { a: 1 } },
          { id: 'same', fields: { a: 2 } },
        ],
      }),
    );
    expect(failure.message).toMatch(/share the id/);
  });

  it('does not print a credential in any refusal', () => {
    const failure = refusal(() => parseAccountsFile({ p: ['nope'] }));
    expect(`${failure.message} ${failure.userAction}`).not.toContain('nope');
  });
});

function refusal(fn: () => unknown): AccountFileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AccountFileError) return error;
    throw error;
  }
  throw new Error('expected the accounts file to be refused, and it was accepted');
}
