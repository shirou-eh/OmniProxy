import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGatewayHandler, type GatewayOptions } from './server.js';

/**
 * Binding a socket, with one rule enforced in code rather than in documentation.
 *
 * The default is loopback, because the gateway holds someone's logged-in accounts and
 * anything that reaches it can spend them. Binding it to the network is allowed — a
 * shared gateway for a team is exactly the multi-tenant use we said we would help
 * with — but not anonymously: a non-loopback bind without an API key is refused here,
 * not warned about. A warning printed at start-up is read once and then scrolls away,
 * and the consequence of missing it is somebody else's account being emptied.
 */

export interface ServeOptions extends GatewayOptions {
  host?: string;
  port?: number;
}

export interface RunningGateway {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export class ServeError extends Error {
  override readonly name = 'ServeError';
  constructor(
    message: string,
    readonly userAction: string,
  ) {
    super(message);
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export async function serve(options: ServeOptions): Promise<RunningGateway> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8787;

  if (!isLoopback(host) && !options.apiKey) {
    throw new ServeError(
      `refusing to listen on ${host} without an API key`,
      'Anything that can reach this port can spend your accounts. Pass --api-key <secret>, ' +
        'or leave the host at 127.0.0.1.',
    );
  }

  const handler = createGatewayHandler(options);
  const server = createServer((request, response) => {
    // The handler never rejects, but a `void` promise with no catch is a process-level
    // crash waiting for the one case where it does.
    void handler(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  // A web-interface answer can take minutes to arrive. Node's default two-minute
  // request timeout would cut a long reasoning turn off mid-sentence.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 75_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      reject(
        error.code === 'EADDRINUSE'
          ? new ServeError(
              `port ${port} is already in use`,
              'Something else is listening there — another omniproxy, perhaps. Pass --port <n>.',
            )
          : error,
      );
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const boundPort = address.port;
  const displayHost = address.family === 'IPv6' && host === '::1' ? '[::1]' : host;

  return {
    server,
    host,
    port: boundPort,
    url: `http://${displayHost}:${boundPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Idle keep-alive sockets would otherwise hold the process open for another
        // 75 seconds after a Ctrl-C, which reads as a hang.
        server.closeIdleConnections();
      }),
  };
}
