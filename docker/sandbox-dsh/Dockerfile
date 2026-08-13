# ── 本地构建 acp-runtime-cli（不依赖 npm 发布的 @fenix-agent/acp-runtime-cli）──
FROM oven/bun:1 AS acp-runtime-build
WORKDIR /build
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile
# bundle 为独立 JS（含 acp-link 与 workspace 引擎依赖），运行时只需 bun
RUN bun build packages/acp-runtime-cli/src/bin.ts --target=bun \
    --outfile /tmp/acp-runtime/dist/bin.js

# ── dsh Sandbox 运行时 (Node.js / DeepSeek Harness) ──────────
FROM node:22-bookworm-slim
WORKDIR /app/workspaces

ENV NODE_ENV=production

# dsh 运行需要的系统工具（python3/curl/jq/zip/unzip 等）
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

# 安装 DeepSeek Harness ACP demo（automation-only ACP server，JSON-RPC stdio）。
# @deepseek-ai/dsh-acp-demo 的 latest dist-tag 停在旧版 0.0.1-rc.1，必须精确指定版本。
RUN npm install -g @deepseek-ai/dsh-acp-demo@0.1.0-rc.6 --no-audit --no-fund

# dsh 伪装为 ccb 槽位的启动 wrapper（解析 ccb settings → 生成 cordis.yml → 启动 dsh）
COPY docker/sandbox-dsh/scripts/dsh-acp-wrapper.js /usr/local/bin/dsh-acp-wrapper.js

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

ENV AGENT_TYPE=ccb
# acp-runtime 以 ccb handler 启动 wrapper；wrapper 内部再 exec dsh-acp-demo
CMD ["bun", "/usr/local/bin/acp-runtime.js", "node", "/usr/local/bin/dsh-acp-wrapper.js"]
