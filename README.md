<!-- Русский ниже / Russian below -->

# OmniProxy

A universal relay that puts a standard API (OpenAI / Anthropic / Gemini compatible) in
front of provider **web interfaces** — the same endpoints your logged-in browser talks
to — across every modality: text, images, video, audio, music, speech and 3D.

> **Status: rework in progress (phase 0).** The gateway described in
> [`docs/omniproxy/`](docs/omniproxy/) does not exist yet. What works today is the
> original single-provider proxy, kept intact under [`legacy/`](legacy/).
> This README will not claim otherwise until each piece is real and tested.

## What works right now

The original **FreeDeepseekAPI** — an OpenAI-compatible local proxy over the DeepSeek
web chat, with an account pool, session recovery and text-emulated tool calling.
Its own documentation is [`legacy/README.md`](legacy/README.md).

```bash
pnpm install
pnpm run legacy:start
```

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
| [`docs/omniproxy/04-phase-1-plan.md`](docs/omniproxy/04-phase-1-plan.md) | The capture pipeline, PR by PR |
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
Gemini) поверх **веб-интерфейсов** провайдеров — тех самых эндпоинтов, в которые ходит
ваш залогиненный браузер — для всех модальностей: текст, изображения, видео, аудио,
музыка, речь, 3D.

> **Статус: идёт переработка (фаза 0).** Шлюза, описанного в
> [`docs/omniproxy/`](docs/omniproxy/), пока не существует. Работает исходный
> одно-провайдерный прокси, сохранённый нетронутым в [`legacy/`](legacy/).
> Этот README не будет утверждать обратного, пока каждая часть не станет реальной
> и покрытой тестами.

## Что работает сейчас

Исходный **FreeDeepseekAPI** — локальный OpenAI-совместимый прокси поверх веб-чата
DeepSeek: пул аккаунтов, восстановление сессий, текстовая эмуляция tool-calling.
Его собственная документация — [`legacy/README.md`](legacy/README.md).

```bash
pnpm install
pnpm run legacy:start
```

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
