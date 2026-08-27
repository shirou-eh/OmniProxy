FROM docker.io/library/node:22-alpine AS build

WORKDIR /app

# pnpm — then deps before sources for layer cache.
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/schema/package.json packages/schema/package.json
COPY packages/umr/package.json packages/umr/package.json
COPY packages/transport/package.json packages/transport/package.json
COPY packages/provider-sim/package.json packages/provider-sim/package.json
COPY packages/engine-declarative/package.json packages/engine-declarative/package.json
COPY packages/capture/package.json packages/capture/package.json
COPY packages/dialect-openai/package.json packages/dialect-openai/package.json
COPY packages/dialect-anthropic/package.json packages/dialect-anthropic/package.json
COPY packages/dialect-gemini/package.json packages/dialect-gemini/package.json
COPY packages/dialect-ollama/package.json packages/dialect-ollama/package.json
COPY packages/gateway/package.json packages/gateway/package.json
COPY apps/cli/package.json apps/cli/package.json

RUN pnpm install --frozen-lockfile

# Sources (excluding legacy — not shipped in this image).
COPY tsconfig.base.json turbo.json ./
COPY packages packages
COPY apps apps
COPY providers providers

RUN pnpm run build

# --- runtime ---------------------------------------------------------------
FROM docker.io/library/node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    OMNIPROXY_HOME=/home/omniproxy/.omniproxy

WORKDIR /app

RUN adduser -D -u 1000 omniproxy \
 && mkdir -p /home/omniproxy/.omniproxy \
 && chown 1000:1000 /home/omniproxy/.omniproxy

COPY --from=build --chown=1000:1000 /app/package.json ./package.json
COPY --from=build --chown=1000:1000 /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build --chown=1000:1000 /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build --chown=1000:1000 /app/packages ./packages
COPY --from=build --chown=1000:1000 /app/apps ./apps
COPY --from=build --chown=1000:1000 /app/providers ./providers
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules

USER 1000:1000

EXPOSE 8787

VOLUME ["/home/omniproxy/.omniproxy"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "const http=require('http');const req=http.get({host:'127.0.0.1',port:process.env.PORT||8787,path:'/health'},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1)})"]

ENTRYPOINT ["node", "apps/cli/dist/main.js"]
CMD ["serve"]
