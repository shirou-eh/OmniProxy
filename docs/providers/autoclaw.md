# autoclaw (z.ai / AutoGLM desktop backend)

| | |
|---|---|
| **Статус** | `unverified` — разобранный пример, а не провайдер, который мы поддерживаем (ADR-0006) |
| **Класс** | H — бэкенд десктопного приложения (новый класс, ADR-0006) |
| **Канал** | `app-backend` |
| **Источник сведений** | исходный код стороннего прокси `autoclaw-proxy`, присланный заказчиком 2026-08-27 |
| **Захват** | отсутствует |
| **Последняя успешная проверка** | никогда |

## Почему `unverified`, а не `needs-capture`

Правило §12.1 запрещает писать адаптер без захваченного трафика. Присланный рабочий
исходник — свидетельство лучшего качества, чем догадка, но худшего, чем захват:
он даёт эндпоинт, заголовки и карту моделей, но не доказывает, что они актуальны,
что список заголовков полон и что у конкретного пользователя есть файл с токеном.

Поэтому: черновик декларации написать можно (он ниже), в реестр он попадает со
статусом `unverified`, и статус меняется **только** после одного живого прогона либо
захвата. До этого провайдер не участвует в маршрутизации и честно виден в
`/v1/capabilities` как непроверенный.

## Что известно из исходника

### Эндпоинт
```
POST https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/chat/completions
```

### Авторизация — двухсоставная
- `Authorization: Bearer autoclaw-internal-proxy` — **константа**, вшитая в приложение.
  Не персональный секрет; редактированию при санитизации не подлежит, это структура.
- `X-Authorization: <JWT>` — персональный токен. Читается из
  `~/.openclaw-autoclaw/request-headers.json`, путь `$.headers.X-Authorization`.
  Обновляется самим десктопным приложением, собственный refresh не нужен — нужен
  наблюдатель за файлом.

### Отпечаток клиента
`X-Client-Type: pc`, `X-Product: autoclaw`, `X-Harness-Type: zcode`, `X-Tm: win`,
`X-Version: 1.17.8`, `X-Lang`, `X-Channel: official`, `x_trace_id: autoclaw-desktop`,
`X-Request-Id` (UUID на запрос), `X-Request-Model` (дублирует модель в заголовке).

`X-Version` — точка протухания: при обновлении приложения бэкенд, скорее всего,
начнёт отвергать старую версию. Это первый подозреваемый при внезапной поломке.

### TLS
Комментарий автора: WAF (Aliyun edge) пропускает **только отпечаток Node/undici**;
Python httpx получает 405. То есть здесь нужен профиль `node-undici`, а не браузерный —
случай, обратный Cloudflare-провайдерам.

### Модели
| Клиентское имя | Бэкенд |
|---|---|
| `auto` | `zai_auto` |
| `glm-5-turbo` | `zai_glm-5-turbo` |
| `glm-5.3`, `glm-coding`, `zaicoding-glm-5.3` | `zaicoding_glm-5.3` |
| `glm-5.3-flash` | `zai_glm-5.3-flash` |

Исходник принимает также префиксы `zai/` и `autoclaw/`, а неизвестную модель молча
подменяет на `zai_glm-5.3-flash`. **Мы так делать не будем** (см. ADR-0006): тихая
подмена модели — худший вид неожиданности для клиента.

### Формат ответа
Бэкенд отдаёт SSE в OpenAI-совместимом виде: `data: {...}` с `choices[].delta`,
завершение `data: [DONE]`. В дельтах встречаются `content`, `reasoning_content`,
`tool_calls`, `function_call`. Есть `usage`, если клиент его запросил.

Существование `tool_calls` в потоке — **важное отличие от веб-каналов**: если это
подтвердится живым прогоном, то `toolCalling` здесь может оказаться `native`, а не
`text-emulated`. Это первый кандидат на такое значение во всём проекте, и его придётся
добавить в модель capability. Проверяется только экспериментом.

## Черновик декларации

Не исполнялся. Движок деклараций появится в PR-4; до тех пор это документ, а не код.

```yaml
schemaVersion: 1
id: autoclaw
displayName: AutoClaw (z.ai desktop backend)
class: H
status: unverified
channels:
  - id: desktop
    kind: app-backend
    base: https://autoglm-api.autoglm.ai
    fingerprint:
      profile: node-undici
      static:
        x-client-type: pc
        x-product: autoclaw
        x-harness-type: zcode
        x-tm: win
        x-version: "1.17.8"
        x-channel: official
        x_trace_id: autoclaw-desktop
        accept: "*/*"
auth:
  kind: local-file
  harvest:
    file:
      win32: "%USERPROFILE%\\.openclaw-autoclaw\\request-headers.json"
      linux: "$HOME/.openclaw-autoclaw/request-headers.json"
      darwin: "$HOME/.openclaw-autoclaw/request-headers.json"
    extract: { token: $.headers.X-Authorization }
    watch: true
  present:
    headers:
      authorization: "Bearer autoclaw-internal-proxy"   # константа приложения
      x-authorization: "{{auth.token}}"
vars:
  requestId: { transform: uuid-v4 }
flow:
  send:
    request:
      method: POST
      path: /autoclaw-proxy/proxy/autoclaw/chat/completions
      headers:
        x-request-id: "{{vars.requestId}}"
        x-request-model: "{{req.model}}"
      json:
        stream: true
        model: "{{req.model}}"
        messages: "{{req.messages}}"
    stream:
      format: sse
      doneWhen: { data: "[DONE]" }
      map:
        text:      $.choices[0].delta.content
        reasoning: $.choices[0].delta.reasoning_content
        toolCalls: $.choices[0].delta.tool_calls
        finish:    $.choices[0].finish_reason
        usage:     $.usage
context:
  strategy: native-messages      # бэкенд принимает массив сообщений, схлопывать не нужно
models:
  - { alias: glm-5.3,       native: zaicoding_glm-5.3 }
  - { alias: glm-5.3-flash, native: zai_glm-5.3-flash }
  - { alias: glm-5-turbo,   native: zai_glm-5-turbo }
  - { alias: auto,          native: zai_auto }
probe:
  request: { prompt: "reply with exactly: OK" }
  expect: { contains: "OK", maxLatencyMs: 30000 }
```

`context.strategy: native-messages` — редкий случай: массив сообщений принимается как
есть, схлопывать историю в одну строку не нужно и вредно.

## Что нужно, чтобы снять статус `unverified`

1. Один живой прогон на аккаунте с установленным приложением.
2. Проверить полноту заголовков: убрать по одному и посмотреть, что ломается.
   `X-Version` и `X-Product` — главные подозреваемые.
3. Проверить, действительно ли нужен профиль `node-undici` (отправить с браузерным
   отпечатком и посмотреть на 405).
4. Измерить: практический `contextChars`, дневную квоту, поведение при исчерпании.
5. Проверить `tool_calls` в потоке — от этого зависит значение capability.

## Юридическая рамка

Тот же класс, что и весь проект: работа с личным аккаунтом пользователя через
интерфейс, не предназначенный для сторонних клиентов. Нарушает условия
использования; аккаунт может быть заблокирован. Константа
`autoclaw-internal-proxy` — внутренний идентификатор приложения, а не чужой секрет,
но её использование сторонним клиентом ToS не одобряет тем более.
