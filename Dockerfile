FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsconfig.base.json ./
COPY src ./src
COPY web ./web
COPY components.json drizzle.config.ts ./
RUN bun run build:web
RUN bun build src/index.ts --target=bun --sourcemap=external --outdir dist

############### migration image ###############

FROM deps AS migrate-build
COPY scripts/migrate.ts ./scripts/migrate.ts
RUN bun build scripts/migrate.ts --target=bun --outdir /tmp/migrate-bundle

FROM oven/bun:1 AS migrate
WORKDIR /app
COPY --from=migrate-build /tmp/migrate-bundle/migrate.js ./
COPY drizzle ./drizzle
CMD ["bun", "migrate.js"]

############### remote-runtime image ###############

FROM deps AS remote-runtime-build
COPY scripts/start-remote-runtime.ts ./scripts/start-remote-runtime.ts
RUN bun build scripts/start-remote-runtime.ts --target=bun --outdir /tmp/remote-runtime-bundle

FROM oven/bun:1 AS remote-runtime
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
RUN rm -rf /root/.bun/install/cache /tmp/bun-*

RUN printf '#!/bin/sh\nargs="";\nfor a in "$@"; do\n  case "$a" in\n    -y|--yes|-p|--package) ;;\n    *) args="$args $a" ;;\n  esac\ndone\nexec bunx $args\n' > /usr/local/bin/npx \
    && chmod +x /usr/local/bin/npx

COPY --from=remote-runtime-build /tmp/remote-runtime-bundle/start-remote-runtime.js ./

RUN mkdir -p /root/.config/opencode /root/.local/share/opencode /app/workspaces
VOLUME ["/root/.config/opencode", "/root/.local/share/opencode", "/app/workspaces"]

CMD ["bun", "start-remote-runtime.js", "opencode", "acp"]

############### production image ###############

FROM oven/bun:1 AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV RCS_HOST=0.0.0.0
ENV RCS_PORT=3000
ENV DATABASE_URL=postgres://rcs:rcs@postgres:5432/rcs
ENV BUN_INSTALL_GLOBAL=/root/.bun
ENV PATH=/root/.bun/bin:${PATH}
ENV OPENCODE_DISABLE_AUTOUPDATE=1
ENV OPENCODE_DISABLE_TELEMETRY=1

# Install Python 3 and common tools (Debian/glibc base, use TUNA mirror)
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list 2>/dev/null; \
    apt-get update

RUN apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv \
       curl jq git ripgrep zip unzip

RUN rm -rf /var/lib/apt/lists/*


RUN bun install -g opencode-ai@1.15.10 --registry=https://registry.npmmirror.com
RUN bun install -g acp-link --registry=https://registry.npmmirror.com
RUN bun install -g acpx --registry=https://registry.npmmirror.com
RUN bun install -g peri-cli --registry=https://registry.npmmirror.com
RUN rm -rf /root/.bun/install/cache /tmp/bun-*

RUN printf '#!/bin/sh\nargs="";\nfor a in "$@"; do\n  case "$a" in\n    -y|--yes|-p|--package) ;;\n    *) args="$args $a" ;;\n  esac\ndone\nexec bunx $args\n' > /usr/local/bin/npx \
    && chmod +x /usr/local/bin/npx

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=migrate-build /tmp/migrate-bundle/migrate.js ./
COPY drizzle ./drizzle

RUN mkdir -p /root/.config/opencode /root/.local/share/opencode /app/data /app/workflow /app/workspaces
RUN mkdir -p /app/data/skills /app/.agents/agents /app/.agents/skills
COPY .agents/agents/ /app/.agents/agents/
COPY .agents/skills/ /app/.agents/skills/

VOLUME ["/root/.config/opencode", "/root/.local/share/opencode", "/app/data", "/app/workflow", "/app/workspaces"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then((r) => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "dist/index.js"]
