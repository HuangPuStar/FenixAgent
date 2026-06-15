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
# --target=bun: 输出 Bun 运行时的单文件 bundle
RUN bun build scripts/start-remote-runtime.ts --target=bun --outdir /tmp/bundle

# ── Stage 3: 最小运行时 ────────────────────────
FROM oven/bun:1
WORKDIR /app

ENV NODE_ENV=production

# CCB 运行需要 git 等基础工具
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# 安装 Claude Code (CCB)
RUN bun install -g claude-code-best@2.6.12

COPY --from=build /tmp/bundle/start-remote-runtime.js ./

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

CMD ["bun", "start-remote-runtime.js", "ccb-bun", "--acp"]
