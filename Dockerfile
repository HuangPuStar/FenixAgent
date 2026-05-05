FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY components.json ./
RUN bun run build:web
RUN bun build src/index.ts --outfile=dist/server.js --target=bun

# Install opencode in a separate stage, then copy only the binary
FROM base AS opencode-build
RUN bun install -g opencode-ai@latest --registry=https://registry.npmmirror.com \
    && rm -rf /root/.bun/install/cache /tmp/bun-*


############### production image ###############

FROM oven/bun:1 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV RCS_HOST=0.0.0.0
ENV RCS_PORT=3000
ENV RCS_DB_PATH=/app/data/rcs.db
ENV BUN_INSTALL_GLOBAL=/root/.bun
ENV PATH=/root/.bun/bin:${PATH}
ENV OPENCODE_DISABLE_AUTOUPDATE=1
ENV OPENCODE_DISABLE_TELEMETRY=1

# Install Python 3 and common tools (Debian/glibc base, use TUNA mirror)
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list 2>/dev/null; \
    apt-get update \
    && apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv \
       curl git \
    && rm -rf /var/lib/apt/lists/*

# Copy the glibc variant of opencode binary (Debian uses glibc, not musl)
RUN --mount=type=bind,from=opencode-build,target=/tmp/opencode-build \
    cp "$(find /tmp/opencode-build/root/.bun/install/global/node_modules/ \
      -path '*/opencode-linux-*/bin/opencode' ! -path '*-musl*' | head -1)" \
      /usr/local/bin/opencode

RUN bun install -g acp-link acpx peri-cli \
    && rm -rf /root/.bun/install/cache /tmp/bun-*

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /app/data /root/.config/opencode /root/.agents/skills /root/.local/share/opencode /workspaces /app/workflow
COPY .agent/skills/ /root/.agents/skills/

VOLUME ["/app/data", "/root/.config/opencode", "/root/.agents/skills", "/root/.local/share/opencode", "/workspaces"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then((r) => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

  
RUN peri-cli install acpx-g && peri-cli add-env

COPY prod-start.sh ./

CMD ["sh", "prod-start.sh"]
