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

# 安装 Claude Code (CCB) 和 ACP Runtime CLI
RUN npm install -g  @fenix-agent/acp-runtime-cli

# 整个 peri（binary + 版本管理 + 配置）安装到 /opt/.peri-binary
RUN export PERI_INSTALL_DIR=/opt/.peri-binary && curl -fsSL https://raw.githubusercontent.com/konghayao/peri/main/scripts/install.sh | bash
ENV PATH="/opt/.peri-binary:$PATH"

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]


ENV AGENT_TYPE=ccb
# Peri 客户端模式，额外生成 .peri/settings.json
ENV IS_PERI=1
# acp-runtime 启动 CCB agent 并注册到 RCS
CMD ["acp-runtime", "peri", "acp"]
