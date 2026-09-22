FROM ghcr.io/astral-sh/uv:latest AS uv

FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM deps AS build
ARG GIT_COMMIT_SHA=unknown
COPY tsconfig.json tsconfig.base.json ./
COPY apps/server ./apps/server
COPY apps/web ./apps/web
# 装配产物（生成物，受版本控制）：apps/web/src/shell/shell-navigation.ts 与
# apps/server/src/bootstrap*.ts 静态 import 它们，缺了 browser bundle 与 server bundle 都解析失败。
COPY apps/generated ./apps/generated
COPY components.json drizzle.config.ts ./
RUN bun run build:web
RUN bun build apps/server/src/main.ts --target=bun --sourcemap=external --outdir dist --entry-naming index.js \
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

############### data migration image ###############

# 数据迁移是发布期的一次性步骤，必须独立于应用容器启动命令执行（§6.3 / §10.6.2）：
# 每个副本各跑一次含文件副作用的迁移不是幂等并发安全。发布顺序：migrate → data-migrate → 部署应用。
# 运行本镜像时必须注入与应用相同的环境变量，并挂载与应用相同的数据卷（/app/data）：迁移会写 skill 目录，
# 卷/路径不一致会留下「记录已落库、应用读不到迁移后文件」且无法靠重跑自愈的状态。
FROM deps AS data-migrate-build
COPY db ./db
COPY apps/server ./apps/server
RUN bun build db/data-migration-runner.ts --target=bun --outdir /tmp/data-migrate-bundle

FROM oven/bun:1 AS data-migrate
WORKDIR /app
COPY --from=data-migrate-build /tmp/data-migrate-bundle/data-migration-runner.js ./
CMD ["bun", "data-migration-runner.js"]

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
ENV RCS_APPLICATION_ROOT=/app
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
# peri：本地执行的默认引擎（`RCS_DEFAULT_ENGINE_TYPE` 缺省的 `peri`），
# 安装方式与 docker/sandbox-peri/Dockerfile 一致；未预装则默认引擎启动即失败。
RUN export PERI_INSTALL_DIR=/opt/.peri-binary && curl -fsSL https://raw.githubusercontent.com/konghayao/peri/main/scripts/install.sh | bash
ENV PATH=/opt/.peri-binary:${PATH}
# 记忆插件：launchSpec.env 带 HINDSIGHT_API_URL 时
# peri 的 settings.local.json 会开启 hindsight-memory@hindsight
RUN peri plugin marketplace add vectorize-io/hindsight
RUN peri plugin install hindsight-memory
RUN rm -rf /root/.bun/install/cache /tmp/bun-*

COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=migrate-build /tmp/migrate-bundle/migrate.js ./
COPY --from=data-migrate-build /tmp/data-migrate-bundle/data-migration-runner.js ./
COPY drizzle ./drizzle
# 装配 profile：启动时由 assembly-config.ts 按 RCS_APPLICATION_ROOT（本阶段 ENV 已设为 /app）解析
# /app/deploy/assembly/ce.json，缺失会使 main.ts 的顶层 await resolveAssemblyEnv() 抛 ENOENT 直接退出。
COPY deploy/assembly ./deploy/assembly

RUN mkdir -p /root/.config/opencode /root/.local/share/opencode /app/data /app/workflow /app/workspaces
RUN mkdir -p /app/data/skills /app/.agents/agents /app/.agents/skills
COPY .agents/agents/ /app/.agents/agents/
COPY .agents/skills/ /app/.agents/skills/
COPY fenix-sandbox-ops.sh /app/fenix-sandbox-ops.sh
RUN chmod +x /app/fenix-sandbox-ops.sh

VOLUME ["/root/.config/opencode", "/root/.local/share/opencode", "/app/data", "/app/workflow", "/app/workspaces"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then((r) => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "dist/index.js"]
