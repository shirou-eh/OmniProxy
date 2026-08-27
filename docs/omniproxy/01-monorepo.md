# OmniProxy — дерево монорепо и назначение пакетов

> **Визион (§2.2) против реальности PR-13.** Ниже — целевое дерево из исходного ТЗ
> (7 фаз, ~25 провайдеров, `apps/gateway` на Fastify, `packages/core/*`, `packages/auth` …).
> То, что **уже реализовано сегодня**, выделено `[+]` и перечислено в § «Что есть сейчас».
> Остальное — план, а не факт. Смотри также `04-phase-1-plan.md` — журнал, где каждый PR
> фиксирует, что стало реальностью и что осталось на бумаге.

Отличия от §2.2 промта отмечены `[+]` (добавлено) и обоснованы.

## Что есть сейчас (PR-13)

```
apps/cli/            — единственный app, бинарь omniproxy (serve / provider / capture)
packages/schema/     — UMS, CaptureBundle, ProviderDeclaration, OmniError
packages/umr/        — универсальный диалог → промпт (flattenConversation)
packages/engine-declarative/ — исполнение provider.yaml (flow, JSONPath, трансформы, фрейминг)
packages/capture/    — HAR → санитизация → анализ → draft
packages/transport/  — fetchHttpClient / recording / replay
packages/provider-sim/ — локальный симулятор DeepSeek (ADR-0007)
packages/dialect-{openai,anthropic,gemini,ollama}/ — чистые трансляторы
packages/gateway/    — HTTP-поверхность, роутинг, пул аккаунтов, ворота, цикл запроса
providers/deepseek-web/ — единственная реальная декларация (status: unverified)
legacy/              — исходный прокси, untouched, golden-тесты
```

Всё остальное ниже — визион, не реализовано. Честная граница.

```
omniproxy/
├─ apps/
│  ├─ gateway/          HTTP-процесс: Fastify, монтирует protocols, DI-корень,
│  │                    graceful shutdown, /metrics, /openapi.json
│  ├─ worker/           Исполнитель job'ов: submit/poll/cancel, скачивание артефактов,
│  │                    планировщик канареек, refresh-планировщик авторизаций.
│  │                    В одиночном режиме поднимается внутри gateway (in-process).
│  └─ cli/              omniproxy: provider init|try|validate|trust|migrate|list,
│                       capture record|import|analyze, auth add|list|refresh,
│                       probe, doctor, serve, job get|cancel
├─ packages/
│  ├─ schema/       [+] Zod-схемы, общие для всех: provider.yaml, конфиг, UMR/UMS,
│  │                    Job, Artifact. Генерирует provider.schema.json и types.
│  │                    Отдельный пакет, чтобы cli/capture/core не тянули друг друга.
│  ├─ core/             Домен и ядро без единого знания о провайдерах:
│  │                    ├─ umr/         UMR, UMS-события, нормализация параметров
│  │                    ├─ capability/  модель возможностей, матчинг require→кандидат
│  │                    ├─ registry/    загрузка деклараций, реестр моделей и алиасов
│  │                    ├─ router/      alias → упорядоченный список кандидатов
│  │                    ├─ scheduler/   выбор канала/аккаунта, квоты, cooldown, breaker
│  │                    ├─ session/     sticky-сессии, recovery-история (порт из server.js)
│  │                    ├─ context/     bounded prompt, стратегии сжатия (порт)
│  │                    ├─ tools/       text-tool-protocol: инжекция, парсинг, ремонт (порт)
│  │                    ├─ jobs/        job-модель, идемпотентность,машина состояний
│  │                    ├─ errors/      типизированные ошибки, классификация retryable
│  │                    └─ ports/       интерфейсы: HttpClient, MediaStore, Repository,
│  │                                    JobQueue, Clock, Secrets, CaptchaSolver
│  ├─ engine-declarative/ [+] Движок деклараций: шаблонизатор {{}}, подмножество JSONPath,
│  │                    исполнитель flow, парсеры framing (sse/ndjson/json-patch/ws/poll),
│  │                    реестр transforms (ADR-0002 уровень 2).
│  │                    Отдельно от core: core не должен знать про YAML.
│  ├─ module-loader/[+] Обнаружение модулей провайдеров ВНЕ репозитория:
│  │                    ~/.omniproxy/providers/*, --provider-dir, $OMNIPROXY_PROVIDER_PATH.
│  │                    Граница доверия (декларация = данные, adapter.ts = код по согласию),
│  │                    запуск код-адаптеров в worker_threads, миграции schemaVersion.
│  │                    Встроенные провайдеры грузятся ТЕМ ЖЕ загрузчиком. См. ADR-0003.
│  ├─ sdk/          [+] Публичный пакет для авторов модулей: типы AdapterCtx/UMR/UMS,
│  │                    хелперы контрактных тестов, каркасы по модальностям для
│  │                    omniproxy provider init. Единственное, что автор модуля импортирует.
│  ├─ protocols/        Входящие диалекты, каждый — чистый транслятор:
│  │                    openai/ (chat, responses, images, audio, videos),
│  │                    anthropic/ (messages), google/ (generateContent),
│  │                    native/ (jobs, artifacts, capabilities, providers, accounts),
│  │                    legacy/ (/reset-session, /v1/sessions — обратная совместимость)
│  ├─ transport/        HttpClient: три уровня (undici | tls-client sidecar | playwright),
│  │                    профили отпечатка, cookie-jar с персистентностью на аккаунт,
│  │                    привязка прокси к аккаунту, per-host rate limit, ретраи
│  ├─ auth/             Харвестеры: cdp/, extension/, manual-import/, playwright-login/.
│  │                    Credential-store (AES-256-GCM), refresh-планировщик, валидация
│  ├─ antibot/          Плагины: pow-wasm (порт lib/pow.js), pow-js, signature-header,
│  │                    детекторы turnstile/recaptcha/arkose, интерфейс CaptchaSolver,
│  │                    политика ступенчатой деградации (§6.3)
│  ├─ capture/          HAR-импорт, санитайзер секретов, анализатор последовательностей,
│  │                    diff параметров между прогонами, генератор черновика provider.yaml,
│  │                    сериализация фикстур
│  ├─ testkit/      [+] Record/Replay-харнесс, загрузчик фикстур, фейковые Clock/Http,
│  │                    контрактный раннер для адаптеров, диффер схем (§9).
│  │                    Отдельный пакет, потому что им пользуются и providers, и capture
│  ├─ media/            Скачивание артефактов с CDN, дедупликация, TTL/GC, presigned URL,
│  │                    определение mime по сигнатуре, опциональный транскодинг
│  ├─ observability/    pino-логгер с redaction, prom-метрики, OTel, аудит-журнал
│  ├─ providers/        По папке на провайдера. Минимум: provider.yaml + fixtures/ + README.
│  │                    adapter.ts — только по ADR-0002 уровень 3.
│  │  ├─ deepseek/      [класс A] есть рабочий референс
│  │  ├─ zai/ qwen/ kimi/ mistral/                    [класс B]
│  │  ├─ gemini/ perplexity/ copilot/                 [класс C, ожидается adapter.ts]
│  │  ├─ chatgpt/ claude/ grok/                       [класс D]
│  │  ├─ suno/ udio/                                  [класс F: music]
│  │  ├─ kling/ hailuo/ runway/ luma/ pika/ sora/ veo/[класс F/G: video]
│  │  ├─ midjourney/ flux/ ideogram/ recraft/ leonardo/ [класс E/F: image]
│  │  └─ tripo3d/ meshy/ rodin/                       [класс F: 3d]
│  └─ admin-ui/         SPA: здоровье провайдеров, аккаунты, задачи с превью,
│                       метрики, поиск по traceId, редактор алиасов, playground,
│                       импорт HAR → черновик адаптера
├─ tools/           [+] ─ tls-client-sidecar/ (загрузка и запуск бинарника по платформе)
│                   └─ chrome-extension/ (мульти-доменный экспортёр + рекордер на chrome.debugger)
├─ docs/
│  ├─ architecture.md, adding-a-provider.md, migration-from-freedeepseekapi.md
│  ├─ adr/, providers/<id>.md, authoring-a-provider.md (RU+EN), SECURITY.md, THREAT-MODEL.md
└─ legacy/          [+] текущий server.js целиком, работоспособный, до конца фазы 2
```

## Правила границ (проверяются тестом графа импортов)
- `core` не импортирует `providers`, `engine-declarative`, `transport`, `protocols`.
  Только `schema` и собственные `ports`.
- `providers/*` не импортируют друг друга и не импортируют `core` напрямую —
  только типы из `schema` и `AdapterCtx`.
- `protocols/*` не импортируют `providers/*` и не знают про HTTP-транспорт.
- `capture` не импортирует `providers/*` (иначе генератор начнёт подглядывать в ответы).
- `providers/*` (встроенные и пользовательские) импортируют **только** `@omniproxy/sdk`.
  Импорт любого другого внутреннего пакета — ошибка сборки: иначе пользовательский
  модуль окажется привязан к нашим внутренностям и сломается на первом обновлении.
- Файловую систему за пределами рабочего каталога трогает только `module-loader`
  (обнаружение модулей) и `auth` (credential-store). Ни ядро, ни адаптеры — никогда.

## Каталоги пользователя (вне репозитория)

```
~/.omniproxy/
├─ providers/<id>/        пользовательские модули (ADR-0003), формат идентичен встроенным
├─ credentials/           зашифрованный credential-store (AES-256-GCM)
├─ media/                 артефакты, дедупликация по sha256, GC по TTL
├─ jobs/                  durable-состояние задач (драйвер file)
├─ trust.json             хеши код-адаптеров, которым дано явное согласие
└─ tmp/                   несанитизированный кэш захвата, права 600, TTL 1 час
```
