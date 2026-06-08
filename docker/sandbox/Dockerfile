# ── Stage 1: 安装依赖 ──────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile \
    && rm -rf /root/.bun/install/cache /tmp/bun-*

# ── Stage 2: 打包 start-remote-runtime ──────────
FROM deps AS build
COPY scripts/start-remote-runtime.ts ./scripts/start-remote-runtime.ts
COPY tsconfig.json tsconfig.base.json ./
# --target=node: 输出 Node.js 兼容的单文件 bundle
# acp-link server.ts 内置 Bun/Node 运行时检测，client 模式（sandbox 场景）
# 只用全局 WebSocket（Node 22 内置），不依赖 ws 库
RUN bun build scripts/start-remote-runtime.ts --target=node --outdir /tmp/bundle

# ── Stage 3: 最小运行时 ────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@1.15.10 \
    && rm -rf /root/.npm/_cacache

COPY --from=build /tmp/bundle/start-remote-runtime.js ./

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

CMD ["node", "start-remote-runtime.js", "opencode", "acp"]
