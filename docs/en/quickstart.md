# Quickstart — English

## 1. Install

**Docker — set and forget:**

```bash
docker compose up -d && docker compose logs -f
# http://127.0.0.1:8787/health → {"status":"ok"}
```

**pnpm from source (Windows & Linux):**

```bash
git clone https://github.com/shirou-eh/OmniProxy.git && cd OmniProxy
pnpm install --frozen-lockfile && pnpm run build
```

Requires `node >=22`, `pnpm 11.24`.

## 2. First credential

```bash
# interactive (TTY) or --field
node apps/cli/dist/main.js auth add deepseek-web --field token=YOUR_TOKEN
node apps/cli/dist/main.js auth list          # only field names
node apps/cli/dist/main.js auth path          # → ~/.omniproxy/accounts.json
# delete: rm ~/.omniproxy/accounts.json  or: auth remove deepseek-web
```

File: `~/.omniproxy/accounts.json` (`$OMNIPROXY_HOME` overrides), `0700` dir, `0600` file. Never committed.

## 3. Serve

```bash
node apps/cli/dist/main.js serve --port 8787
# env also: HOST=0.0.0.0 PORT=8787 OMNIPROXY_API_KEY=secret node ... serve
# loopback by default; 0.0.0.0 without --api-key is refused
```

## 4. Use any SDK

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 OPENAI_API_KEY=unused \
curl http://127.0.0.1:8787/v1/chat/completions -H content-type:application/json \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
```

Also: `POST /v1/messages` (Anthropic), `POST /v1beta/models/...:generateContent` (Gemini), `POST /api/chat` (Ollama NDJSON). `GET /health|/v1/models|/v1/capabilities` need no key. Key accepted as `Authorization: Bearer` / `x-api-key` / `x-goog-api-key` / `?key=`.

## 5. Diagnose

```bash
node apps/cli/dist/main.js doctor
node apps/cli/dist/main.js doctor --anonymized  # no absolute paths, for issues
node apps/cli/dist/main.js doctor --json | jq
```

## 6. Next

- `provider.md` — add your own service
- `dialect.md` — add your own protocol
- `deployment.md` — systemd, env vars
- `legal.md` — ToS, bans
