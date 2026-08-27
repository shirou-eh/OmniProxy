# OmniProxy Documentation

**Independent gateway** — not a wrapper around legacy. `legacy/` is a minimal example (41 tests), nothing more.

Choose your language:

- **Русский** — [`ru/`](ru/) — основной язык проекта
- **English** — [`en/`](en/)
- **中文** — [`zh/`](zh/)

Each language has the same 7 files — pick one and you have the full instruction:

| File | What it tells you |
|---|---|
| `quickstart.md` | Install → first token → first request (Docker *or* pnpm) |
| `architecture.md` | How UMR/UMS, engine, gateway and discovery fit together |
| `provider.md` | Add your own service without a fork (`provider.yaml`) |
| `auth.md` | Where `accounts.json` lives, 0600, `auth add/list/remove/path` |
| `dialect.md` | Write your own protocol (`DialectPlugin`, 40 lines) |
| `deployment.md` | Docker Compose `restart: unless-stopped`, systemd, `HOST/PORT`, healthcheck |
| `legal.md` | ToS, bans, what we never do |

Quick links:

- `README.md` (root, RU main), `README.en.md`, `README.zh.md` — copy-paste quick start
- `CHANGELOG.md` — what changed in 0.1.0…0.1.4
- `assets/banner.svg` / `assets/avatar.svg` — MD3 Expressive, purple rocket
- `providers/deepseek-web/` — the only shipped declaration (`unverified` — honest)

No logs here — this docs is for users. Internal history lives in `CHANGELOG.md` only.
