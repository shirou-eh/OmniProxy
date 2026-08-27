# 快速开始 — 中文

## 1. 安装

**Docker — 一次设置，忘记它：**

```bash
docker compose up -d && docker compose logs -f
# http://127.0.0.1:8787/health → {"status":"ok"}
```

**pnpm 源码（Windows 和 Linux）：**

```bash
git clone https://github.com/shirou-eh/OmniProxy.git && cd OmniProxy
pnpm install --frozen-lockfile && pnpm run build
```

需要 `node >=22`，`pnpm 11.24`。

## 2. 第一个凭证

```bash
# 交互式（TTY）或 --field
node apps/cli/dist/main.js auth add deepseek-web --field token=你的TOKEN
node apps/cli/dist/main.js auth list
node apps/cli/dist/main.js auth path
```

文件：`~/.omniproxy/accounts.json`，`0700` 目录，`0600` 文件。

## 3. 运行

```bash
node apps/cli/dist/main.js serve --port 8787
```

## 4. 任意 SDK

```bash
curl http://127.0.0.1:8787/v1/chat/completions -H content-type:application/json \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}'
```

## 5. 诊断

```bash
node apps/cli/dist/main.js doctor --anonymized
```
