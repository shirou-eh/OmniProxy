![OmniProxy — Universal Gateway — Purple Rocket Banner](assets/banner.svg)

<p align="center">
<strong>Русский</strong> · <a href="README.en.md">English</a> · <a href="README.zh.md">中文</a> · <a href="CHANGELOG.md">Changelog</a> · <a href="LICENSE">MIT</a><br/>
<strong>OmniProxy</strong> — универсальный шлюз для веб-интерфейсов провайдеров
</p>

<p align="center">
<img src="https://img.shields.io/badge/version-0.1.4-purple?style=flat-square" alt="version"/>
<img src="https://img.shields.io/badge/tests-885-7C4DFF?style=flat-square" alt="tests"/>
<img src="https://img.shields.io/badge/node-%3E%3D22-4A1D96?style=flat-square" alt="node"/>
<img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux-9C27B0?style=flat-square" alt="platform"/>
<img src="https://img.shields.io/badge/license-MIT-E1BEE7?style=flat-square" alt="license"/>
</p>

---

## English

### What is OmniProxy?

OmniProxy puts a **standard API** (OpenAI / Anthropic / Gemini / Ollama-compatible) in front of provider **web interfaces** — the same endpoints your logged-in browser talks to. No paid APIs, no vendor lock-in, your accounts, your gateway.

- **One server, four protocols** — `POST /v1/chat/completions` (OpenAI), `POST /v1/messages` (Anthropic), `POST /v1beta/models/...:generateContent` (Gemini), `POST /api/chat|/api/generate` (Ollama NDJSON). Streaming and non-streaming, same prompt byte-for-byte whichever SDK you use.
- **1 → N accounts** — one account is the degenerate case, not a special case. Requests move to the next account only before the provider starts answering (commit boundary), never after.
- **A fifth protocol is a file** — `DialectPlugin` (`name`, `dialect`, `match`, `side`, `paths`). Your `.mjs` is mounted *before* the built-ins, so it can even replace one. See [`07-writing-a-dialect.md`](docs/omniproxy/07-writing-a-dialect.md).
- **Honest about readiness** — every declaration is `unverified` until someone records live traffic; `/health` prints status as declared, never invents `size`/`contextChars`.

> **Status:** `v0.1.4` — gateway runs, 885 tests green (Windows/Linux, Node 22/24). `providers/deepseek-web` is `unverified` (derived from a working client, executed only against a local simulator). `legacy/` is a **minimal example** of the original proxy, not the core — see [`legacy/README.md`](legacy/README.md) if you need it.

### Quick start — set and forget

**Option A — Docker (one command, restarts on failure):**

```bash
# 1) store a credential once (prompts for token if you omit --field)
docker run --rm -v omniproxy_data:/home/omniproxy/.omniproxy omniproxy:0.1.4 \
  node apps/cli/dist/main.js auth add deepseek-web --field token=YOUR_TOKEN
# where it lives / how to delete:
docker run --rm -v omniproxy_data:/home/omniproxy/.omniproxy omniproxy:0.1.4 \
  node apps/cli/dist/main.js auth path   # → /home/omniproxy/.omniproxy/accounts.json
# rm volume: docker volume rm omniproxy_data

# 2) run
docker compose up -d && docker compose logs -f
# open http://127.0.0.1:8787/health  →  {status:"ok"}
```

**Option B — pnpm (from source):**

```bash
git clone https://github.com/shirou-eh/OmniProxy.git && cd OmniProxy
pnpm install --frozen-lockfile && pnpm run build

# 1) credential (0600 file at ~/.omniproxy/accounts.json)
node apps/cli/dist/main.js auth add deepseek-web --field token=...
node apps/cli/dist/main.js auth list          # names of fields only, never values
node apps/cli/dist/main.js auth path          # where it lives

# 2) serve (loopback by default; 0.0.0.0 needs --api-key)
node apps/cli/dist/main.js serve --port 8787
# env fallback also works: HOST=0.0.0.0 PORT=8787 OMNIPROXY_API_KEY=secret node ... serve

# 3) use any SDK
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 OPENAI_API_KEY=unused \
  curl http://127.0.0.1:8787/v1/chat/completions -H content-type:application/json \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'

# 4) diagnose (no secrets, --anonymized for bug reports)
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js doctor --json | jq
```

**Environment:** `Authorization: Bearer …` / `x-api-key` / `x-goog-api-key` / `?key=` — whichever your client sends. `GET /health`, `GET /v1/models`, `GET /v1/capabilities` need no key.

### Auth — where it lives

```
~/.omniproxy/accounts.json  (or $OMNIPROXY_HOME/accounts.json)
  0700 dir, 0600 file (owner-only; Windows ACL). Never committed (.gitignore).
  { "deepseek-web": {"token":"…"} }  or  { "qwen-web": [{"id":"work","fields":{"token":"…"}}] }
```

`pnpm run build && node apps/cli/dist/main.js auth add deepseek-web` without `--field` prompts interactively (`token:`). Pool: second `auth add --id work` promotes single → pool.

### Providers — your own without a fork

```bash
omniproxy provider list                           # every module found, origin flag/env/home/repo
omniproxy provider validate deepseek-web          # errors vs warnings
omniproxy capture record deepseek-web --auth ./auth.json --prompt "hi"  # → raw bundle in ~/.omniproxy/tmp (TTL 1h, 0600)
omniproxy capture sanitize <bundle>              # → fixtures/ (stable {{redacted:*}} placeholders)
omniproxy capture analyze <bundle> --compare <other>  # why each call exists, where ids flow
omniproxy provider draft <bundle> --out ./out.yaml     # status: needs-capture + TODO(capture), never guesses
```

Your `~/.omniproxy/providers/<id>/provider.yaml` **shadows** ours (ADR-0003). No `if (provider===…)` in gateway — UMR in, UMS out.

### Dialects — your own protocol

`--dialect ./my.mjs` — JS module exporting `{name, dialect:{plan,identity,respond,error,refuse}, match(path,method), paths?, side?}`. Mounted before built-ins, `body` read once and shared with the request loop. Full example in [`07-writing-a-dialect.md`](docs/omniproxy/07-writing-a-dialect.md) — ~40 lines.

### Docs

| Doc | What it settles |
|---|---|
| `docs/omniproxy/00-risks.md` | What can fail, honestly |
| `01-monorepo.md` | Current layout (what exists today is marked [+]) vs vision |
| `02-provider-yaml.md` | Declaration format (`unverified` etc.) |
| `05-reliability-charter.md` | 10 invariants, each with a test |
| `06-hackability-charter.md` | Your right to rewire |
| `07-writing-a-dialect.md` | Add a protocol without a fork |
| `docs/omniproxy/adr/` | Decisions (0001…0008) |
| `docs/providers/deepseek-web.md` | Provider dossier, how to verify live |

Two principles: **Reliability over speed** — a broken provider never takes the gateway down; **You are in charge** — user dirs shadow ours, open formats, no telemetry.

### Development

```bash
pnpm install
pnpm run build && pnpm run typecheck && pnpm exec turbo run test --force  # 885 = 844 vitest +41 legacy
pnpm run legacy:test
pnpm exec turbo telemetry disable   # if you want
```

Windows and Linux are first-class (ADR-0005).

### Legal & ToS

OmniProxy drives provider web interfaces with **your own** sessions. This violates most ToSes — **accounts can be banned**. Use only accounts you own and can risk. No bulk registration, no credential sharing, no paid-limit bypass. MIT, no telemetry, no hosted component.

---

## Русский

### Что такое OmniProxy?

OmniProxy ставит **стандартный API** (OpenAI / Anthropic / Gemini / Ollama-совместимый) поверх **веб-интерфейсов** провайдеров — тех эндпоинтов, куда ходит залогиненный браузер. Без платных API, без лока, ваши аккаунты — ваш шлюз.

- **Один сервер, четыре протокола** — `POST /v1/chat/completions`, `/v1/messages`, `/v1beta/models/...:generateContent`, `/api/chat|/api/generate` (NDJSON). Поток и без потока, один промпт байт-в-байт любым SDK.
- **1 → N аккаунтов** — один аккаунт вырожденный случай, не ветка. Переход на следующий только до первого токена от провайдера (граница коммита).
- **Пятый протокол — файл** — `DialectPlugin` (`--dialect ./my.mjs`), монтируется *перед* встроенными, может заменить любой. См. `07-writing-a-dialect.md` — ~40 строк.
- **Честно про готовность** — все декларации `unverified` пока никто не записал живой трафик; `/health` печатает как задекларировано.

> **Статус:** `v0.1.4` — шлюз работает, 885 тестов зелёные. `providers/deepseek-web` `unverified` (из рабочего клиента, прогнан только против симулятора). `legacy/` — **минимальный пример** старого прокси, не ядро.

### Быстрый старт — поставил и забыл

**Docker (одна команда, рестарт при падении):**

```bash
docker run --rm -v omniproxy_data:/home/omniproxy/.omniproxy omniproxy:0.1.4 \
  node apps/cli/dist/main.js auth add deepseek-web --field token=ВАШ_ТОКЕН
docker compose up -d && docker compose logs -f
# http://127.0.0.1:8787/health → {"status":"ok"}
```

**pnpm (из исходников):**

```bash
git clone https://github.com/shirou-eh/OmniProxy.git && cd OmniProxy
pnpm install --frozen-lockfile && pnpm run build
node apps/cli/dist/main.js auth add deepseek-web --field token=...
node apps/cli/dist/main.js auth list        # только имена полей
node apps/cli/dist/main.js serve --port 8787
# curl как выше
node apps/cli/dist/main.js doctor --anonymized  # для багрепорта без путей
```

Ключ принимается как `Authorization: Bearer` / `x-api-key` / `x-goog-api-key` / `?key=`. `GET /health|/v1/models|/v1/capabilities` без ключа. `0.0.0.0` без `--api-key` **отклоняется**.

### Учётные данные — где лежат

```
~/.omniproxy/accounts.json  (или $OMNIPROXY_HOME/accounts.json)
  0700 папка, 0600 файл (только владелец; Windows ACL). Никогда не коммитится.
  { "deepseek-web": {"token":"…"} }  или  { "qwen-web": [{"id":"work","fields":{"token":"…"}}] }
```

Без `--field` в TTY спросит `token:` интерактивно. Второй `auth add --id work` делает пул. Удалить: `rm ~/.omniproxy/accounts.json` или `auth remove`.

### Провайдеры — свой без форка

```bash
omniproxy provider list
omniproxy capture record deepseek-web --auth ./auth.json
omniproxy capture sanitize <bundle> && omniproxy capture analyze <bundle> --compare <other>
omniproxy provider draft <bundle> --out ./out.yaml  # needs-capture + TODO(capture)
```

Ваш `~/.omniproxy/providers/<id>/provider.yaml` **затеняет** наш.

### Диалекты — свой протокол

`--dialect ./my.mjs` — модуль, экспортирующий `DialectPlugin`. Тело читается один раз и шарится между `side` и циклом запроса.

### Доки

Те же, что в английской таблице — все по-русски. Принципы: **Надёжность важнее скорости**, **Пользователь — закон**.

### Разработка

`pnpm install && pnpm run build && pnpm run typecheck && pnpm exec turbo run test --force` — 885 = 844 vitest +41 legacy.

### Юридика

Работа через ваши сессии нарушает ToS большинства сервисов — **бан возможен**. Только свои аккаунты, которым готовы рискнуть.

---

## 中文

### 什么是 OmniProxy？

OmniProxy 在服务商 **网页界面**（浏览器登录后访问的那些端点）前放置 **标准 API**（兼容 OpenAI / Anthropic / Gemini / Ollama）。不用付费 API，不被锁定，你的账号，你的网关。

- **一个服务，四种协议** — `POST /v1/chat/completions` (OpenAI)、`POST /v1/messages` (Anthropic)、`POST /v1beta/models/...:generateContent` (Gemini)、`POST /api/chat|/api/generate` (Ollama NDJSON)。流式/非流式，同一对话到上游是逐字节相同的 prompt。
- **1 → N 账号** — 单账号是退化情况，不是分支。仅在提供商开始回答前才换账号（提交边界）。
- **第五种协议是一个文件** — `DialectPlugin` (`--dialect ./my.mjs`)，挂载在内置四种之前，可替换任意一种。见 `07-writing-a-dialect.md`，约 40 行。
- **诚实声明就绪度** — 所有声明为 `unverified`，直到有人用真实账号录制流量；`/health` 按声明打印。

> **状态：** `v0.1.4` — 网关可运行，885 测试全绿。`providers/deepseek-web` 为 `unverified`（来自可用客户端，仅在本地模拟器上端到端执行）。`legacy/` 仅是 **最小示例**，不是核心。

### 快速开始 — 一次设置，忘记它

**Docker（一条命令，失败自动重启）：**

```bash
docker run --rm -v omniproxy_data:/home/omniproxy/.omniproxy omniproxy:0.1.4 \
  node apps/cli/dist/main.js auth add deepseek-web --field token=你的TOKEN
docker compose up -d && docker compose logs -f
# http://127.0.0.1:8787/health → {"status":"ok"}
```

**pnpm（源码）：**

```bash
git clone https://github.com/shirou-eh/OmniProxy.git && cd OmniProxy
pnpm install --frozen-lockfile && pnpm run build
node apps/cli/dist/main.js auth add deepseek-web --field token=...
node apps/cli/dist/main.js serve --port 8787
# curl 同上
node apps/cli/dist/main.js doctor --anonymized  # 用于提 bug，无路径
```

密钥接受 `Authorization: Bearer` / `x-api-key` / `x-goog-api-key` / `?key=`。`GET /health|/v1/models|/v1/capabilities` 无需密钥。`0.0.0.0` 无 `--api-key` 会被 **拒绝**。

### 凭证 — 在哪里

```
~/.omniproxy/accounts.json  (或 $OMNIPROXY_HOME/accounts.json)
  0700 目录，0600 文件（仅所有者；Windows ACL）。永不提交。
  { "deepseek-web": {"token":"…"} }  或  { "qwen-web": [{"id":"work","fields":{"token":"…"}}] }
```

无 `--field` 且在 TTY 中会交互式询问 `token:`。删除：`rm ~/.omniproxy/accounts.json` 或 `auth remove`。

### 提供商 — 无需 fork

```bash
omniproxy provider list
omniproxy capture record deepseek-web --auth ./auth.json
omniproxy capture sanitize <bundle> && omniproxy capture analyze <bundle> --compare <other>
omniproxy provider draft <bundle> --out ./out.yaml
```

你的 `~/.omniproxy/providers/<id>/provider.yaml` **覆盖**内置的。

### 方言 — 自己的协议

`--dialect ./my.mjs` — 导出 `DialectPlugin` 的 JS 模块，挂载在内置之前。

### 文档

同英文表格。原则：**可靠性高于速度**，**用户即法律**。

### 开发

`pnpm install && pnpm run build && pnpm run typecheck && pnpm exec turbo run test --force` — 885 测试。

### 法律

通过你自己的会话驱动网页界面违反大多数 ToS — **账号可能被封**。仅使用你愿意冒险的账号。

---

MIT. No telemetry, no paywall, no hosted part. Purple rocket — MD3 Expressive.
