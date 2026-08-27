import { describe, expect, it } from 'vitest';
import { ConcurrencyGate, gateKey, GateRefused, type Release } from '../src/gate.js';

/**
 * `channels[].concurrency` has been in the schema and in the documented format from the
 * start, described as "concurrent requests per account", and nothing enforced it until
 * this gate existed. A declared limit nobody applies is a declaration that lies (§12.5),
 * and the consequence is concrete: a web chat expecting one request at a time, given
 * three, answers one of them wrongly or has the account banned.
 *
 * A manual scheduler is used throughout so nothing here sleeps and nothing is flaky.
 */

function fakeClock(): {
  now: () => number;
  advance: (ms: number) => void;
  schedule: (fn: () => void, ms: number) => { cancel(): void };
  pending: number;
} {
  let current = 0;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];

  return {
    now: () => current,
    schedule(fn, ms) {
      const timer = { at: current + ms, fn, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    advance(ms) {
      current += ms;
      for (const timer of [...timers]) {
        if (!timer.cancelled && timer.at <= current) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
    get pending() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
}

const KEY = 'p web acct';

/** Lets every already-queued microtask run, without waiting on real time. */
const settle = async (): Promise<void> => {
  for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
};

describe('ConcurrencyGate', () => {
  it('lets a request through when there is room', async () => {
    const gate = new ConcurrencyGate();
    const release = await gate.acquire(KEY, 1);
    expect(gate.inFlight(KEY)).toBe(1);
    release();
    expect(gate.inFlight(KEY)).toBe(0);
  });

  it('holds the second request until the first gives its slot back', async () => {
    const gate = new ConcurrencyGate();
    const first = await gate.acquire(KEY, 1);

    let secondArrived = false;
    const second = gate.acquire(KEY, 1).then((release) => {
      secondArrived = true;
      return release;
    });

    await settle();
    expect(secondArrived).toBe(false);
    expect(gate.queued(KEY)).toBe(1);

    first();
    (await second)();
    expect(secondArrived).toBe(true);
    expect(gate.inFlight(KEY)).toBe(0);
  });

  it('runs a declared limit of three, three at a time and no more', async () => {
    const gate = new ConcurrencyGate();
    const held: Release[] = [];
    for (let n = 0; n < 3; n += 1) held.push(await gate.acquire(KEY, 3));

    expect(gate.inFlight(KEY)).toBe(3);

    let fourthArrived = false;
    const fourth = gate.acquire(KEY, 3).then((release) => {
      fourthArrived = true;
      return release;
    });
    await settle();
    expect(fourthArrived).toBe(false);

    held[0]?.();
    (await fourth)();
    expect(fourthArrived).toBe(true);
    held[1]?.();
    held[2]?.();
  });

  it('keeps accounts of the same provider independent', async () => {
    // The whole reason a pool is worth having: two accounts each allowed one request
    // run two requests.
    const gate = new ConcurrencyGate();
    const a = await gate.acquire(gateKey('p', 'web', 'a'), 1);
    const b = await gate.acquire(gateKey('p', 'web', 'b'), 1);

    expect(gate.inFlight(gateKey('p', 'web', 'a'))).toBe(1);
    expect(gate.inFlight(gateKey('p', 'web', 'b'))).toBe(1);
    a();
    b();
  });

  it('hands the slot straight to whoever is next, in order', async () => {
    // Freeing the slot and letting everyone race for it would let a fresh arrival jump
    // a queue it never joined.
    const gate = new ConcurrencyGate();
    const first = await gate.acquire(KEY, 1);

    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      gate.acquire(KEY, 1).then((release) => {
        order.push(n);
        return release;
      }),
    );

    first();
    for (const waiter of waiters) (await waiter)();
    expect(order).toEqual([1, 2, 3]);
  });

  it('treats a double release as one', async () => {
    // Two releases would hand out a slot that does not exist, and the resulting
    // over-subscription would only show up as the provider complaining.
    const gate = new ConcurrencyGate();
    const first = await gate.acquire(KEY, 1);
    const queued = gate.acquire(KEY, 1);

    await settle();
    first();
    first();
    first();

    const second = await queued;
    // Exactly one request is running: the extra releases handed out nothing.
    expect(gate.inFlight(KEY)).toBe(1);
    expect(gate.queued(KEY)).toBe(0);

    second();
    second();
    expect(gate.inFlight(KEY)).toBe(0);
  });

  it('forgets a key once nothing is using it', async () => {
    const gate = new ConcurrencyGate();
    const release = await gate.acquire(KEY, 1);
    expect(gate.snapshot()).toHaveLength(1);
    release();
    expect(gate.snapshot()).toEqual([]);
  });

  it('reports what is running and waiting', async () => {
    const gate = new ConcurrencyGate();
    const release = await gate.acquire(KEY, 1);
    const queued = gate.acquire(KEY, 1);
    void queued.catch(() => {});
    await settle();

    expect(gate.snapshot()).toEqual([{ key: KEY, limit: 1, inFlight: 1, queued: 1 }]);
    release();
    (await queued)();
  });

  it('takes the newest limit, so an edited declaration takes effect', async () => {
    const gate = new ConcurrencyGate();
    const first = await gate.acquire(KEY, 1);
    // Reloaded with a higher limit: the second request no longer waits.
    const second = await gate.acquire(KEY, 2);
    expect(gate.inFlight(KEY)).toBe(2);
    first();
    second();
  });

  it('treats a nonsensical limit as one rather than as none', async () => {
    // A limit of 0 read literally would block every request forever. One is the only
    // reading that keeps the gateway working.
    const gate = new ConcurrencyGate();
    const release = await gate.acquire(KEY, 0);
    expect(gate.inFlight(KEY)).toBe(1);
    release();
  });
});

describe('ConcurrencyGate refusals', () => {
  it('refuses rather than growing a queue without limit', async () => {
    // An unbounded queue turns a provider slowdown into a memory problem.
    const gate = new ConcurrencyGate({ maxQueue: 2 });
    const first = await gate.acquire(KEY, 1);
    const waiting = [gate.acquire(KEY, 1), gate.acquire(KEY, 1)];
    waiting.forEach((promise) => void promise.catch(() => {}));
    await settle();

    const refused = await refusal(gate.acquire(KEY, 1));
    expect(refused.reason).toBe('queue-full');
    expect(refused.message).toMatch(/2 requests are already waiting/);
    expect(refused.userAction).toMatch(/Add another account/);

    first();
    for (const promise of waiting) (await promise)();
  });

  it('gives up on a wait that is not going to end, and says how long it waited', async () => {
    const clock = fakeClock();
    const gate = new ConcurrencyGate({
      queueTimeoutMs: 30_000,
      now: clock.now,
      schedule: clock.schedule,
    });

    const first = await gate.acquire(KEY, 1);
    const waiting = gate.acquire(KEY, 1);
    void waiting.catch(() => {});

    clock.advance(30_000);
    const refused = await refusal(waiting);
    expect(refused.reason).toBe('timed-out');
    expect(refused.waitedMs).toBe(30_000);
    expect(refused.message).toMatch(/waited 30s/);

    // And the abandoned waiter is gone, not left holding a place in the queue.
    expect(gate.queued(KEY)).toBe(0);
    first();
    expect(gate.inFlight(KEY)).toBe(0);
  });

  it('cancels the deadline once the slot arrives', async () => {
    const clock = fakeClock();
    const gate = new ConcurrencyGate({
      queueTimeoutMs: 30_000,
      now: clock.now,
      schedule: clock.schedule,
    });

    const first = await gate.acquire(KEY, 1);
    const waiting = gate.acquire(KEY, 1);
    await settle();
    expect(clock.pending).toBe(1);

    first();
    const second = await waiting;
    expect(clock.pending).toBe(0);

    // The deadline firing late must not reject a request that already got its slot.
    clock.advance(60_000);
    second();
    expect(gate.inFlight(KEY)).toBe(0);
  });
});

describe('gateKey', () => {
  it('separates provider, channel and account', () => {
    expect(gateKey('p', 'web', 'a')).not.toBe(gateKey('p', 'web', 'b'));
    expect(gateKey('p', 'web', 'a')).not.toBe(gateKey('p', 'browser', 'a'));
    expect(gateKey('p', 'web', 'a')).not.toBe(gateKey('q', 'web', 'a'));
  });

  it('gives a provider that needs no account a key of its own', () => {
    // Its channel limit is honoured too — everyone simply shares the one key.
    expect(gateKey('p', 'web', undefined)).toBe(gateKey('p', 'web', undefined));
    expect(gateKey('p', 'web', undefined)).not.toBe(gateKey('p', 'web', 'a'));
  });
});

async function refusal(promise: Promise<unknown>): Promise<GateRefused> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GateRefused) return error;
    throw error;
  }
  throw new Error('expected the gate to refuse, and it let the request through');
}
