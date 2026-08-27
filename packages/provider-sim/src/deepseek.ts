import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { powWasmBytes } from './pow-wasm.js';

/**
 * A local server that speaks the DeepSeek Web protocol.
 *
 * Its purpose is narrow and worth stating precisely, because overstating it would be
 * the exact failure §12.10 warns about.
 *
 * **What it is for.** Risk R-11: phase 1 has a capture pipeline, a declarative engine
 * and a DeepSeek declaration, and no way to run any of it end to end without asking a
 * user for a HAR of their live session. That is a bad thing to be blocked on, and a
 * worse thing to route around by hand-writing fixtures — a fixture I invent proves
 * only that I am consistent with myself. Recording this simulator produces a bundle
 * from traffic that genuinely crossed a socket: real headers, real chunk boundaries,
 * real SSE framing, real timings. Everything downstream — sanitizer, analyzer, differ,
 * fixture gate, replay — then runs on evidence rather than on my imagination.
 *
 * **Where its authority comes from.** Not from me. Every shape here is taken from
 * `legacy/server.js`, which is a working client that has talked to the real service:
 * the three endpoints, the `data.biz_data.*` envelopes, the PoW header, the json-patch
 * stream with its sticky path. Where legacy does not say, this file does not invent —
 * it either omits the field or marks it.
 *
 * **What it does not prove.** That the live service still behaves this way today. A
 * simulator is faithful to a client, and a client can be out of date. That question is
 * a canary question, answered by `omniproxy probe` against the real host with a real
 * account, and it stays open until someone runs it. This file closes the pipeline
 * risk, not the freshness risk, and the provider's status stays `unverified` because
 * of it.
 */

export interface DeepSeekSimOptions {
  /** Required in the `authorization` header. Any request without it gets 401. */
  token?: string;
  /** Text the assistant answers with, split into fragments as it streams. */
  reply?: string;
  /** Reasoning text emitted before the answer, as THINK fragments. */
  reasoning?: string;
  /** Milliseconds between stream frames. */
  frameDelayMs?: number;
  /** Fail the nth completion request with this status (1-based). */
  failCompletionWith?: { attempt: number; status: number; body?: string };
  /** Answer the completion with a rate-limit envelope instead of a stream. */
  quotaExhausted?: boolean;
  /** Emit the whole answer as one `response/content` stream instead of fragments. */
  contentOnly?: boolean;
  now?: () => number;
}

export interface DeepSeekSim {
  url: string;
  /** Every request the simulator saw, for assertions about what the engine sent. */
  requests: SimRequest[];
  /** Sessions it created, in creation order. */
  sessions: string[];
  close(): Promise<void>;
}

export interface SimRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const WASM_PATH = '/static/pow/sha3_wasm_bg.wasm';
const TARGET_PATH = '/api/v0/chat/completion';

export async function startDeepSeekSim(options: DeepSeekSimOptions = {}): Promise<DeepSeekSim> {
  const token = options.token ?? 'sim-token';
  const reply = options.reply ?? 'Привет! Это ответ симулятора.';
  const reasoning = options.reasoning ?? '';
  const frameDelayMs = options.frameDelayMs ?? 0;
  const now = options.now ?? (() => Date.now());

  const requests: SimRequest[] = [];
  const sessions: string[] = [];
  /** Challenges issued but not yet spent, so a replayed header can be refused. */
  const issued = new Map<string, IssuedChallenge>();
  let completions = 0;

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    requests.push({ method: request.method ?? 'GET', path, headers: request.headers, body });

    if (path === WASM_PATH) {
      response.writeHead(200, { 'content-type': 'application/wasm' });
      response.end(Buffer.from(powWasmBytes()));
      return;
    }

    // Auth first, as the real service does: an expired cookie fails the challenge
    // call, not the completion, and a declaration has to handle it there.
    const authorization = header(request, 'authorization');
    if (authorization !== `Bearer ${token}`) {
      json(response, 401, { code: 40100, msg: 'not logged in' });
      return;
    }

    switch (path) {
      case '/api/v0/chat/create_pow_challenge':
        return createChallenge(response, body);
      case '/api/v0/chat_session/create':
        return createSession(response);
      case TARGET_PATH:
        return completion(request, response, body);
      default:
        json(response, 404, { code: 40400, msg: 'not found' });
    }
  }

  function createChallenge(response: ServerResponse, body: string): void {
    const parsed = safeJson(body);
    if (parsed?.['target_path'] !== TARGET_PATH) {
      // The real service ties a challenge to the path it was minted for. Accepting
      // any target_path would hide a declaration that sends the wrong one.
      json(response, 400, { code: 40001, msg: 'bad target_path' });
      return;
    }

    const salt = randomUUID().replace(/-/g, '').slice(0, 16);
    const nonce = randomUUID().replace(/-/g, '');
    const expireAt = now() + 300_000;
    const challenge: IssuedChallenge = {
      algorithm: 'DeepSeekHashV1',
      challenge: nonce,
      salt,
      difficulty: 144_000,
      expire_at: expireAt,
      // A signature the simulator can check it minted itself.
      signature: createHash('sha256').update(`${nonce}:${salt}:${expireAt}`).digest('hex'),
      target_path: TARGET_PATH,
    };
    issued.set(nonce, challenge);

    json(response, 200, {
      code: 0,
      msg: '',
      data: { biz_code: 0, biz_msg: '', biz_data: { challenge: stripTarget(challenge) } },
    });
  }

  function createSession(response: ServerResponse): void {
    const id = `sim-session-${sessions.length + 1}-${randomUUID().slice(0, 8)}`;
    sessions.push(id);
    json(response, 200, {
      code: 0,
      msg: '',
      data: {
        biz_code: 0,
        biz_msg: '',
        biz_data: {
          id,
          chat_session: { id, seq_id: sessions.length, agent: 'chat', title: null },
        },
      },
    });
  }

  async function completion(
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
  ): Promise<void> {
    completions += 1;

    const failure = options.failCompletionWith;
    if (failure && failure.attempt === completions) {
      response.writeHead(failure.status, { 'content-type': 'application/json' });
      response.end(failure.body ?? JSON.stringify({ code: failure.status, msg: 'simulated' }));
      return;
    }

    const powError = checkPow(header(request, 'x-ds-pow-response'), issued);
    if (powError) {
      json(response, 403, { code: 40300, msg: powError });
      return;
    }

    const parsed = safeJson(body);
    const sessionId = parsed?.['chat_session_id'];
    if (typeof sessionId !== 'string' || !sessions.includes(sessionId)) {
      // 404 on an unknown session is what makes legacy's "session expired, create a
      // new one" path reachable, so the declaration's error rules can be exercised.
      json(response, 404, { code: 40400, msg: 'chat session not found' });
      return;
    }
    if (typeof parsed?.['prompt'] !== 'string' || parsed['prompt'] === '') {
      json(response, 400, { code: 40002, msg: 'prompt is required' });
      return;
    }
    // The first message of a conversation legitimately has no parent, but the field
    // must be present — sending nothing at all is a different request.
    if (!('parent_message_id' in (parsed ?? {}))) {
      json(response, 400, { code: 40003, msg: 'parent_message_id is required' });
      return;
    }

    if (options.quotaExhausted) {
      json(response, 200, { code: 40303, msg: 'Message limit reached', data: null });
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const messageId = 1000 + completions;
    for (const frame of streamFrames(reply, reasoning, messageId, options.contentOnly === true)) {
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
      if (frameDelayMs > 0) await delay(frameDelayMs);
    }
    response.write('data: [DONE]\n\n');
    response.end();
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    sessions,
    close: () => closeServer(server),
  };
}

/** The URL the declaration should point `wasmUrl` at when running against a sim. */
export function simWasmPath(): string {
  return WASM_PATH;
}

/* ────────────────────────────── the protocol details ────────────────────────────── */

interface IssuedChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at: number;
  signature: string;
  target_path: string;
}

function stripTarget(challenge: IssuedChallenge): Omit<IssuedChallenge, 'target_path'> {
  const { target_path: _ignored, ...rest } = challenge;
  return rest;
}

/**
 * Checks the `X-DS-PoW-Response` header the way the real service must: it is base64 of
 * a JSON object echoing the challenge back with an answer.
 *
 * It cannot verify the answer itself — that algorithm lives inside DeepSeek's WASM and
 * is not documented anywhere this project may rely on. What it does verify is every
 * part our code is responsible for: the encoding, the field names, that the challenge
 * was one this server issued, that it has not expired, that it is not being replayed,
 * and that the answer is a positive integer. Those are the mistakes our glue can make.
 */
function checkPow(value: string | undefined, issued: Map<string, IssuedChallenge>): string | null {
  if (!value) return 'missing X-DS-PoW-Response';

  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return 'X-DS-PoW-Response is not base64-encoded JSON';
  }

  const nonce = decoded['challenge'];
  if (typeof nonce !== 'string') return 'no challenge in the PoW response';

  const original = issued.get(nonce);
  if (!original) return 'unknown or already used challenge';
  if (decoded['salt'] !== original.salt) return 'salt does not match the challenge';
  if (decoded['signature'] !== original.signature) return 'signature does not match';
  if (decoded['algorithm'] !== original.algorithm) return 'unexpected algorithm';
  if (decoded['target_path'] !== original.target_path) return 'target_path does not match';

  const answer = decoded['answer'];
  if (typeof answer !== 'number' || !Number.isFinite(answer) || answer <= 0) {
    return 'answer must be a positive number';
  }

  // Single use, like the real thing: a declaration that caches the header across
  // requests would otherwise pass here and fail in production.
  issued.delete(nonce);
  return null;
}

/**
 * The json-patch stream, in the shapes `legacy/server.js` parses.
 *
 * Three of them, because all three occur: fragments appended one at a time, content
 * appended to the last fragment via the sticky path, and the whole-response form. The
 * golden parity test in the engine covers the same shapes from the reading side.
 */
function streamFrames(
  reply: string,
  reasoning: string,
  messageId: number,
  contentOnly: boolean,
): unknown[] {
  const frames: unknown[] = [{ response_message_id: messageId }];

  if (contentOnly) {
    frames.push({ p: 'response/content', v: '' });
    for (const piece of chunk(reply)) frames.push({ v: piece });
    frames.push({ p: 'response/finish_reason', v: 'stop' });
    frames.push({ p: 'response/status', v: 'FINISHED' });
    return frames;
  }

  if (reasoning !== '') {
    frames.push({ p: 'response/fragments', o: 'APPEND', v: { type: 'THINK', content: '' } });
    frames.push({ p: 'response/fragments/-1/content', v: chunk(reasoning)[0] ?? '' });
    for (const piece of chunk(reasoning).slice(1)) frames.push({ v: piece });
  }

  frames.push({ p: 'response/fragments', o: 'APPEND', v: { type: 'RESPONSE', content: '' } });
  const pieces = chunk(reply);
  frames.push({ p: 'response/fragments/-1/content', v: pieces[0] ?? '' });
  // No `p` from here on: the sticky path is how the real stream saves bytes, and a
  // simulator that repeated the path on every frame would let a parser that ignores
  // stickiness pass — which is the one bug worth catching here.
  for (const piece of pieces.slice(1)) frames.push({ v: piece });

  frames.push({ p: 'response/finish_reason', v: 'stop' });
  frames.push({ p: 'response/status', v: 'FINISHED' });
  return frames;
}

/** Splits into small pieces on character boundaries, including astral ones. */
function chunk(text: string, size = 4): string[] {
  const characters = [...text];
  const pieces: string[] = [];
  for (let index = 0; index < characters.length; index += size) {
    pieces.push(characters.slice(index, index + size).join(''));
  }
  return pieces.length > 0 ? pieces : [''];
}

/* ──────────────────────────────────── plumbing ──────────────────────────────────── */

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const piece of request) chunks.push(piece as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // closeAllConnections exists on Node 18.2+; without it a keep-alive socket from an
    // abandoned stream holds the test process open until its idle timeout.
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
