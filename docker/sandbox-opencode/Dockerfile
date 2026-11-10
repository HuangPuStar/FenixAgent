# ── 本地构建 acp-runtime-cli（不依赖 npm 发布的 @fenix-agent/acp-runtime-cli）──
FROM oven/bun:1 AS acp-runtime-build
WORKDIR /build
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile
# 安全上传包含 C 文件资源，必须按目录输出并完整交付。
RUN bun build packages/acp-runtime-cli/src/bin.ts --target=bun \
    --outdir /tmp/acp-runtime/dist --entry-naming acp-runtime.js

# ── Opencode Sandbox 运行时 (Node.js) ────────────────────────
FROM ghcr.io/astral-sh/uv:latest AS uv

FROM node:22-bookworm-slim
WORKDIR /app/workspaces

COPY --from=uv /uv /uvx /usr/local/bin/

ENV NODE_ENV=production

# Opencode 运行需要的系统工具
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list 2>/dev/null; \
    apt-get update
RUN apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv \
       curl jq git ripgrep zip unzip
RUN rm -rf /var/lib/apt/lists/*
RUN printf 'registry=%s\n' \
    'https://registry.npmmirror.com/' > /root/.npmrc

# bun 运行时：本地构建的 bundle 使用 Bun.serve，需以 bun 执行
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=acp-runtime-build /tmp/acp-runtime/dist/ /usr/local/bin/

# 安装 Opencode / Hindsight 插件
RUN npm install -g opencode-ai@1.17.12
RUN opencode plugin @konghayao/opencode-hindsight -g

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

ENV AGENT_TYPE=opencode
# acp-runtime 启动 opencode agent 并注册到 RCS
CMD ["bun", "/usr/local/bin/acp-runtime.js", "opencode", "acp"]
