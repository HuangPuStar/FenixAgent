# ── 本地构建 acp-runtime-cli（不依赖 npm 发布的 @fenix-agent/acp-runtime-cli）──
FROM oven/bun:1 AS acp-runtime-build
WORKDIR /build
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile
# bundle 为独立 JS（含 acp-link 与 workspace 引擎依赖），运行时只需 bun
RUN bun build packages/acp-runtime-cli/src/bin.ts --target=bun \
    --outfile /tmp/acp-runtime/dist/bin.js

# ── CCB Sandbox 运行时 (Node.js) ────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app/workspaces

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

# 安装 Claude Code (CCB)
RUN npm install -g claude-code-best@2.8.1

# 安装 CCB Hindsight 记忆插件
RUN ccb plugin marketplace add vectorize-io/hindsight && ccb plugin install hindsight-memory

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

RUN alias claude='ccb'

ENV AGENT_TYPE=ccb
# IS_PERI=1 时额外生成 .peri/settings.json（Peri 客户端模式），默认 0
ENV IS_PERI=0
# acp-runtime 启动 CCB agent 并注册到 RCS
CMD ["bun", "/usr/local/bin/acp-runtime.js", "ccb", "--acp"]
