# `provider.yaml` — полная схема

Это главный контракт проекта: от его выразительности зависит, сколько провайдеров
удастся поддержать без кода и как быстро чинить сломанные. Версионируется через
`schemaVersion`; несовместимые изменения требуют миграции всех деклараций.

## 1. Язык подстановок и извлечения

**Подстановка `{{path}}`** — только чтение из контекста, без выражений и вызовов.
Доступные корни:

| Корень | Содержимое |
|---|---|
| `req.*` | нормализованный UMR: `req.prompt`, `req.model`, `req.messages`, `req.params.aspectRatio`, `req.refs[0].url` |
| `auth.*` | поля credential: `auth.token`, `auth.cookieHeader`, `auth.local.<key>` |
| `state.*` | состояние сессии между шагами: `state.sessionId`, `state.parentMessageId` |
| `vars.*` | результаты `transform`-ов, вычисленные для этого запроса |
| `env.*` | только белый список из конфига канала (никогда не весь `process.env`) |
| `now.*` | `now.unixMs`, `now.unixS`, `now.iso` |
| `job.*` | в async-потоке: `job.externalId`, `job.attempt` |

Модификаторы через вертикальную черту: `json`, `base64`, `base64url`, `urlencode`,
`int`, `number`, `bool`, `upper`, `lower`, `trim`, `null-if-empty`,
`default:<value>`, `slice:<n>`. Список закрыт, расширяется только кодом.

**Отсутствующее значение по умолчанию — ошибка.** Плейсхолдер, который ни во что не
развернулся, останавливает сборку запроса и называет себя по имени: запрос с пустым
`sessionId` уходит наверх и возвращается безликим 400, на разбор которого уходит час.

Но часть значений отсутствует законно — `parent_message_id` первого сообщения в
диалоге, — поэтому отсутствие должно быть *сказано*, а не просто пережито:

| Запись | Если значения нет |
|---|---|
| `{{state.parentMessageId}}` | запрос не собирается, плейсхолдер назван в ошибке |
| `{{state.parentMessageId?}}` | поле выбрасывается из тела целиком |
| `{{state.parentMessageId\|null-if-empty}}` | поле уходит как JSON `null` |

Третья форма — то, что нужно DeepSeek: сервер ждёт поле, но пустым его не принимает.

**Извлечение** — подмножество JSONPath: `$.a.b`, `$.a[0]`, `$.a[*].b`, `$..id`,
фильтр по равенству поля. Ничего исполняемого. Для не-JSON тел доступны `regex:`
(с обязательной именованной группой) и `header:`.

## 2. Схема целиком

```yaml
schemaVersion: 1
id: qwen                          # уникальный, kebab-case, = имя папки
displayName: Qwen Chat
class: B                          # A|B|C|D|E|F|G — класс сложности из §7
status: experimental              # needs-capture | experimental | broken | stable
homepage: https://chat.qwen.ai
capture:                          # происхождение декларации, §8
  bundle: fixtures/capture-2026-08-20.json
  capturedAt: 2026-08-20
  method: cdp                     # cdp | extension | har-import
  coverage: [chat-stream, session-create]   # какие сценарии сняты

# ─────────────── КАНАЛЫ ───────────────
# Один провайдер — несколько способов доступа. Порядок = порядок деградации (§6.3).
channels:
  - id: http
    kind: web-http                # web-http | web-browser | gateway-protocol
    base: https://chat.qwen.ai
    fingerprint:
      profile: chrome-131         # профиль из packages/transport
      impersonate: false          # true → обязателен sidecar tls-client
      headerOrder: [accept, accept-language, content-type, origin, referer, user-agent]
      static:
        accept-language: en-US,en;q=0.9
        origin: https://chat.qwen.ai
        referer: https://chat.qwen.ai/
    http2: true
    proxy: inherit                # inherit | required | none
    concurrency: 1                # одновременных запросов на аккаунт (шлюз это применяет)
    rateLimit: { perMinute: 20 }
  - id: browser
    kind: web-browser
    entryUrl: https://chat.qwen.ai/
    adapter: ./adapter.browser.ts # browser-канал почти всегда код

# ─────────────── АВТОРИЗАЦИЯ ───────────────
auth:
  kind: cookie+bearer             # cookie | bearer | cookie+bearer | custom
  harvest:
    domains: [chat.qwen.ai, .qwen.ai]
    cookies:   { required: [token], optional: [ssxmod_itna, cna] }
    localStorage: { required: [], optional: [device_id] }
    indexedDB: []
    afterLogin:                   # что попросить сделать пользователя перед снятием
      instruction: "Отправьте один короткий запрос в чате, затем вернитесь в терминал"
  present:                        # как credential превращается в заголовки
    headers:
      authorization: "Bearer {{auth.cookies.token}}"
      cookie: "{{auth.cookieHeader}}"
      x-device-id: "{{auth.local.device_id}}"
  validate:
    request: { method: GET, path: /api/v1/auths/ }
    expect:  { status: 200, jsonPath: $.id, exists: true }
  refresh:
    mode: none                    # none | endpoint | browser-reauth
    ttlHint: 3600
    request: { method: POST, path: /api/v1/auths/refresh }
    extract: { token: $.token }
  quota:                          # известные лимиты аккаунта, для планировщика
    unit: message                 # message | generation | credit
    perDay: 100
    resetAt: "00:00Z"

# ─────────────── ANTI-BOT ───────────────
antibot:
  challenges: []                  # [pow-wasm] | [turnstile] | [signature-header] ...
  detect:                         # как распознать, что нас поймали
    - match: { status: 403, bodyContains: "Just a moment" }
      as: challenge
      escalate: browser           # ступень деградации (§6.3)
    - match: { status: 429 }
      as: rate_limit
      cooldownFrom: header:retry-after

# ─────────────── ВЫЧИСЛЯЕМЫЕ ЗНАЧЕНИЯ (ADR-0002, уровень 2) ───────────────
vars:
  requestId: { transform: uuid-v4 }
  sig:
    transform: hmac-sha256
    with: { key: "{{auth.local.secret}}", data: "{{state.sessionId}}{{now.unixMs}}" }

# ─────────────── ПОТОК ───────────────
flow:
  # --- Синхронный текстовый путь ---
  createSession:
    unless: "{{state.sessionId}}" # выполнять, только если пусто
    request:
      method: POST
      path: /api/v1/chats/new
      json: { chat: { title: "New Chat", models: ["{{req.model}}"] } }
    extract: { sessionId: $.data.id }
  send:
    request:
      method: POST
      path: /api/v2/chat/completions
      query: { chat_id: "{{state.sessionId}}" }
      headers: { x-request-id: "{{vars.requestId}}" }
      json:
        stream: true
        model: "{{req.model}}"
        parent_id: "{{state.parentMessageId|null-if-empty}}"
        messages: [{ role: user, content: "{{req.prompt}}" }]
    stream:
      format: sse                 # sse | ndjson | json-patch | websocket | poll | plain
      doneWhen: { data: "[DONE]" }
      map:
        text:      $.choices[0].delta.content
        reasoning: $.choices[0].delta.reasoning_content
        messageId: $.response.id            # → state.parentMessageId
        finish:    $.choices[0].finish_reason
        usage:     $.usage
      # Для format: json-patch (случай DeepSeek) вместо map используется:
      # patch:
      #   pathField: p
      #   opField: o
      #   valueField: v
      #   routes: { RESPONSE: text, THINK: reasoning, SEARCH: search }
    # Провайдер, который отвечает одним телом, а не потоком, вместо `stream`
    # описывает `response` — те же поля карты. Без этого один-единственный
    # нестримящий сервис пришлось бы писать кодовым адаптером ради двух JSONPath.
    # response:
    #   text:   $.data.text
    #   finish: $.data.status
    persist: { parentMessageId: "{{extracted.messageId}}" }

  # --- Асинхронный путь (видео/музыка/3D) ---
  submit:
    request:
      method: POST
      path: /api/generate
      json: { prompt: "{{req.prompt}}", aspect_ratio: "{{req.params.aspectRatio}}" }
    extract: { externalId: $.data.task_id }
    pollAfterMs: 5000
  poll:
    request: { method: GET, path: "/api/task/{{job.externalId}}" }
    intervalMs: 5000
    backoff: { factor: 1.2, maxMs: 30000 }
    timeoutMs: 1800000
    map:
      status:
        from: $.data.status
        values: { queued: queued, processing: running, succeed: succeeded, failed: failed }
      progress: $.data.progress
      progressRange: [0, 100]     # нормализация в 0..1
      artifacts: $.data.works[*].resource.resource
      error: $.data.fail_reason
  cancel:
    request: { method: POST, path: "/api/task/{{job.externalId}}/cancel" }
  upload:                         # приём входных файлов (vision, refs)
    negotiate: { request: { method: POST, path: /api/upload/token },
                 extract: { uploadUrl: $.url, fileId: $.id } }
    put:       { method: PUT, url: "{{extracted.uploadUrl}}", bodyFrom: ref }
    commit:    { request: { method: POST, path: /api/upload/commit } }
  download:                       # особенности скачивания артефактов
    auth: none                    # inherit | none — CDN часто без авторизации
    expiresHint: 3600

# ─────────────── ОШИБКИ ───────────────
errors:
  - match: { jsonPath: $.code, equals: RateLimited }
    as: rate_limit
    retryable: other-account      # no | same-account | same-account-shrunk |
    userMessage: "Дневной лимит аккаунта исчерпан"   # other-account | other-provider
  - match: { status: 401 }
    as: auth_expired
    retryable: no
    userMessage: "Переавторизуйтесь: omniproxy auth add qwen"
  - match: { bodyContains: "context length" }
    as: context_too_long
    retryable: same-account-shrunk

# ─────────────── КОНТЕКСТ ───────────────
context:
  strategy: flatten-to-prompt     # flatten-to-prompt | native-messages
  compaction: truncate-middle     # truncate-middle | summarize-oldest | sliding-window
  measured:
    contextChars: 100000          # ИЗМЕРЕНО через omniproxy probe, не из маркетинга
    measuredAt: 2026-08-20
    method: binary-search-probe

# ─────────────── МОДЕЛИ ───────────────
models:
  - alias: qwen3-max
    native: qwen3-max
    modality: { input: [text, image], output: [text] }
    capability:
      streaming: true
      async: false
      reasoning: false
      webSearch: true
      vision: true
      fileUpload: true
      toolCalling: unmeasured     # text-emulated | none | unmeasured (см. R-5)
      structuredOutput: unmeasured
      contextChars: 100000
      maxOutputChars: 32000
    params:                       # канонический параметр → нативный
      map:
        webSearch: { path: features.search, type: boolean }
        seed:      { path: seed, type: int, range: [0, 2147483647] }
      unsupported: [temperature, topP]   # честно: игнорируются с warning в ответе

# ─────────────── КАНАРЕЙКА ───────────────
probe:
  interval: 30m
  request:
    prompt: "Reply with exactly: OK"
  expect:
    contains: "OK"
    maxLatencyMs: 30000
    maxFirstByteMs: 8000
  onFail:
    after: 2                      # подряд провалов до карантина
    action: quarantine            # quarantine | degrade | alert-only
```

## 3. Что схема сознательно НЕ поддерживает

- Выражений, условий сложнее `when` / `unless` по одному пути, и циклов — это признак
  уровня 3 (ADR-0002).
- Инлайнового JavaScript в любом виде.
- Ссылок на файлы вне папки провайдера.
- Секретов. Любое поле, значение которого похоже на токен или cookie, валидатор
  отклоняет с ошибкой: секреты живут только в credential-store.

## 4. Инструменты вокруг схемы

- `omniproxy provider validate <id>` — Zod-валидация + проверка ссылок на transforms,
  профили отпечатка и фикстуры.
- `provider.schema.json` генерируется из Zod и подключается в IDE — правка декларации
  идёт с автодополнением и подсветкой ошибок.
- `omniproxy provider diff <id>` — сравнение фактического ответа с фикстурой,
  вывод расхождения путей (§9, диффер схем).

## 5. Модуль провайдера как единица распространения (ADR-0003)

Декларация — это не только внутренний формат проекта, но и то, чем обмениваются
пользователи. Отсюда три дополнения к схеме.

### 5.1 Ограничение исходящих хостов — обязательно

```yaml
allowedHosts:                   # белый список хостов, куда модулю можно ходить
  - chat.qwen.ai
  - cdn.qwen.ai                 # хост артефактов, если отличается
```

Движок отклоняет любой запрос за пределы `channels[].base` и `allowedHosts`, включая
редиректы. Без этого присланная кем-то декларация могла бы утащить cookie на чужой
хост. Правило действует одинаково для встроенных и пользовательских модулей.

### 5.2 `module.json` — метаданные для обмена

```json
{
  "name": "my-cool-image-service",
  "version": "0.3.1",
  "author": "someone",
  "license": "MIT",
  "omniproxySchema": 1,
  "requiresCode": false,
  "requiresTransforms": ["hmac-sha256"],
  "requiresOptional": ["tls-client"]
}
```

`requiresCode: false` — обещание, которое проверяется загрузчиком: если в каталоге
при этом лежит `adapter.ts`, модуль отклоняется как несогласованный.
`requiresTransforms` и `requiresOptional` позволяют сказать пользователю
«этому модулю нужен sidecar имперсонации» до первого запроса, а не после.

### 5.3 Политика совместимости

`schemaVersion` — публичный контракт. Поддерживаются текущая и предыдущая мажорные
версии; `omniproxy provider migrate` переписывает декларацию автоматически там, где
это возможно, и оставляет пометки там, где нужен человек. Модуль с неизвестной
будущей версией помечается `unsupported-schema` и не влияет на старт остальных.

## 6. Каналы, не являющиеся веб-интерфейсом (ADR-0006)

### 6.1 Пять видов каналов

| `kind` | Что это | Авторизация |
|---|---|---|
| `web-http` | эндпоинты, в которые ходит браузер | cookie из живой сессии |
| `web-browser` | тот же сервис через Playwright | сессия браузерного профиля |
| `gateway-protocol` | не HTTP: Discord Gateway и подобное | токен бота/пользователя |
| `app-backend` | эндпоинт, в который ходит **десктопное приложение** | токен из локального файла состояния приложения |
| `local-process` | чужой прокси, который OmniProxy запускает сам | его собственная, нас не касается |

Порядок в `channels` остаётся порядком деградации, поэтому «сначала декларация,
если сломалась — управляемый процесс» описывается штатно.

### 6.2 `auth.kind: local-file`

```yaml
auth:
  kind: local-file
  harvest:
    file:                              # пути по платформам, ADR-0005
      win32:  "%USERPROFILE%\.someapp\request-headers.json"
      linux:  "$HOME/.someapp/request-headers.json"
      darwin: "$HOME/Library/Application Support/SomeApp/headers.json"
    extract: { token: $.headers.X-Authorization }
    watch: true                        # приложение обновляет токен само — следим за файлом
  present:
    headers:
      x-authorization: "{{auth.token}}"
```

`watch: true` вместо собственного refresh — там, где токен обновляет само приложение,
правильная работа состоит в том, чтобы её не делать. Файл читается только на чтение;
значение попадает в credential-store и в логи только как `sha256[:8]`.

### 6.3 `kind: local-process` — «принеси свой прокси»

```yaml
channels:
  - id: managed
    kind: local-process
    process:
      command: node
      args: [./vendor/some-proxy.js]
      env: { PORT: "{{channel.port}}" }
      port: auto                       # свободный порт выделяем мы
      readyWhen:
        request: { method: GET, path: /v1/models }
        timeoutMs: 15000
      restart: { maxAttempts: 5, backoffMs: 1000, maxBackoffMs: 30000 }
    speaks: openai                     # диалект, на котором отвечает процесс
```

**Требует доверия.** Запуск исполняемого файла — это исполнение кода, как `adapter.ts`:
канал не стартует, пока пользователь не подтвердил `omniproxy provider trust <id>`,
и хеш команды с аргументами запоминается. Декларация с `local-process` не является
«данными» и не может расшариваться как безопасная.

Запуск только через `spawn` без `shell: true`. Остановка — группа процессов на POSIX,
`taskkill /T` по дереву на Windows.

### 6.4 Профили отпечатка — именованные, а не «более браузерные»

`fingerprint.profile` — это имя из реестра, а не позиция на шкале. Для провайдера под
Cloudflare нужен `chrome-131`; для бэкенда десктопного приложения, чей WAF ждёт именно
приложение, — `node-undici`. Ошибиться можно в обе стороны, и правильное значение
берётся из захвата, а не из общих соображений.
