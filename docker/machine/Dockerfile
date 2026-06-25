FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile
# Bun workspace 会把该依赖挂在 package 级 node_modules 的软链接上，machine 镜像
# 需要单独复制该目录，所以先物化一份稳定副本，避免后续 COPY 命中失效软链接。
RUN mkdir -p /tmp/remote-runtime-node_modules/@anthropic-ai \
    && cp -RL /app/packages/acp-link/node_modules/@anthropic-ai/claude-agent-sdk \
      /tmp/remote-runtime-node_modules/@anthropic-ai/claude-agent-sdk

FROM deps AS remote-runtime-build
RUN bun build packages/acp-runtime-cli/src/bin.ts --target=bun --outfile /tmp/remote-runtime-bundle/start-remote-runtime.js

FROM oven/bun:1 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV OPENCODE_DISABLE_AUTOUPDATE=1

# Install common tools (agent runtime dependencies)
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list 2>/dev/null; \
    apt-get update
RUN apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv \
       curl jq git ripgrep zip unzip
RUN rm -rf /var/lib/apt/lists/*

RUN bun install -g opencode-ai@1.15.10 --registry=https://registry.npmmirror.com
RUN bun install -g claude-code-best --registry=https://registry.npmmirror.com
RUN rm -rf /root/.bun/install/cache /tmp/bun-*

RUN printf '#!/bin/sh\nargs="";\nfor a in "$@"; do\n  case "$a" in\n    -y|--yes|-p|--package) ;;\n    *) args="$args $a" ;;\n  esac\ndone\nexec bunx $args\n' > /usr/local/bin/npx \
    && chmod +x /usr/local/bin/npx

# Claude Code SDK (bundled in start-remote-runtime.js, CLI needed at runtime)
COPY --from=deps /tmp/remote-runtime-node_modules/@anthropic-ai/claude-agent-sdk ./node_modules/@anthropic-ai/claude-agent-sdk
COPY --from=remote-runtime-build /tmp/remote-runtime-bundle/start-remote-runtime.js ./

RUN mkdir -p /root/.config/opencode /root/.local/share/opencode /app/workspaces
VOLUME ["/root/.config/opencode", "/root/.local/share/opencode", "/app/workspaces"]

ENV CLAUDE_CODE_CLI_PATH=/app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js
ENV SUPPORTED_ENGINE_TYPES='[{"type":"opencode"},{"type":"ccb"},{"type":"claude-code"}]'

CMD ["bun", "start-remote-runtime.js", "opencode", "acp"]
