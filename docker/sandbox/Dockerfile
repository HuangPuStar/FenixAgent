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

# 安装 Opencode / ACP Runtime CLI / Hindsight 插件
RUN npm install -g opencode-ai@1.17.12
RUN opencode plugin @konghayao/opencode-hindsight -g

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

ENV AGENT_TYPE=opencode
# acp-runtime 启动 opencode agent 并注册到 RCS
CMD ["acp-runtime", "opencode", "acp"]
