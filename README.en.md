![OmniProxy — Universal Gateway — Purple Rocket Banner](assets/banner.svg)

<p align="center">
<a href="README.md">Русский</a> · <strong>English</strong> · <a href="README.zh.md">中文</a> · <a href="CHANGELOG.md">Changelog</a> · <a href="LICENSE">MIT</a><br/>
<strong>OmniProxy</strong> — universal gateway for provider web interfaces
</p>

<p align="center">
<img src="https://img.shields.io/badge/version-0.1.4-purple?style=flat-square" alt="version"/>
<img src="https://img.shields.io/badge/tests-885-7C4DFF?style=flat-square" alt="tests"/>
<img src="https://img.shields.io/badge/node-%3E%3D22-4A1D96?style=flat-square" alt="node"/>
<img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-9C27B0?style=flat-square" alt="platform"/>
<img src="https://img.shields.io/badge/coverage-844%20vitest%20%2B%2041%20legacy-E1BEE7?style=flat-square" alt="coverage"/>
<img src="https://img.shields.io/badge/license-MIT-E1BEE7?style=flat-square" alt="license"/>
</p>

# OmniProxy — Universal Gateway

**OmniProxy** puts a **standard API** (OpenAI / Anthropic / Gemini / Ollama-compatible) in front of provider **web interfaces** — the same endpoints your logged-in browser talks to. No paid APIs, no vendor lock-in, your accounts, your gateway. All modalities: text, images, video, audio, music, speech, 3D via `provider.yaml`.

> **Status: `v0.1.4` — gateway runs.** `omniproxy serve` answers OpenAI, Anthropic, Gemini and Ollama over any provider module — with account pool, streaming, concurrency gate and honest `unverified`. **No provider has been verified against its live service**: all declarations are `unverified` and run only against a protocol-faithful local simulator (`packages/provider-sim` with real `sha3_wasm_bg`). `legacy/` is a **minimal example** of the original proxy (41 tests), not the core — see `legacy/README.md` if you need it.

---

## Table of Contents

- [Architecture in 30 seconds](#architecture-in-30-seconds)
- [Quick start — set and forget](#quick-start--set-and-forget)
- [Auth — where tokens live](#auth--where-tokens-live)
- [Providers — your own without a fork](#providers--your-own-without-a-fork)
- [Capture pipeline — from traffic to declaration](#capture-pipeline--from-traffic-to-declaration)
- [Dialects — the fifth protocol is a file](#dialects--the-fifth-protocol-is-a-file)
- [Doctor — no secrets leaked](#doctor--no-secrets-leaked)
- [Gateway endpoints](#gateway-endpoints)
- [Documentation — where next](#documentation--where-next)
- [Development — build and test](#development--build-and-test)
- [Deployment — Docker and systemd](#deployment--docker-and-systemd)
- [Security and permissions](#security-and-permissions)
- [Legal & ToS](#legal--tos)
- [History and principles](#history-and-principles)

---

## Architecture in 30 seconds

```
any SDK → dialect (OpenAI/Anthropic/Gemini/Ollama/yours) → UMR (universal request)
                                                                        ↓
provider.yaml → engine (flow, JSONPath, transforms) → HTTP → provider web interface
                                                                        ↓
                                                                   UMS (event stream)
                                                                        ↓
                                                              dialect → SDK response
```

- **UMR** (`packages/umr`): `flattenConversation` — one prompt byte-for-byte, text-emulated `tool_call` parser.
- **UMS** (`packages/schema`): events `start`/`delta`/`warning`/`error`, collected only from them.
- **Engine** (`packages/engine-declarative`): `{{ }}` (`?`/`null-if-empty`), JSONPath, transforms (`deepseek-pow-v0`, `uuid-v4`…), framing `sse`/`ndjson`/`json-patch`.
- **Gateway** (`packages/gateway`): routing `alias` → `provider`, pool `1..N` (ADR-0004, no `if (len===1)`), `ConcurrencyGate` per `account+channel`, commit boundary (retry only before first `content`).
- **Transport** (`packages/transport`): `fetchHttpClient` / `recording` / `replay`, `allowedHosts` before request, `bodyEncoding: base64` for binary.
- **Discovery** (`discovery.ts`): `--provider-dir` > `$OMNIPROXY_PROVIDER_PATH` (`:`/`;`) > `~/.omniproxy/providers/` > `providers/` in repo (fallback via CLI location — works from `/tmp` and Docker), first found wins.
- **Principles:** no `if (provider===…)` in `core/gateway` (§12.3), request state lives **one request** (ADR-0008, R-6 closed), secrets never in `git`/logs/`/health` (§12.7), never invent endpoints (§12.1).

---

## Quick start — set and forget

### Option A — Docker (one command, restarts on failure, 0600 volume)

```bash
# 1) credential once (prompts for token if you omit --field, TTY)
docker run --rm -v omniproxy_data:/home/omniproxy/.omniproxy omniproxy:0.1.4 \
  node apps/cli/dist/main.js auth add deepseek-web --field token=YOUR_TOKEN
# where it lives / how to delete:
docker run --rm -v omniproxy_data:/home/omniproxy/.omniproxy omniproxy:0.1.4 \
  node apps/cli/dist/main.js auth path   # → /home/omniproxy/.omniproxy/accounts.json
# docker volume rm omniproxy_data  — or: auth remove deepseek-web

# 2) run (healthcheck on /health, restart unless-stopped)
docker compose up -d && docker compose logs -f
# http://127.0.0.1:8787/health → {"status":"ok"}

# without compose:
docker build -f Containerfile -t omniproxy:0.1.4 . && \
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -v omniproxy_data:/home/omniproxy/.omniproxy \
  -e OMNIPROXY_API_KEY=long_random_if_you_need_0.0.0.0 \
  omniproxy:0.1.4
```

### Option B — pnpm from source (Windows and Linux are first-class)

```bash
git clone https://github.com/shirou-eh/OmniProxy.git && cd OmniProxy
pnpm install --frozen-lockfile   # pnpm 11.24, node >=22 (see package.json:engines)
pnpm run build                   # tsc, turbo

# 1) credential (0600 file at ~/.omniproxy/accounts.json)
node apps/cli/dist/main.js auth add deepseek-web --field token=...
# without --field in TTY prompts interactively; pool: second --id work
node apps/cli/dist/main.js auth add qwen-web --id work --field token=...
node apps/cli/dist/main.js auth list          # names of fields only, never values
node apps/cli/dist/main.js auth list --json | jq
node apps/cli/dist/main.js auth path          # where it lives

# 2) gateway (loopback by default; 0.0.0.0 without --api-key is refused)
node apps/cli/dist/main.js serve --port 8787
# env also works: HOST=0.0.0.0 PORT=8787 OMNIPROXY_API_KEY=secret node ... serve
# --dialect ./my.mjs --provider deepseek-web --provider-dir ./my/providers --env K=V

# 3) any SDK — same prompt byte-for-byte (test asserts it)
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 OPENAI_API_KEY=unused \
  curl http://127.0.0.1:8787/v1/chat/completions -H content-type:application/json \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'

ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=unused \
  curl http://127.0.0.1:8787/v1/messages -H content-type:application/json -H anthropic-version:2023-06-01 \
  -d '{"model":"deepseek-chat","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'

GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787 GEMINI_API_KEY=unused \
  curl http://127.0.0.1:8787/v1beta/models/deepseek-chat:generateContent -H content-type:application/json \
  -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'

OLLAMA_HOST=http://127.0.0.1:8787 curl http://127.0.0.1:8787/api/chat -H content-type:application/json \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":false}'

# 4) what is available and diagnose (no secrets)
curl http://127.0.0.1:8787/v1/models          # OpenAI-compatible list of all aliases
curl http://127.0.0.1:8787/v1/capabilities    # what this gateway really can do per provider
curl http://127.0.0.1:8787/health            # dialects in mount order, providers, accounts (field names), inFlight
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js doctor --anonymized  # without absolute paths for bug reports
```

Key is accepted as `Authorization: Bearer` / `x-api-key` / `x-goog-api-key` / `?key=` — whichever your client sends. `GET /health|/v1/models|/v1/capabilities` need no key. Default port `8787`.

---

## Auth — where tokens live

```
~/.omniproxy/accounts.json  (or $OMNIPROXY_HOME/accounts.json)
  dir 0700, file 0600 (owner-only; Windows ACL; future DPAPI/libsecret)
  never committed (.gitignore: accounts*.json, *.raw.json, *.har)
  format:
    { "deepseek-web": {"token":"…"} }
    { "qwen-web": [{"id":"work","fields":{"token":"…"}},{"id":"personal","fields":{"token":"…"}}] }
```

- `auth add deepseek-web --field token=...` — one account as plain object.
- Second `auth add deepseek-web --id work --field token=...` — promotes to pool `[{id,fields},{id,fields}]`.
- Duplicate `id` — refused with hint.
- `auth list` — `provider  id  fields: token, cookie` and `store: /path`; `--json` → `[{provider,id,fields[]}]` (no values, §12.7).
- `auth remove deepseek-web` — whole provider; ` --id work` — one of pool.
- `auth path` — path. Delete: `rm ~/.omniproxy/accounts.json` (or `$OMNIPROXY_HOME`).
- `serve` reads the same path; `--accounts <file>` — one-off file; if file is `044` (group/other readable) — `warning: chmod 600`.
- Without `--field` in TTY — interactive `token:` prompt.

---

## Providers — your own without a fork

```bash
omniproxy provider list --json                    # id, origin flag/env/home/repo, dir, status, warnings
omniproxy provider validate deepseek-web          # Zod + transform/fixture links, errors vs warnings
omniproxy provider validate --provider-dir ./my   # yours next to ours, yours win
```

**Search order** (first wins, ADR-0003): `--provider-dir` > `$OMNIPROXY_PROVIDER_PATH` (delimiter `path.delimiter`, `:`/`;`) > `~/.omniproxy/providers/` > `providers/` in repo (fallback via CLI location — works from `/tmp` and Docker). Broken declaration of one provider never takes the others down (I-1).

Your module — folder `~/.omniproxy/providers/<id>/provider.yaml` (+ `fixtures/` + optionally `adapter.ts` per ADR-0002 level 3). Copy `providers/deepseek-web/provider.yaml` as template.

**Complexity classes** (§7, `02-provider-yaml.md`): `A` (cookie+PoW) … `G` (video) — `deepseek-web` class `A`.

---

## Capture pipeline — from traffic to declaration

Declaration is written **only** from recorded traffic (§12.1, §12.5 — no `TODO later`).

```bash
omniproxy capture record deepseek-web --auth ./auth.json --prompt "hi" --model deepseek-chat
# → raw bundle in ~/.omniproxy/tmp/ (TTL 1h, 0600, UNSANITIZED, with live cookies)

omniproxy capture import <file.har> --provider my-cool --scenario chat --out ./tmp
# HAR 1.2 from DevTools, header order preserved, SSE → frames, base64

omniproxy capture sanitize <bundle> --out ./san.json
# stable {{redacted:kind:n}} (one token → one placeholder), idempotent,
# cookie/Set-Cookie/Bearer structure preserved, re-check of finished file

omniproxy capture analyze <bundle> --compare <other> [--json]
# classification with "why" (preflight/telemetry/static/SSE/session…), graph "value from response A in request B",
# volatileFields (what varies between runs → will become {{ }})

omniproxy provider draft <bundle> --out ./provider.yaml
# draft: only what was in the recording; where recording is silent — '# TODO(capture): …', never a guess
# status always needs-capture — only a human may raise it
```

Engine (`engine-declarative`): `{{req.prompt}}` / `{{state.sessionId}}` / `{{state.parentMessageId?}}` / `{{state.x|null-if-empty}}` / `{{vars.pow}}` / `{{env.K}}`, JSONPath `$.a.b[0]`, `regex:`, `header:`, transforms `uuid-v4`, `hmac-sha256`, `deepseek-pow-v0` (real `wasm`), framing `sse`/`ndjson`/`json-patch`.

Simulator (`provider-sim`): local server speaking as `legacy/server.js`, with real `sha3_wasm_bg` — 23 end-to-end `transport` tests catch drift before prod.

---

## Dialects — the fifth protocol is a file

Four built-ins are ordinary `DialectPlugin`s, mounted the same way as yours. No privileged path.

```ts
export default {
  name: "plain",
  dialect: { name:"plain", plan(body,providers){...}, identity(uuid){...}, async respond({events,response,settle}){...}, error(e){...}, refuse(status,kind,msg,action){...} },
  paths: ["/say"],
  match: (path,method)=> method==="POST"&&path==="/say" ? {} : undefined,
  side: (req)=> req.path==="/say/models" ? {status:200,body:{can:[...]}} : undefined
}
```

```bash
omniproxy serve --dialect ./my.mjs                 # file
omniproxy serve --dialect ./dialects/              # dir, sorted, deterministic (ADR-0005)
# export may be default / dialect / plugin
# --dialect executes чужой JS with your accounts — one warning at start, then does what you asked
```

`body` is read once and shared between `side` and the request loop; `side` never spends an account. Full example in [`07-writing-a-dialect.md`](docs/omniproxy/07-writing-a-dialect.md) — ~40 lines.

---

## Doctor — no secrets leaked

```bash
omniproxy doctor                 # human: node/platform/cwd, providers, auth store
omniproxy doctor --json          # machine
omniproxy doctor --anonymized    # for issues, without absolute paths
```

Checks: `node >=22`, `providers` (shadowing, `BROKEN` with reason), `auth store` (`exists`, `mode`, `validJson`, `accounts`, `warning: chmod 600`), hints `auth add`. Secrets — only `fields[]` (names), never values (§12.7, test on `health`).

---

## Gateway endpoints

| Method | Path | What |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (SSE `text/event-stream` and JSON) |
| `POST` | `/v1/messages` | Anthropic Messages (`system` as field, numbered blocks) |
| `POST` | `/v1beta/models/<m>:generateContent` | Gemini (`:streamGenerateContent` too, `safetyRatings:[]`, `countTokens` as `estimated:true`) |
| `POST` | `/api/chat` | Ollama Chat (NDJSON, `stream` defaults `true`) |
| `POST` | `/api/generate` | Ollama Generate (`response` instead of `message`) |
| `GET` | `/v1/models` | All aliases, `qualified` and `bare` (superset OpenAI+Anthropic) |
| `GET` | `/v1beta/models` | Gemini form (`models/deepseek-chat`) |
| `GET` | `/api/tags` | Ollama tags (`size:0,digest:""` honestly, no file) |
| `POST` | `/api/show` | Ollama show (`omniproxy.status` as declared, no `context length`) |
| `GET` | `/api/version` | `0.1.4-omniproxy`, not Ollama's version |
| `GET` | `/v1/capabilities` | What this gateway really can do per provider (no guesses `§12.10`) |
| `GET` | `/health`, `/healthz` | `dialects` in mount order, `providers` (`unverified` stays), `accounts` (field names), `inFlight` |
| — | `/nope` | `404` with `This build serves …, /v1/models, /v1/capabilities and /health.` |

`OPTIONS` → `204` CORS (only `localhost`/`127.0.0.1`/`::1`, wildcard forbidden — otherwise any page would spend your accounts).

---

## Documentation — where next

| Doc | What it settles |
|---|---|
| `docs/en/*`, `docs/ru/*`, `docs/zh/*` | Trilingual docs (soon) |
| `docs/omniproxy/00-risks.md` | What can fail, honestly |
| `01-monorepo.md` | Current layout (what exists today is marked [+]) vs vision |
| `02-provider-yaml.md` | Declaration format (`unverified` etc.) |
| `05-reliability-charter.md` | 10 invariants, each with a test |
| `06-hackability-charter.md` | Your right to rewire |
| `07-writing-a-dialect.md` | Add a protocol without a fork |
| `docs/omniproxy/adr/` | Decisions (0001…0008) |
| `docs/providers/deepseek-web.md` | Provider dossier, how to verify live |

Two principles: **Reliability over speed** — a broken provider never takes the gateway down; **You are in charge** — user dirs shadow ours, open formats, no telemetry.

---

## Development

```bash
pnpm install
pnpm run build && pnpm run typecheck && pnpm exec turbo run test --force  # 885 = 844 vitest +41 legacy
pnpm run legacy:test
pnpm exec turbo telemetry disable   # if you want
```

Windows and Linux are first-class (ADR-0005).

---

## Deployment — Docker and systemd

**Docker Compose (recommended, set-and-forget):**

```yaml
# docker-compose.yml already in repo
services:
  omniproxy:
    build: { context: ., dockerfile: Containerfile }
    restart: unless-stopped
    ports: ["127.0.0.1:8787:8787"]
    environment: { HOST: "0.0.0.0", PORT: "8787" }
    volumes: ["omniproxy_data:/home/omniproxy/.omniproxy"]
    healthcheck: { test: ["CMD","node","-e",".../health..."], interval: 30s }
volumes: { omniproxy_data: {} }
```

```bash
docker compose up -d && docker compose logs -f
# 0.0.0.0 inside container, 127.0.0.1 on host; without OMNIPROXY_API_KEY external bind is refused
```

**Without compose:**

```bash
docker build -f Containerfile -t omniproxy:0.1.4 .
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 -v omniproxy_data:/home/omniproxy/.omniproxy omniproxy:0.1.4
```

**systemd (Linux, bare-metal):**

```ini
# /etc/systemd/system/omniproxy.service
[Unit] Description=OmniProxy gateway / After=network.target
[Service] User=omniproxy / WorkingDirectory=/opt/OmniProxy
ExecStart=/usr/bin/node /opt/OmniProxy/apps/cli/dist/main.js serve --port 8787
Restart=always / Environment=NODE_ENV=production
[Install] WantedBy=multi-user.target
```

---

## Security and permissions

- Sanitizer is blocking (§8.4): `*.raw.json`/`*.har`/`accounts.json` in `.gitignore`, `secrets-scan` in CI, `writeFixture` re-checks finished file.
- `serve` outside `127.0.0.1` without `--api-key` is **refused**; key compared `timingSafeEqual`; `HOST`/`PORT` from env (`HOST`/`PORT`/`OMNIPROXY_HOME` fallback); CORS only `localhost`/`127.0.0.1`/`::1`.
- Accounts: `0700` dir, `0600` file, `doctor`/`serve` warn if `044`; delete: `rm …/accounts.json` or `auth remove`.
- `legacy/chrome-extension` — MV3, only `cookies`/`storage`/`downloads`, `chrome.debugger` for CDP, yellow bar — honest.

---

## Legal & ToS

OmniProxy drives provider web interfaces with **your own** sessions. This violates most ToSes — **accounts can be banned**. Use only accounts you own and can risk. No bulk registration, no credential sharing, no paid-limit bypass. MIT, no telemetry, no hosted component. See `LICENSE`, `docs/legal`.

---

## History and principles

Journal per PR in `docs/omniproxy/04-phase-1-plan.md` (honestly, what the test found) and `CHANGELOG.md`. Tag `baseline-v0.1.0`, simulators instead of invented fixtures (ADR-0007), sessions live **one request** (ADR-0008, R-6 closed), `ConcurrencyGate` per `account+channel`.

Goals: `gateway availability` with dead providers `100%` (errors with `userAction`), `errors_without_user_action` `0`, `lost jobs` `0`, `MTTR "schema changed"` `<30m` (edit `yaml`), `overhead p95` `<15ms`, run without optional deps — mandatory (I-10).

---

<p align="center"><sub>Purple rocket — MD3 Expressive · <code>assets/banner.svg</code> · <code>assets/avatar.svg</code> · shirou-eh/OmniProxy</sub></p>
