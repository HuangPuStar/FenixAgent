FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile

# 尝试安装 Claude Code Linux ARM64 二进制包（非必选，失败不阻塞构建）
RUN bun install @anthropic-ai/claude-agent-sdk-linux-arm64 2>/dev/null || true

FROM deps AS build
COPY tsconfig.json tsconfig.base.json ./
COPY scripts/start-remote-runtime.ts ./scripts/start-remote-runtime.ts
RUN bun build scripts/start-remote-runtime.ts --target=bun --sourcemap=external --outdir /tmp/bundle

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV BUN_INSTALL_GLOBAL=/root/.bun PATH=/root/.bun/bin:${PATH}
ENV OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_TELEMETRY=1

# 从 deps 阶段复制 node_modules（包含 @anthropic-ai/claude-agent-sdk 等运行时依赖）
COPY --from=deps /app/node_modules ./node_modules

# 安装运行时依赖（失败不阻塞构建）
RUN apt-get update 2>/dev/null && apt-get install -y --no-install-recommends git ripgrep 2>/dev/null || true

# 安装 opencode 和 ccb（使用 npmmirror 国内镜像源绕过网络问题）
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 bun install -g --registry https://registry.npmmirror.com opencode-ai@1.15.10 2>/dev/null || echo "opencode install skipped"
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 bun install -g --registry https://registry.npmmirror.com claude-code-best 2>/dev/null || echo "ccb install skipped"
RUN rm -rf /root/.bun/install/cache /tmp/bun-* /tmp/npm-* 2>/dev/null || true

RUN mkdir -p /root/.config/opencode /root/.local/share/opencode /app/workspaces

# Claude Code CLI 二进制随 SDK 自动管理，无需手动安装

COPY --from=build /tmp/bundle/start-remote-runtime.js ./

ENTRYPOINT ["bun", "start-remote-runtime.js"]
CMD ["opencode", "acp"]
