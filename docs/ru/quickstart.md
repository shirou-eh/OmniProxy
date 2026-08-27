# Быстрый старт — Русский

## 1. Установка

**Docker — поставил и забыл:**

```bash
docker compose up -d && docker compose logs -f
# http://127.0.0.1:8787/health → {"status":"ok"}
```

**pnpm из исходников (Windows и Linux):**

```bash
git clone https://github.com/shirou-eh/OmniProxy.git && cd OmniProxy
pnpm install --frozen-lockfile && pnpm run build
```

Нужно `node >=22`, `pnpm 11.24`.

## 2. Первая учётка

```bash
# интерактивно (TTY) или --field
node apps/cli/dist/main.js auth add deepseek-web --field token=ВАШ_ТОКЕН
node apps/cli/dist/main.js auth list          # только имена полей
node apps/cli/dist/main.js auth path          # → ~/.omniproxy/accounts.json
# удалить: rm ~/.omniproxy/accounts.json  или: auth remove deepseek-web
```

Файл: `~/.omniproxy/accounts.json` (`$OMNIPROXY_HOME` переопределяет), `0700` папка, `0600` файл. Никогда не коммитится.

## 3. Запуск

```bash
node apps/cli/dist/main.js serve --port 8787
# env тоже: HOST=0.0.0.0 PORT=8787 OMNIPROXY_API_KEY=secret node ... serve
# loopback по умолчанию; 0.0.0.0 без --api-key отклоняется
```

## 4. Любой SDK

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 OPENAI_API_KEY=unused \
curl http://127.0.0.1:8787/v1/chat/completions -H content-type:application/json \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"привет"}]}'
```

Также: `POST /v1/messages`, `POST /v1beta/models/...:generateContent`, `POST /api/chat`. `GET /health|/v1/models|/v1/capabilities` без ключа. Ключ: `Authorization: Bearer` / `x-api-key` / `x-goog-api-key` / `?key=`.

## 5. Диагностика

```bash
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js doctor --anonymized
```

## 6. Дальше

- `provider.md` — подключить свой сервис
- `dialect.md` — свой протокол
- `deployment.md` — systemd, env
- `legal.md` — ToS, баны
