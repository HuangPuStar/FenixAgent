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

# 安装 Claude Code (CCB) 和 ACP Runtime CLI
RUN npm install -g claude-code-best@2.8.1 @fenix-agent/acp-runtime-cli@0.3.0

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

ENV AGENT_TYPE=ccb
# IS_PERI=1 时额外生成 .peri/settings.json（Peri 客户端模式），默认 0
ENV IS_PERI=0
# acp-runtime 启动 CCB agent 并注册到 RCS
CMD ["acp-runtime", "ccb", "--acp"]
