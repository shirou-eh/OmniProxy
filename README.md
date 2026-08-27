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

# OmniProxy — универсальный шлюз

**OmniProxy** ставит **стандартный API** (совместимый с OpenAI / Anthropic / Gemini / Ollama) поверх **веб-интерфейсов** провайдеров — тех самых эндпоинтов, куда ходит твой залогиненный браузер. Без платных API, без привязки к вендору, твои аккаунты — твой шлюз. Поддерживает все модальности: текст, изображения, видео, аудио, музыка, речь, 3D (через `provider.yaml`).

> **Статус: `v0.1.4` — шлюз работает.** `omniproxy serve` отвечает на запросы в форматах OpenAI, Anthropic, Gemini и Ollama поверх любого модуля провайдера — с пулом аккаунтов, потоковой отдачей, воротами конкурентности и честным `unverified`. **Ни один провайдер ещё не проверен против живого сервиса**: все декларации `unverified` и прогоняются целиком только против протокольно достоверного локального симулятора (`packages/provider-sim` с настоящим `sha3_wasm_bg`). `legacy/` — **минимальный пример** оригинального прокси (41 тест), не ядро — см. `legacy/README.md` если нужно. Этот README не врёт: пока каждая часть не станет реальной и покрытой тестами — так и написано.

---

## Содержание

- [Архитектура за 30 секунд](#архитектура-за-30-секунд)
- [Быстрый старт — поставил и забыл](#быстрый-старт--поставил-и-забыл)
- [Аутентификация — где лежат токены](#аутентификация--где-лежат-токены)
- [Провайдеры — подключи свой без форка](#провайдеры--подключи-свой-без-форка)
- [Конвейер захвата — от трафика к декларации](#конвейер-захвата--от-трафика-к-декларации)
- [Диалекты — пятый протокол это файл](#диалекты--пятый-протокол-это-файл)
- [Диагностика — doctor без утечек](#диагностика--doctor-без-утечек)
- [Эндпоинты шлюза](#эндпоинты-шлюза)
- [Документация — куда дальше](#документация--куда-дальше)
- [Разработка — как собрать и тестировать](#разработка--как-собрать-и-тестировать)
- [Развёртывание — Docker и systemd](#развёртывание--docker-и-systemd)
- [Безопасность и права](#безопасность-и-права)
- [Юридическая рамка](#юридическая-рамка)
- [История и принципы](#история-и-принципы)

---

## Архитектура за 30 секунд

```
любой SDK  →  диалект (OpenAI/Anthropic/Gemini/Ollama/твой)  →  UMR (универсальный запрос)
                                                                              ↓
provider.yaml  →  движок (flow, JSONPath, трансформы)  →  HTTP  →  веб-интерфейс провайдера
                                                                              ↓
                                                                       UMS (поток событий)
                                                                              ↓
                                                                    диалект → ответ SDK
```

- **UMR** (`packages/umr`): `flattenConversation` — один промпт байт-в-байт любым SDK, парсер текстовой эмуляции `tool_call`.
- **UMS** (`packages/schema`): события `start`/`delta`/`warning`/`error`, собирается только из них.
- **Движок** (`packages/engine-declarative`): шаблоны `{{ }}` (`?`/`null-if-empty`), JSONPath, трансформы (`deepseek-pow-v0`, `uuid-v4`...), фрейминг `sse`/`ndjson`/`json-patch`.
- **Шлюз** (`packages/gateway`): маршрутизация `alias` → `provider`, пул `1..N` (ADR-0004, нет `if (len===1)`), `ConcurrencyGate` на пару `аккаунт+канал`, граница коммита (ретрай только до первого `content`).
- **Транспорт** (`packages/transport`): `fetchHttpClient` / `recording` / `replay`, `allowedHosts` до запроса, `bodyEncoding: base64` для бинаря.
- **Обнаружение** (`discovery.ts`): `--provider-dir` > `$OMNIPROXY_PROVIDER_PATH` (`:`/`;` по OS) > `~/.omniproxy/providers/` > `providers/` в репо, первый найденный побеждает — твой шлюз.
- **Принципы:** никакого `if (provider===…)` в `core/gateway` (§12.3), состояние запроса живёт **один запрос** (ADR-0008, риск R-6 закрыт), секреты никогда не в `git`/логах/`/health` (§12.7), не выдумываем эндпоинты (§12.1).

---

## Быстрый старт — поставил и забыл

### Вариант A — Docker (одна команда, рестарт при падении, 0600-volume)

```bash
# 1) токен один раз (спросит token: если без --field, TTY)
docker run --rm -v omniproxy_data:/home/omniproxy/.omniproxy omniproxy:0.1.4 \
  node apps/cli/dist/main.js auth add deepseek-web --field token=ВАШ_ТОКЕН

# где лежит / как удалить:
docker run --rm -v omniproxy_data:/home/omniproxy/.omniproxy omniproxy:0.1.4 \
  node apps/cli/dist/main.js auth path   # → /home/omniproxy/.omniproxy/accounts.json
# docker volume rm omniproxy_data  — или: auth remove deepseek-web

# 2) поднять (healthcheck на /health, restart unless-stopped)
docker compose up -d && docker compose logs -f
# http://127.0.0.1:8787/health → {"status":"ok"}

# без compose:
docker build -f Containerfile -t omniproxy:0.1.4 . && \
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -v omniproxy_data:/home/omniproxy/.omniproxy \
  -e OMNIPROXY_API_KEY=длинный_секрет_если_нужен_0.0.0.0 \
  omniproxy:0.1.4
```

### Вариант B — pnpm из исходников (Windows и Linux — оба первого класса)

```bash
git clone https://github.com/shirou-eh/OmniProxy.git && cd OmniProxy
pnpm install --frozen-lockfile   # pnpm 11.24, node >=22 (см. package.json:engines)
pnpm run build                   # tsc, turbo

# 1) учётка (0600 файл ~/.omniproxy/accounts.json)
node apps/cli/dist/main.js auth add deepseek-web --field token=...
# без --field в TTY спросит интерактивно; пул: второй --id work
node apps/cli/dist/main.js auth add qwen-web --id work --field token=...
node apps/cli/dist/main.js auth list                 # только имена полей, никогда значения
node apps/cli/dist/main.js auth list --json | jq
node apps/cli/dist/main.js auth path                 # где лежит

# 2) шлюз (loopback по умолчанию; 0.0.0.0 без --api-key отклоняется, а не ворнится)
node apps/cli/dist/main.js serve --port 8787
# env тоже работает: HOST=0.0.0.0 PORT=8787 OMNIPROXY_API_KEY=secret node ... serve
# --dialect ./my.mjs --provider deepseek-web --provider-dir ./my/providers --env K=V

# 3) любой SDK — один промпт байт-в-байт любым диалектом (тест на это есть)
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 OPENAI_API_KEY=unused \
  curl http://127.0.0.1:8787/v1/chat/completions -H content-type:application/json \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"привет"}]}'

ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=unused \
  curl http://127.0.0.1:8787/v1/messages -H content-type:application/json -H anthropic-version:2023-06-01 \
  -d '{"model":"deepseek-chat","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'

GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787 GEMINI_API_KEY=unused \
  curl http://127.0.0.1:8787/v1beta/models/deepseek-chat:generateContent -H content-type:application/json \
  -d '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}'

OLLAMA_HOST=http://127.0.0.1:8787 curl http://127.0.0.1:8787/api/chat -H content-type:application/json \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":false}'

# 4) что доступно и диагностика (без секретов)
curl http://127.0.0.1:8787/v1/models          # OpenAI-совместимый список всех алиасов
curl http://127.0.0.1:8787/v1/capabilities    # что реально умеет шлюз per provider
curl http://127.0.0.1:8787/health            # dialects в порядке монтирования, providers, accounts (имена полей), inFlight
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js doctor --anonymized  # без абсолютных путей для багрепорта
node apps/cli/dist/main.js doctor --json | jq
```

Ключ принимается как `Authorization: Bearer` / `x-api-key` / `x-goog-api-key` / `?key=` — что шлёт твой клиент. `GET /health|/v1/models|/v1/capabilities` без ключа. Порт по умолчанию `8787`.

---

## Аутентификация — где лежат токены

```
~/.omniproxy/accounts.json  (или $OMNIPROXY_HOME/accounts.json)
  папка 0700, файл 0600 (только владелец; Windows ACL; будущий DPAPI/libsecret)
  никогда не коммитится (.gitignore: accounts*.json, *.raw.json, *.har)
  формат:
    { "deepseek-web": {"token":"…"} }
    { "qwen-web": [{"id":"work","fields":{"token":"…"}},{"id":"personal","fields":{"token":"…"}}] }
```

- `auth add deepseek-web --field token=...` — один аккаунт как плоский объект.
- Второй `auth add deepseek-web --id work --field token=...` — промотирует в пул `[{id,fields},{id,fields}]`.
- Дубликат `id` — отказ с подсказкой.
- `auth list` — `provider  id  fields: token, cookie` и `store: /path`; ` --json` → `[{provider,id,fields[]}]` (значений нет, §12.7).
- `auth remove deepseek-web` — весь провайдер; ` --id work` — один из пула.
- `auth path` — путь. Удалить: `rm ~/.omniproxy/accounts.json` (или `$OMNIPROXY_HOME`).
- `serve` читает тот же путь; `--accounts <file>` — разовый файл; если файл `044` (group/other readable) — `warning: chmod 600`.
- Без `--field` в TTY — интерактивный `token:` промпт.

---

## Провайдеры — подключи свой без форка

```bash
omniproxy provider list --json                    # id, origin flag/env/home/repo, dir, status, warnings
omniproxy provider validate deepseek-web          # Zod + ссылки на трансформы/фикстуры, errors vs warnings
omniproxy provider validate --provider-dir ./my   # твои рядом с нашими, твои побеждают
```

**Порядок поиска** (первый найденный побеждает, ADR-0003): `--provider-dir` > `$OMNIPROXY_PROVIDER_PATH` (делитель `path.delimiter`, `:`/`;`) > `~/.omniproxy/providers/` > `providers/` в репо (fallback по месту самого CLI — работает из `/tmp` и `docker`). Битая декларация одного провайдера не валит остальных (I-1).

Твой модуль — папка `~/.omniproxy/providers/<id>/provider.yaml` ( + `fixtures/` + опционально `adapter.ts` по ADR-0002 ур.3). Скопируй `providers/deepseek-web/provider.yaml` как шаблон.

**Классы сложности** (§7, `02-provider-yaml.md`): `A` (cookie+PoW) … `G` (video) — `deepseek-web` класс `A`.

---

## Конвейер захвата — от трафика к декларации

Декларация пишется **только** из записанного трафика (§12.1, §12.5 — нет `TODO позже`).

```bash
omniproxy capture record deepseek-web --auth ./auth.json --prompt "hi" --model deepseek-chat
# → сырой бандл в ~/.omniproxy/tmp/ (TTL 1h, 0600, UNSANITIZED, с живыми cookie)

omniproxy capture import <file.har> --provider my-cool --scenario chat --out ./tmp
# HAR 1.2 из DevTools, порядок заголовков сохранён, SSE → frames, base64

omniproxy capture sanitize <bundle> --out ./san.json
# стабильные {{redacted:kind:n}} (один токен → один плейсхолдер), идемпотентен,
# структура cookie/Set-Cookie/Bearer сохранена, перепроверка готового файла

omniproxy capture analyze <bundle> --compare <other> [--json]
# классификация с "почему" (preflight/telemetry/static/SSE/session…), граф "значение из ответа A в запросе B",
# volatileFields (что меняется между прогонами → станет {{ }})

omniproxy provider draft <bundle> --out ./provider.yaml
# черновик: только то, что было в записи; где запись молчит — '# TODO(capture): …', а не догадка
# статус всегда needs-capture — поднять может только человек
```

Движок (`engine-declarative`): `{{req.prompt}}` / `{{state.sessionId}}` / `{{state.parentMessageId?}}` / `{{state.x|null-if-empty}}` / `{{vars.pow}}` / `{{env.K}}`, JSONPath `$.a.b[0]`, `regex:`, `header:`, трансформы `uuid-v4`, `hmac-sha256`, `deepseek-pow-v0` (настоящий `wasm`), фрейминг `sse`/`ndjson`/`json-patch`.

Симулятор (`provider-sim`): локальный сервер, говорящий как `legacy/server.js`, с настоящим `sha3_wasm_bg` — 23 сквозных теста `transport` ловят рассинхрон до проде.

---

## Диалекты — пятый протокол это файл

Четыре встроенных — обычные `DialectPlugin`, монтируются тем же путём, что твой. Привилегированного входа нет.

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
omniproxy serve --dialect ./my.mjs                 # файл
omniproxy serve --dialect ./dialects/              # каталог, сортируется, детерминирован (ADR-0005)
# экспорт может называться default / dialect / plugin
# --dialect исполняет чужой JS с твоими аккаунтами — один warning при старте, дальше делает что просишь
```

`body` читается один раз и шарится между `side` и циклом запроса; `side` не тратит аккаунт. Подробно: `docs/omniproxy/07-writing-a-dialect.md` — контракт, 40-строчный рабочий пример, где смотреть (`packages/dialect-*/`).

---

## Диагностика — doctor без утечек

```bash
omniproxy doctor                 # human: node/platform/cwd, providers, auth store
omniproxy doctor --json          # machine
omniproxy doctor --anonymized    # для issue, без абсолютных путей
```

Проверяет: `node >=22`, `providers` (shadowing, `BROKEN` с причиной), `auth store` (`exists`, `mode`, `validJson`, `accounts`, `warning: chmod 600`), подсказывает `auth add`. Секреты — только `fields[]` (имена), никогда значения (§12.7, тест `health` на это).

---

## Эндпоинты шлюза

| Метод | Путь | Что |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (SSE `text/event-stream` и JSON) |
| `POST` | `/v1/messages` | Anthropic Messages (`system` как поле, нумерованные блоки) |
| `POST` | `/v1beta/models/<m>:generateContent` | Gemini (`:streamGenerateContent` тоже, `safetyRatings:[]`, `countTokens` как `estimated:true`) |
| `POST` | `/api/chat` | Ollama Chat (NDJSON, `stream` по умолчанию `true`) |
| `POST` | `/api/generate` | Ollama Generate (`response` вместо `message`) |
| `GET` | `/v1/models` | Все алиасы, `qualified` и `bare` (superset OpenAI+Anthropic) |
| `GET` | `/v1beta/models` | Gemini-форма (`models/deepseek-chat`) |
| `GET` | `/api/tags` | Ollama tags (`size:0,dgest:""` честно, файла нет) |
| `POST` | `/api/show` | Ollama show (`omniproxy.status` как задекларировано, без `context length`) |
| `GET` | `/api/version` | `0.1.4-omniproxy`, не версия Ollama |
| `GET` | `/v1/capabilities` | Что реально умеет шлюз per provider (без выдумок `§12.10`) |
| `GET` | `/health`, `/healthz` | `dialects` в порядке монтирования, `providers` (`unverified` остаётся), `accounts` (имена полей), `inFlight` |
| — | `/nope` | `404` с `This build serves …, /v1/models, /v1/capabilities and /health.` |

`OPTIONS` → `204` CORS (только `localhost`/`127.0.0.1`/`::1`, wildcard запрещён — иначе любая страница тратила бы твои аккаунты).

---

## Документация — куда дальше

| Документ | Что |
|---|---|
| `docs/en/*`, `docs/ru/*`, `docs/zh/*` | Трёхязычные доки (скоро) |
| `docs/omniproxy/00-risks.md` | Что сломается, честно |
| `01-monorepo.md` | Текущая раскладка `[+]` — что есть сегодня vs визион |
| `02-provider-yaml.md` | Формат декларации (`unverified` etc.) |
| `05-reliability-charter.md` | 10 инвариантов, каждый с тестом |
| `06-hackability-charter.md` | Твоё право переопределить |
| `07-writing-a-dialect.md` | Свой протокол без форка |
| `docs/omniproxy/adr/` | Решения 0001…0008 |
| `docs/providers/deepseek-web.md` | Досье провайдера, как верифицировать live |

Принципы: **Надёжность важнее скорости** — сломанный провайдер не валит шлюз; **Пользователь — закон** — `~/.omniproxy` затеняет, открытые форматы, без телеметрии.

---

## Разработка — как собрать и тестировать

```bash
pnpm install --frozen-lockfile   # pnpm 11.24, node >=22
pnpm run build                   # turbo, tsc
pnpm run typecheck               # strict, exactOptionalPropertyTypes
pnpm exec turbo run test --force # 885 = 844 vitest +41 legacy (node:test, сервер и pow)
pnpm run legacy:test             # только legacy (41)
pnpm exec turbo telemetry disable
```

CI: `push`/`PR` → `build` + `typecheck` + `test` на `ubuntu/windows × node 22/24`, `secrets-scan` (JWT/`smidV2`/cookies), `audit --audit-level high`. `turbo` кэш — `FULL TURBO` значит кэш, `--force` для честного прогона.

Ловушки: `\n` в heredoc, апострофы в `it('')`, `cd` в составной команде, `turbo --force` vs `pnpm -- --force`, `CRLF`, `python3` нет — только `node`.

---

## Развёртывание — Docker и systemd

**Docker Compose (рекомендуется, set-and-forget):**

```yaml
# docker-compose.yml уже в репо
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
# 0.0.0.0 внутри контейнера, 127.0.0.1 на хосте; без OMNIPROXY_API_KEY внешний bind отклоняется
```

**Без compose:**

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

## Безопасность и права

- Санитайзер неотключаем (§8.4): `*.raw.json`/`*.har`/`accounts.json` в `.gitignore`, `secrets-scan` в CI, `writeFixture` перепроверяет готовый файл.
- `serve` вне `127.0.0.1` без `--api-key` **отклоняется**; ключ сравнивается `timingSafeEqual`; `HOST`/`PORT` из env (`HOST`/`PORT`/`OMNIPROXY_HOME` fallback); CORS только `localhost`/`127.0.0.1`/`::1`.
- Аккаунты: `0700` папка, `0600` файл, `doctor`/`serve` ворнят если `044`; удаление: `rm …/accounts.json` или `auth remove`.
- `legacy/chrome-extension` — MV3, только `cookies`/`storage`/`downloads`, `chrome.debugger` для CDP, жёлтая плашка — честно.

---

## Юридическая рамка

OmniProxy гоняет **твои** сессии. Это нарушает ToS большинства сервисов — **бан**. Только свои аккаунты, которыми готов рискнуть. Не делает: массовую регистрацию, чужие учётки, обход платных лимитов. MIT, без телеметрии, без hosted-компонента. Подробнее: `LICENSE`, `docs/legal`.

---

## История и принципы

Журнал по PR в `docs/omniproxy/04-phase-1-plan.md` (честно, что нашёл тест) и `CHANGELOG.md`. Тег `baseline-v0.1.0`, симуляторы вместо выдуманных фикстур (ADR-0007), сессии живут **один запрос** (ADR-0008, R-6 закрыт), `ConcurrencyGate` на пару `аккаунт+канал`.

Цели: `gateway availability` при мёртвых провайдерах `100%` (ошибки с `userAction`), `errors_without_user_action` `0`, `lost jobs` `0`, `MTTR "сменилась схема"` `<30m` (правка `yaml`), `overhead p95` `<15ms`, запуск без опциональных deps — обязателен (I-10).

---

<p align="center"><sub>Purple rocket — MD3 Expressive · <code>assets/banner.svg</code> · <code>assets/avatar.svg</code> · shirou-eh/OmniProxy</sub></p>
