# syntax=docker/dockerfile:1.20
# 钉住 1.20 是为了 deps 阶段的 `COPY --parents`（1.20 起稳定）。

FROM ghcr.io/astral-sh/uv:latest AS uv

# 与 CI（.github/actions/setup/action.yml）固定同一版本：1.4.3 修掉 1.4.2 的
# `bun test --isolate` 崩溃（oven-sh/bun#44599），且 oven/bun:1.4.3 提供 linux/amd64 与 linux/arm64。
# 升级时同步本文件四处 FROM 与 CI pin，避免测试组合与发布组合分叉。
FROM oven/bun:1.4.3 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
# 只取各 workspace 包的 package.json（--parents 保留目录结构）：bun install 只需要它建立依赖图，
# 而 `COPY packages ./packages` 会让任意源码改动都击穿本层、使每次提交都重跑 install。
# `**` 覆盖 workspaces 声明的 packages/* 与 packages/*/* 两层；改 workspaces 层次时同步这里的模式。
COPY --parents packages/**/package.json ./
RUN bun install --frozen-lockfile

FROM deps AS build
ARG GIT_COMMIT_SHA=unknown
COPY tsconfig.json tsconfig.base.json ./
# deps 阶段只带了 package.json，构建（web bundle 与 server bundle）需要完整源码。
# 本层与紧随其后的 RUN 同源失效，不额外损失缓存。
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
# 装配产物（生成物，受版本控制）：apps/web/src/shell/shell-navigation.ts 与
# apps/server/src/bootstrap*.ts 静态 import 它们，缺了 browser bundle 与 server bundle 都解析失败。
COPY apps/generated ./apps/generated
COPY components.json drizzle.config.ts ./
RUN bun run build:web
RUN bun run build:machine-runtime
RUN bun build apps/server/src/entry.ts --target=bun --splitting --packages=external --external '@fenix/logger' --external '@fenix/logger/*' --sourcemap=external --outdir dist --entry-naming index.js \
    --define process.env.GIT_COMMIT_SHA="'${GIT_COMMIT_SHA}'"

############### migration image ###############

FROM deps AS migrate-build
COPY scripts/migrate.ts ./scripts/migrate.ts
RUN bun build scripts/migrate.ts --target=bun --outdir /tmp/migrate-bundle

FROM oven/bun:1.4.3 AS migrate
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
# runner 用字面量 import() 引用装配产物与 web 模块，bun build 会沿这些路径解析并内联，
# 缺任一路径即 "Could not resolve" 构建失败（曾因缺这两行导致迁移镜像构建失败）。
COPY apps/generated ./apps/generated
COPY apps/web/fenix.module.ts ./apps/web/fenix.module.ts
# deps 阶段只剩 package.json，而 runner 同时内联 @fenix/* 与 apps/server 源码，必须补回完整源码。
COPY packages ./packages
RUN bun build db/data-migration-runner.ts --target=bun --outdir /tmp/data-migrate-bundle

FROM oven/bun:1.4.3 AS data-migrate
WORKDIR /app
COPY --from=data-migrate-build /tmp/data-migrate-bundle/data-migration-runner.js ./
CMD ["bun", "data-migration-runner.js"]

############### production image ###############

FROM oven/bun:1.4.3 AS runtime
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
ENV PATH="/opt/.peri-binary:$PATH"
# 记忆插件：launchSpec.plugins 显式包含 hindsight 时
# peri 的 settings.local.json 会开启 hindsight-memory@hindsight-plugin
# 插件内容由远端仓库默认分支决定，Docker 层缓存看不见它：命令串不变就直接复用旧层，
# 于是「重建镜像以拿到新插件」会静默装回旧版本。CACHE_BUST 由工作流按每次构建注入。
ARG CACHE_BUST=unset
RUN echo "hindsight plugin refresh: ${CACHE_BUST}" \
    && peri plugin marketplace add KonghaYao/hindsight-plugin \
    && peri plugin install hindsight-memory
RUN rm -rf /root/.bun/install/cache /tmp/bun-*

COPY --from=build /app/dist ./dist
# 外置依赖保留社区 hook 可见的原始模块；workspace 链接与宿主入口使用同一份安装结果。
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/generated ./apps/generated
COPY --from=deps /app/package.json ./package.json
COPY --from=build /app/tsconfig.json /app/tsconfig.base.json ./
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=migrate-build /tmp/migrate-bundle/migrate.js ./
COPY --from=data-migrate-build /tmp/data-migrate-bundle/data-migration-runner.js ./
COPY drizzle ./drizzle
# 装配 profile：启动时由 assembly-config.ts 按 RCS_APPLICATION_ROOT（本阶段 ENV 已设为 /app）解析
# /app/deploy/assembly/ce.json，缺失会使 main.ts 的顶层 await resolveAssemblyEnv() 抛 ENOENT 直接退出。
COPY deploy/assembly ./deploy/assembly

RUN mkdir -p /root/.peri /app/data /app/workflow /app/workspaces
RUN mkdir -p /app/data/skills /app/.agents/agents /app/.agents/skills
COPY .agents/agents/ /app/.agents/agents/
COPY .agents/skills/ /app/.agents/skills/
COPY scripts/operations/fenix-sandbox-ops.sh /app/fenix-sandbox-ops.sh
RUN chmod +x /app/fenix-sandbox-ops.sh

VOLUME ["/root/.peri", "/app/data", "/app/workflow", "/app/workspaces"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then((r) => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["bun", "dist/index.js"]
