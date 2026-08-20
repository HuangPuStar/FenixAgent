FROM ghcr.io/astral-sh/uv:latest AS uv

FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM deps AS build
ARG GIT_COMMIT_SHA=unknown
COPY tsconfig.json tsconfig.base.json ./
COPY src ./src
COPY web ./web
COPY components.json drizzle.config.ts ./
RUN bun run build:web
RUN bun build src/index.ts --target=bun --sourcemap=external --outdir dist \
    --define process.env.GIT_COMMIT_SHA="'${GIT_COMMIT_SHA}'"

############### migration image ###############

FROM deps AS migrate-build
COPY scripts/migrate.ts ./scripts/migrate.ts
RUN bun build scripts/migrate.ts --target=bun --outdir /tmp/migrate-bundle

FROM oven/bun:1 AS migrate
WORKDIR /app
COPY --from=migrate-build /tmp/migrate-bundle/migrate.js ./
COPY drizzle ./drizzle
CMD ["bun", "migrate.js"]

############### production image ###############

FROM oven/bun:1 AS runtime
WORKDIR /app

COPY --from=uv /uv /uvx /usr/local/bin/

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn
ENV RCS_HOST=0.0.0.0
ENV RCS_PORT=3000
ENV DATABASE_URL=postgres://rcs:rcs@postgres:5432/rcs
ENV BUN_INSTALL_GLOBAL=/root/.bun
ENV PATH=/root/.bun/bin:${PATH}
ENV RCS_CCB_COMMAND=peri
ENV RCS_CCB_ARGS=acp
ENV IS_PERI=1

# Install Python 3 and common tools (Debian/glibc base, use TUNA mirror)
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list 2>/dev/null; \
    apt-get update

RUN apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv \
       curl jq git ripgrep zip unzip \
       tzdata

RUN rm -rf /var/lib/apt/lists/*

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone

RUN printf '[global]\nindex-url = %s\ntrusted-host = %s\n' \
    "$PIP_INDEX_URL" "$PIP_TRUSTED_HOST" > /etc/pip.conf
RUN printf 'registry=%s\n' \
    'https://registry.npmmirror.com/' > /root/.npmrc

# replace node/npm/npx with bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/node \
    && ln -sf /usr/local/bin/bun /usr/local/bin/npm \
    && ln -sf /usr/local/bin/bunx /usr/local/bin/npx
COPY install.js /usr/local/bin/install-peri.js
RUN PERI_INSTALL_DIR=/opt/.peri-binary bun /usr/local/bin/install-peri.js
ENV PATH=/opt/.peri-binary:/root/.bun/bin:${PATH}
RUN rm -rf /root/.bun/install/cache /tmp/bun-*

COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=migrate-build /tmp/migrate-bundle/migrate.js ./
COPY drizzle ./drizzle

RUN mkdir -p /app/data /app/workflow /app/workspaces
RUN mkdir -p /app/data/skills /app/.agents/agents /app/.agents/skills
COPY .agents/agents/ /app/.agents/agents/
COPY .agents/skills/ /app/.agents/skills/
COPY fenix-sandbox-ops.sh /app/fenix-sandbox-ops.sh
RUN chmod +x /app/fenix-sandbox-ops.sh

VOLUME ["/app/data", "/app/workflow", "/app/workspaces"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then((r) => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "dist/index.js"]
