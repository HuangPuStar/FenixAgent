# ── CCB Sandbox 运行时 (Node.js / Peri) ────────────────────────
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

# 安装 Claude Code (CCB) 和 ACP Runtime CLI
RUN npm install -g  @fenix-agent/acp-runtime-cli@0.1.2

RUN curl -fsSL https://raw.githubusercontent.com/konghayao/peri/main/scripts/install.sh | bash

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

ENV AGENT_TYPE=ccb
# Peri 客户端模式，额外生成 .peri/settings.json
ENV IS_PERI=1
# acp-runtime 启动 CCB agent 并注册到 RCS
CMD ["acp-runtime", "peri", "acp"]
