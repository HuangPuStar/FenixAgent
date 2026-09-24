# ── 本地构建 acp-runtime-cli（不依赖 npm 发布的 @fenix-agent/acp-runtime-cli）──
FROM oven/bun:1 AS acp-runtime-build
WORKDIR /build
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile
# bundle 为独立 JS（含 acp-link 与 workspace 引擎依赖），运行时只需 bun
RUN bun build packages/acp-runtime-cli/src/bin.ts --target=bun \
    --outfile /tmp/acp-runtime/dist/bin.js

# ── CCB Sandbox 运行时 (Node.js / Peri) ────────────────────────
FROM ghcr.io/astral-sh/uv:latest AS uv

FROM node:22-bookworm-slim
WORKDIR /app/workspaces

COPY --from=uv /uv /uvx /usr/local/bin/

ENV NODE_ENV=production

# CCB 运行需要的系统工具（python3/curl/jq/zip/unzip 等）
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
COPY --from=acp-runtime-build /tmp/acp-runtime/dist/bin.js /usr/local/bin/acp-runtime.js

# 与根 Dockerfile 保持同一官方安装方式；该镜像独立构建，不能复用控制面镜像层，故保留此处安装。
RUN export PERI_INSTALL_DIR=/opt/.peri-binary && curl -fsSL https://raw.githubusercontent.com/konghayao/peri/main/scripts/install.sh | bash
ENV PATH="/opt/.peri-binary:$PATH"

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

# peri 的插件存储复用 Claude Code 布局（`~/.claude/plugins`），插件随镜像固化在 /root/.claude。
RUN peri plugin marketplace add vectorize-io/hindsight
RUN peri plugin install hindsight-memory

# peri ultracode 依赖 workflow 库
RUN npm i -g @peri-code/workflow

# peri 是独立引擎插件（@fenix/peri）：节点直接以 peri handler 启动 peri CLI。
# 不再走「ccb 槽位跑 peri」，因此也不需要 IS_PERI 与 RCS_CCB_COMMAND/RCS_CCB_ARGS——
# workspace 物化由 peri handler 完成，`.peri/settings.json` 无条件写出。
ENV AGENT_TYPE=peri
# acp-runtime 启动 peri agent 并注册到 RCS
CMD ["bun", "/usr/local/bin/acp-runtime.js", "peri", "acp"]
