<!-- Русский ниже / Russian below -->

# OmniProxy

A universal relay that puts a standard API (OpenAI / Anthropic / Gemini / Ollama
compatible) in front of provider **web interfaces** — the same endpoints your logged-in
browser talks to — across every modality: text, images, video, audio, music, speech
and 3D.

> **Status: rework in progress (the gateway runs).** `omniproxy serve` answers
> OpenAI-, Anthropic-, Gemini- and Ollama-shaped requests over any provider module,
> with an account pool and streaming.
> **No provider has been verified against its live service yet** — every declaration is
> `unverified` and runs end to end only against a protocol-faithful local simulator, so
> whether the real service still behaves this way today is unknown. The proxy with real
> mileage on it remains the original one under [`legacy/`](legacy/). This README will
> not claim otherwise until each piece is real and tested.

## What works right now

**The original FreeDeepseekAPI** — an OpenAI-compatible local proxy over the DeepSeek
web chat, with an account pool, session recovery and text-emulated tool calling.
Its own documentation is [`legacy/README.md`](legacy/README.md).

```bash
pnpm install
pnpm run legacy:start
```

**The OmniProxy gateway.** One server in front of every provider module found,
speaking four client protocols at once over the same accounts:

| Endpoint | Protocol |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1beta/models/<model>:generateContent` | Gemini (and `:streamGenerateContent`) |
| `POST /api/chat`, `POST /api/generate` | Ollama (NDJSON, plus `/api/tags` and `/api/show`) |

Streaming and non-streaming on all four. Point any client at it — the SDKs, `curl`,
an editor plugin, or any of the local-first tools that speak Ollama and nothing else:

```bash
omniproxy serve --accounts ./accounts.json
# OPENAI_BASE_URL=http://127.0.0.1:8787/v1       OPENAI_API_KEY=unused
# ANTHROPIC_BASE_URL=http://127.0.0.1:8787       ANTHROPIC_API_KEY=unused
# GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787   GEMINI_API_KEY=unused
# OLLAMA_HOST=http://127.0.0.1:8787
```

The four protocols share one conversation model, one account pool and one request
loop, so the same conversation reaches the provider as a byte-identical prompt
whichever SDK sent it — there is a test that asserts exactly that. A key, when you set
one, is accepted as `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`,
whichever your client sends.

It binds to loopback, and a non-loopback bind without `--api-key` is refused rather
than warned about — anything that can reach the port can spend your accounts. Sharing
one gateway with a team is supported; doing it anonymously is not.

The accounts file maps a provider id to one account or to a pool:

```json
{
  "deepseek-web": { "token": "…" },
  "qwen-web": [
    { "id": "work",     "fields": { "token": "…" } },
    { "id": "personal", "fields": { "token": "…" } }
  ]
}
```

A request tries one account and moves to the next **only if the first fails before the
provider has started answering** — after that the message has been spent, and a second
attempt would spend another. One account and a hundred take the same code path.

**The capture pipeline and engine.** A provider is described by a `provider.yaml` and
executed by generic code — no adapter is written from a guess, only from recorded
traffic (§12.1).

```bash
omniproxy provider list                    # every module found, and where it came from
omniproxy provider validate deepseek-web   # errors apart from warnings
omniproxy capture record deepseek-web --auth ./auth.json
omniproxy capture sanitize <bundle>        # then, and only then, share it
omniproxy capture analyze <bundle>         # what each call does, and how values flow
omniproxy provider draft <bundle>          # a provider.yaml draft, TODOs and all
```

`providers/deepseek-web/provider.yaml` is the first real declaration. Its status is
`unverified`, and that word is exact: every shape in it comes from the working legacy
client, the whole flow runs end to end against a protocol-faithful local simulator, and
**nothing has been confirmed against the live service**. See
[`docs/providers/deepseek-web.md`](docs/providers/deepseek-web.md).

**839 tests**, on Windows and Linux, including golden parity tests that run the same
DeepSeek stream frames — and the same conversations and tool-call markup — through the
real legacy parser and the new engine, and compare them byte for byte.

Authentication files now live next to the legacy server. **If you upgraded from
FreeDeepseekAPI and had `deepseek-auth.json` in the repository root, move it to
`legacy/deepseek-auth.json`** (or point `DEEPSEEK_AUTH_PATH` at it). Nothing else
about the legacy server changed — not one line of its code was edited during the move.

## Where the project is going

| Document | What it settles |
|---|---|
| [`docs/omniproxy/00-risks.md`](docs/omniproxy/00-risks.md) | What is likely to fail, assessed honestly |
| [`docs/omniproxy/01-monorepo.md`](docs/omniproxy/01-monorepo.md) | Package layout and boundary rules |
| [`docs/omniproxy/02-provider-yaml.md`](docs/omniproxy/02-provider-yaml.md) | The provider declaration format |
| [`docs/omniproxy/03-interfaces.ts`](docs/omniproxy/03-interfaces.ts) | Core type contracts |
| [`docs/omniproxy/04-phase-1-plan.md`](docs/omniproxy/04-phase-1-plan.md) | The build journal, PR by PR: the capture pipeline, then the gateway |
| [`docs/omniproxy/05-reliability-charter.md`](docs/omniproxy/05-reliability-charter.md) | Ten invariants, each with a test |
| [`docs/omniproxy/06-hackability-charter.md`](docs/omniproxy/06-hackability-charter.md) | Your right to rewire any of it |
| [`docs/omniproxy/adr/`](docs/omniproxy/adr/) | Every contested decision and why it went that way |

Two principles run through all of it:

- **Reliability over speed.** A good car is not the fastest one; it is the one that
  will not let you down when it matters. One broken provider never takes down the
  gateway, no error arrives without a concrete action to take, and started work is
  never silently lost.
- **You are in charge.** Everything is overridable, your own directories shadow ours,
  data stays in open formats, there is no telemetry, and a dangerous-but-legal setting
  gets one clear warning and then does what you asked.

## Development

```bash
pnpm install     # workspace: packages/*, apps/*, legacy
pnpm run build
pnpm run test    # new packages (vitest) and the legacy suite (node:test)
pnpm run typecheck
```

Windows and Linux are both first-class and tested on every commit (ADR-0005).
Build tooling telemetry is disabled in CI; to disable Turborepo's locally as well:
`pnpm exec turbo telemetry disable`.

## Legal & ToS

OmniProxy drives provider web interfaces using **your own** logged-in sessions. That
violates the terms of service of most of those services, and **your accounts can be
suspended or banned**. Use it with accounts you own and are willing to risk. The
project deliberately does not implement bulk account registration, use of other
people's credentials, or circumvention of paid limits.

MIT licensed. No telemetry, no feature gating, no hosted component.

---

# OmniProxy (по-русски)

Универсальный ретранслятор: единый стандартный API (совместимый с OpenAI / Anthropic /
Gemini / Ollama) поверх **веб-интерфейсов** провайдеров — тех самых эндпоинтов, в
которые ходит ваш залогиненный браузер — для всех модальностей: текст, изображения,
видео, аудио, музыка, речь, 3D.

> **Статус: идёт переработка (шлюз работает).** `omniproxy serve` отвечает на запросы
> в форматах OpenAI, Anthropic, Gemini и Ollama поверх любого модуля провайдера — с
> пулом аккаунтов и потоковой отдачей. **Ни один провайдер ещё не проверен против живого сервиса**: все
> декларации имеют статус `unverified` и прогоняются целиком только против
> протокольно достоверного локального симулятора, так что ведёт ли себя настоящий
> сервис так же сегодня — неизвестно. Прокси с реальным пробегом по-прежнему исходный,
> в [`legacy/`](legacy/). Этот README не будет утверждать обратного, пока каждая часть
> не станет реальной и покрытой тестами.

## Что работает сейчас

**Исходный FreeDeepseekAPI** — локальный OpenAI-совместимый прокси поверх веб-чата
DeepSeek: пул аккаунтов, восстановление сессий, текстовая эмуляция tool-calling.
Его собственная документация — [`legacy/README.md`](legacy/README.md).

```bash
pnpm install
pnpm run legacy:start
```

**Шлюз OmniProxy.** Один сервер поверх всех найденных модулей провайдеров, говорящий
на четырёх клиентских протоколах сразу и поверх одних и тех же аккаунтов:

| Эндпоинт | Протокол |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1beta/models/<model>:generateContent` | Gemini (и `:streamGenerateContent`) |
| `POST /api/chat`, `POST /api/generate` | Ollama (NDJSON, плюс `/api/tags` и `/api/show`) |

Потоково и нет — на всех четырёх. Направьте на него любой клиент: SDK, `curl`, плагин
редактора или любой из локальных инструментов, которые умеют только Ollama.

```bash
omniproxy serve --accounts ./accounts.json
# OPENAI_BASE_URL=http://127.0.0.1:8787/v1       OPENAI_API_KEY=unused
# ANTHROPIC_BASE_URL=http://127.0.0.1:8787       ANTHROPIC_API_KEY=unused
# GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:8787   GEMINI_API_KEY=unused
# OLLAMA_HOST=http://127.0.0.1:8787
```

У четырёх протоколов общая модель диалога, общий пул аккаунтов и общий цикл запроса,
поэтому один и тот же диалог доходит до провайдера побайтно одинаковым промптом,
каким бы SDK его ни отправили — на это есть отдельный тест. Ключ, если вы его
зададите, принимается как `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` или
`?key=` — смотря что шлёт ваш клиент.

Слушает loopback. Привязка к внешнему адресу без `--api-key` **отклоняется**, а не
сопровождается предупреждением: всё, что дотягивается до порта, тратит ваши аккаунты.
Общий шлюз на команду — поддерживаемый сценарий; анонимный общий шлюз — нет.

Файл аккаунтов сопоставляет id провайдера с одной учёткой или с пулом:

```json
{
  "deepseek-web": { "token": "…" },
  "qwen-web": [
    { "id": "work",     "fields": { "token": "…" } },
    { "id": "personal", "fields": { "token": "…" } }
  ]
}
```

Запрос пробует один аккаунт и переходит к следующему **только если первый упал до того,
как провайдер начал отвечать** — после этого сообщение уже списано, и второй заход
списал бы второе. Один аккаунт и сотня идут по одному и тому же коду.

**Конвейер захвата и движок.** Провайдер описывается файлом `provider.yaml` и
исполняется общим кодом. Адаптер никогда не пишется по догадке — только по записанному
трафику (§12.1).

```bash
omniproxy provider list                    # что нашлось и откуда
omniproxy provider validate deepseek-web   # ошибки отдельно от предупреждений
omniproxy capture record deepseek-web --auth ./auth.json
omniproxy capture sanitize <bundle>        # и только после этого делиться
omniproxy capture analyze <bundle>         # что делает каждый вызов и как текут значения
omniproxy provider draft <bundle>          # черновик provider.yaml, вместе с TODO
```

`providers/deepseek-web/provider.yaml` — первая настоящая декларация. Её статус
`unverified`, и это слово точное: все формы взяты из работающего legacy-клиента, весь
поток целиком прогоняется против протокольно достоверного локального симулятора, и
**против живого сервиса не подтверждено ничего**. Подробности —
[`docs/providers/deepseek-web.md`](docs/providers/deepseek-web.md).

**839 тестов**, на Windows и Linux, включая golden-тесты, которые гоняют одни и те же
кадры потока DeepSeek — и те же диалоги и ту же разметку tool-call — через настоящий
парсер legacy и через новый движок и сравнивают результат побайтно.

Файлы авторизации теперь лежат рядом с legacy-сервером. **Если вы обновляетесь с
FreeDeepseekAPI и у вас был `deepseek-auth.json` в корне репозитория — перенесите его
в `legacy/deepseek-auth.json`** (или укажите `DEEPSEEK_AUTH_PATH`). Больше в
legacy-сервере не изменилось ничего: при переносе не правилась ни одна строка кода.

## Куда идёт проект

Таблица документов — выше, в английской части; все они написаны по-русски.
Сквозных принципа два:

- **Надёжность важнее скорости.** Хорошая машина — не та, что едет быстро, а та, что
  не подведёт в критический момент. Сломанный провайдер никогда не роняет шлюз, ни
  одна ошибка не приходит без конкретного действия для человека, начатая работа не
  теряется молча.
- **Пользователь — закон.** Всё переопределяется, ваши каталоги затеняют наши, данные
  в открытых форматах, телеметрии нет, а опасная, но законная настройка получает одно
  внятное предупреждение — и исполняется.

## Юридическая рамка

OmniProxy работает с веб-интерфейсами провайдеров через **ваши личные** сессии. Это
нарушает пользовательские соглашения большинства таких сервисов, и **ваши аккаунты
могут быть заблокированы**. Используйте только те учётные записи, которыми вы готовы
рискнуть. Проект сознательно не реализует массовую регистрацию аккаунтов, использование
чужих учётных данных и обход платных лимитов.

Лицензия MIT. Ни телеметрии, ни функций за флагом лицензии, ни облачной части.
