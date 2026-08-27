import { AccountPool } from '../src/accounts.js';
import { isLoopback, serve, ServeError, type RunningGateway } from '../src/serve.js';
import type { HttpClient } from '@omniproxy/engine-declarative';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The socket itself.
 *
 * The one rule worth a test here is the refusal: the gateway holds someone's
 * logged-in accounts, and a wide-open bind is not a thing to warn about in a line of
 * start-up output that scrolls away. It is a thing to refuse.
 */

const unusable: HttpClient = {
  request: () => {
    throw new Error('no provider should be reached in these tests');
  },
  stream: () => {
    throw new Error('no provider should be reached in these tests');
  },
};

const base = { providers: [], accounts: new AccountPool(), http: unusable };

let running: RunningGateway | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('serve', () => {
  it('listens on loopback by default', async () => {
    running = await serve({ ...base, port: 0 });
    expect(running.host).toBe('127.0.0.1');
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${running.url}/health`)).status).toBe(200);
  });

  it('refuses a public bind with no API key', async () => {
    // Anything that can reach the port can spend the user's accounts. A warning here
    // is read once and then scrolls away; the consequence is somebody else's account.
    const failure = await refusal(serve({ ...base, host: '0.0.0.0', port: 0 }));
    expect(failure.message).toMatch(/refusing to listen on 0\.0\.0\.0/);
    expect(failure.userAction).toMatch(/--api-key/);
  });

  it('allows a public bind once a key guards it', async () => {
    // Users are not blocked from running a shared gateway — they are asked to lock it.
    running = await serve({ ...base, host: '0.0.0.0', port: 0, apiKey: 'shared-secret' });
    expect(running.port).toBeGreaterThan(0);
  });

  it('names the port when it is already taken', async () => {
    running = await serve({ ...base, port: 0 });
    const failure = await refusal(serve({ ...base, port: running.port }));
    expect(failure.message).toMatch(new RegExp(`port ${running.port} is already in use`));
    expect(failure.userAction).toMatch(/--port/);
  });

  it('closes without waiting out an idle keep-alive', async () => {
    // Node holds keep-alive sockets for 75s. Waiting for that after a Ctrl-C reads as
    // a hang, and people kill -9 instead, which is how state gets corrupted.
    running = await serve({ ...base, port: 0 });
    await fetch(`${running.url}/health`);

    const started = Date.now();
    await running.close();
    running = undefined;
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('knows which hosts are loopback', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      expect(isLoopback(host), host).toBe(true);
    }
    for (const host of ['0.0.0.0', '192.168.1.10', 'example.test', '']) {
      expect(isLoopback(host), host).toBe(false);
    }
  });
});

async function refusal(promise: Promise<RunningGateway>): Promise<ServeError> {
  try {
    const started = await promise;
    await started.close();
  } catch (error) {
    if (error instanceof ServeError) return error;
    throw error;
  }
  throw new Error('expected serve to refuse, and it started');
}
