# Changelog

All notable changes to OmniProxy are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-08-27

First tagged release. The gateway runs; every declaration is still `unverified` — see `providers/deepseek-web/provider.yaml` and `docs/providers/deepseek-web.md`.

### Added

- **Gateway** (`packages/gateway`): single HTTP surface for every provider module. Routing (`deepseek-chat` and `deepseek-web/deepseek-chat`), account pool (1..N, invariant ADR-0004), `ConcurrencyGate` per account+channel, commit boundary (retry only before first `content` event), body read-once for side handlers. `POST /v1/chat/completions`, `GET /v1/models`, `GET /health` — honest about `unverified` (§12.10), never leaks secret values (§12.7).
- **Dialects** — four client protocols on the same loop:
  - `dialect-openai` (60 tests) — SSE and JSON, tool emulation via `UMR`
  - `dialect-anthropic` (54 tests) — `system` as field, numbered content blocks, required `max_tokens`, signature-less `thinking`
  - `dialect-gemini` (53 tests) — `:generateContent`/`:streamGenerateContent` via path matcher, `/v1beta/models`, `countTokens` as estimate
  - `dialect-ollama` (41 tests) — NDJSON (stream defaults `true`), `/api/chat`, `/api/generate`, `/api/tags`, `/api/show`, `/api/version` (`0.1.0-omniproxy`)
  - Byte-identical `prompt` from all four endpoints checked by tests (§4).
- **Pluggable dialects** (`DialectPlugin`, `loadDialects`, `--dialect <file|dir>`, PR-13): user JS mounted *before* built-ins, `side` endpoints, sorted dir read (ADR-0005), warning about code execution; 11 `plugin.test.ts` + 18 `dialects.test.ts`.
- **Capture pipeline** (`packages/capture`, `packages/transport`): HAR 1.2 import (header order, SSE frames), sanitizer with stable `{{redacted:kind:n}}` (idempotent, 0600 raw cache TTL 1h), analyzer with graph+reasons, diff, draft `provider.yaml` with `TODO(capture)` rather than guesses.
- **Engine** (`packages/engine-declarative`): `{{path}}` / `{{x?}}` / `{{x|null-if-empty}}` templating, JSONPath subset, `TransformRegistry` (`deepseek-pow-v0`, `uuid-v4` …), `json-patch`/`sse`/`ndjson` framing, `allowedHosts` asserted before request, discovery `--provider-dir` > `$OMNIPROXY_PROVIDER_PATH` > `~/.omniproxy/providers/` > `providers/` with shadowing and `unloadable` isolation (I-1).
- **Provider sim** (`packages/provider-sim`): protocol-faithful DeepSeek local server + real `sha3_wasm_bg.7b9ca65ddd.wasm` (bump allocator) — 23 end-to-end `transport` tests and the `record → sanitize → analyze → draft → replay` close-loop of R-11.
- **Provider declaration** `providers/deepseek-web/provider.yaml` (class A, `unverified`): all shapes from `legacy/server.js`, executed only against sim (§12.1, ADR-0007).
- **CLI** (`apps/cli`): `omniproxy serve`, `provider list|validate|draft`, `capture record|import|sanitize|analyze`; `serve` loopback-default, `timingSafeEqual` key check, CORS loopback-only, `/health` order = mount order.
- **Security**: `sanitize` is blocking (§8.4), CI `secrets-scan` expanded (JWT, cookies, `smidV2`, `hif_*`, `userToken`), accounts file `chmod 600` warning on POSIX, `--dialect` warn-once, `Containerfile` non-root, healthcheck on `/health`.
- **Docs**: `00-risks.md` … `07-writing-a-dialect.md`, ADRs `0001`–`0008`, `README.md` EN+RU with honest `unverified` banner and `Legal & ToS`.

### Changed

- Legacy stack moved to `legacy/` untouched; `legacy/server.js` still the only live-tested proxy — used as golden oracle (`deepseek-parity`) and `legacy:test` (41 tests).

### Known limitations (§12.5 — not TODO-later, but explicit)

- Credential store is a plaintext JSON (`--accounts` / `~/.omniproxy/accounts.json`); encrypted store (DPAPI/libsecret/600 file) is the next PR.
- Browser/CDP recorder for live traffic not yet — declarations stay `unverified`.
- `provider diff|migrate`, `auth add|list|refresh`, `probe`, `doctor`, `job/media`, `/v1/capabilities`, `/metrics`, `tls-client` sidecar — planned, not advertised (CLI `--help` is exact).
- Windows + Linux CI (ADR-0005), deterministic file order, one window still lives on `OneDrive/Desktop` (R-10).

### Tests

- 868 tests total: 827 vitest (`schema` 8, `provider-sim` 15, `capture` 121, `engine-declarative` 166, `umr` 31, `dialect-openai` 60, `dialect-anthropic` 54, `dialect-gemini` 53, `dialect-ollama` 41, `transport` 23, `gateway` 187, `cli` 68) + 41 `legacy` (`node:test`), all green on Windows+Linux, Node 22/24.

[0.1.0]: https://github.com/shirou-eh/OmniProxy/releases/tag/v0.1.0
