# Свой диалект: протокол, которого у нас нет

Шлюз говорит на четырёх протоколах — OpenAI, Anthropic, Gemini, Ollama — потому что эти
четыре стоило написать. На пятом он заговорит потому, что его напишете вы. Без форка, без
патча, без пул-реквеста, который ждёт нашего ревью.

Встроенные четыре монтируются ровно тем же способом, что и ваш: это обычные
`DialectPlugin`, и в `server.ts` нет ни одной привилегированной ветки, до которой плагин
не дотягивается. Это проверяется тестом (`packages/gateway/test/plugin.test.ts`), а не
обещается на словах.

## Что такое диалект

Диалект — это перевод. В одну сторону: чужой формат запроса → **UMR**, универсальный
запрос (диалог, плоский промпт, канонические ручки). В другую: **UMS**, поток
универсальных событий → чужой формат ответа.

Всё, что между, — общее и вам писать не нужно:

| Что | Кто делает |
|---|---|
| маршрутизация модели на провайдера | `resolveRoute` |
| выбор аккаунта и переход к следующему | `AccountPool` |
| ограничение одновременных запросов | `ConcurrencyGate` |
| правило ретрая и граница коммита | цикл запроса в `server.ts` |
| исполнение декларации провайдера | `@omniproxy/engine-declarative` |

Отсюда практическое следствие: диалект — это обычно **три функции и сорок строк**, а не
подсистема.

## Контракт

```ts
interface DialectPlugin {
  name: string;                                        // видно на /health
  dialect: DialectHooks<T>;                            // перевод в обе стороны
  match(path: string, method: string): RouteContext | undefined;
  paths?: readonly string[];                           // для человекочитаемого 404
  side?(request: SideRequest): SideResult | undefined; // эндпоинты без провайдера
}

interface DialectHooks<T> {
  name: string;
  plan(body, providers, context?): RequestPlan<T> | Refusal;
  identity(uuid): { id: string; model: string };
  respond(context: RespondContext<T>): Promise<void>;
  error(error: OmniError): { status: number; body: unknown };
  refuse(status, kind, message, action): Refusal;
}
```

- **`plan`** читает тело, находит маршрут и превращает диалог в один промпт. Возвращает
  либо план, либо отказ, сформулированный **вашими** словами: клиент вашего протокола не
  обязан понимать чужую форму ошибки.
- **`respond`** получает `AsyncGenerator<UMSEvent>` и пишет в `ServerResponse` что
  угодно: SSE, NDJSON, обычный JSON, protobuf, простой текст. Встроенные четыре делают
  первые три, и ничего в цикле запроса про это не знает.
- **`match`** — матчер, а не список путей, потому что Google кладёт модель и операцию
  в URL. Вернуть `{}` значит «мой путь, всё остальное в теле».
- **`side`** — эндпоинты, которые не доходят до провайдера и не тратят сообщение:
  списки моделей, `countTokens`, проверки возможностей. Тело читается **один раз** на
  запрос, сколько бы обработчиков его ни попросило, поэтому заглянуть в тело здесь
  безопасно: цикл запроса получит своё.

## Минимальный рабочий пример

```js
// my-dialect.mjs — компилировать нечего, это уже JavaScript.
import { collectUms } from '@omniproxy/schema';
import { flattenConversation } from '@omniproxy/umr';
import { resolveRoute, RoutingError } from '@omniproxy/gateway';

const refuse = (status, message, action) => ({
  kind: 'refused',
  status,
  body: { problem: message, do: action },
});

const dialect = {
  name: 'plain',

  plan(body, providers) {
    if (!body?.text) return refuse(400, 'нечего сказать', 'Пришлите { model, text }.');
    try {
      const route = resolveRoute(providers, body.model ?? '');
      const { prompt } = flattenConversation([
        { role: 'user', content: [{ type: 'text', text: body.text }] },
      ]);
      return { kind: 'planned', request: body, route, prompt, params: {}, stream: false };
    } catch (error) {
      if (error instanceof RoutingError) return refuse(error.status, error.message, error.userAction);
      throw error;
    }
  },

  identity: () => ({ id: '', model: '' }),

  async respond({ events, response, settle }) {
    const collected = await collectUms(events);
    settle(collected.error);            // обязательно ровно один раз
    response.writeHead(collected.error ? 502 : 200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(collected.error ? collected.error.message : collected.text);
  },

  error: (e) => ({ status: 502, body: { problem: e.message, do: e.userAction } }),
  refuse: (status, kind, message, action) => refuse(status, message, action),
};

export default {
  name: 'plain',
  dialect,
  paths: ['/say'],
  match: (path, method) => (method === 'POST' && path === '/say' ? {} : undefined),
};
```

Запуск:

```bash
omniproxy serve --dialect ./my-dialect.mjs
curl -s localhost:8787/say -d '{"model":"deepseek-chat","text":"привет"}'
```

`--dialect` принимает файл или каталог (каталог читается на один уровень, файлы
сортируются по имени — порядок монтирования одинаков на Windows и на Linux). Флаг
повторяемый. Экспорт может называться `default`, `dialect` или `plugin`.

## Порядок и перекрытие

Ваши плагины монтируются **перед** встроенными. Плагин, который заявил
`/v1/chat/completions`, заменяет наш OpenAI-эндпоинт, а не проигрывает ему. Это
намеренно: шлюз ваш. В лог при этом пишется одна строка о том, что произошло, — и на
этом всё, никаких подтверждений и никаких запретов (см. `06-hackability-charter.md`).

## Чего делать не нужно и что учесть

- **`settle()` вызывается ровно один раз.** Второй вызов посчитает успех дважды или
  дважды отправит аккаунт отдыхать.
- **Не держите состояние между запросами.** Каждый запрос и каждая попытка получают
  свой `StateStore` и свою сессию у провайдера (ADR-0008); диалект, который что-то
  запомнил, воскрешает риск R-6.
- **Слот конкурентности держится до конца ответа**, включая поток. Вам ничего для этого
  делать не нужно — просто не возвращайте управление из `respond`, пока пишете.
- **Ошибка в потоке должна закрывать поток по правилам вашего протокола.** У Ollama это
  запись `done`, у Gemini — `finishReason` в последнем чанке, у SSE — сентинел. Молча
  оборванный сокет любой клиент показывает как «модель замолчала».
- **TypeScript импортировать напрямую нельзя** — Node этого не умеет без загрузчика.
  Скомпилируйте в `.js`; загрузчик скажет об этом прямым текстом, а не упадёт непонятно.
- **Сломанный файл называется и пропускается.** Один плохой модуль не роняет шлюз
  (инвариант I-1), но и не притворяется загруженным.

## Про безопасность, честно

`--dialect` исполняет ваш JavaScript в процессе шлюза, с его правами и его аккаунтами.
Ничего не загружается неявно: ни рабочий каталог, ни `node_modules`, ни «известная
папка», куда что-то постороннее может подложить файл, — только пути, названные в
командной строке. При старте печатается одна предупреждающая строка, и на этом
разговор окончен: предупредить один раз и сделать — это и есть правило (§12 и
`06-hackability-charter.md`).

Загружайте только те файлы, которые написали вы или которым доверяете, как доверяете
любой другой зависимости.

## Где смотреть примеры

Четыре встроенных диалекта — самые полные примеры, какие есть, и они написаны против
того же контракта:

| Протокол | Файлы |
|---|---|
| OpenAI | `packages/dialect-openai/`, `packages/gateway/src/openai.ts` |
| Anthropic | `packages/dialect-anthropic/`, `packages/gateway/src/anthropic.ts` |
| Gemini | `packages/dialect-gemini/`, `packages/gateway/src/gemini.ts` |
| Ollama (NDJSON) | `packages/dialect-ollama/`, `packages/gateway/src/ollama.ts` |

Тест, который держит эту дверь открытой, — `packages/gateway/test/plugin.test.ts`.
