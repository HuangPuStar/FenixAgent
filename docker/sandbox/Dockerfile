# ── Opencode Sandbox 运行时 (Node.js) ────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app/workspaces

ENV NODE_ENV=production

# Opencode 运行需要的系统工具
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list 2>/dev/null; \
    apt-get update
RUN apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv \
       curl jq git ripgrep zip unzip
RUN rm -rf /var/lib/apt/lists/*

# 安装 Opencode 和 ACP Runtime CLI
RUN npm install -g opencode-ai@1.17.12 @fenix-agent/acp-runtime-cli@0.2.1

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

ENV AGENT_TYPE=opencode
# acp-runtime 启动 opencode agent 并注册到 RCS
CMD ["acp-runtime", "opencode", "acp"]
