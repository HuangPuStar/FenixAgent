FROM oven/bun:1 AS web-builder

WORKDIR /build
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --cwd packages/opensandbox-cluster build:web

FROM oven/bun:1

WORKDIR /app

COPY packages/logger ./packages/logger
COPY packages/opensandbox-cluster/package.json ./packages/opensandbox-cluster/package.json
# 页面已构建为静态文件，运行镜像无需安装 UI 源码及其依赖。
RUN bun -e 'const path = "packages/opensandbox-cluster/package.json"; const pkg = await Bun.file(path).json(); delete pkg.dependencies["@fenix/ui-components"]; delete pkg.devDependencies; await Bun.write(path, JSON.stringify(pkg));'
RUN echo '{"private":true,"workspaces":["packages/*"]}' > package.json && bun install --production

WORKDIR /app/packages/opensandbox-cluster

COPY packages/opensandbox-cluster/skills ./skills

COPY --from=web-builder /build/packages/opensandbox-cluster/dist/web ./dist/web

COPY packages/opensandbox-cluster/src ./src
COPY packages/opensandbox-cluster/drizzle ./drizzle
COPY packages/opensandbox-cluster/drizzle.config.ts ./drizzle.config.ts

ENV NODE_ENV=production
ENV LOG_FORMAT=json
ENV LOG_DIR=/data/logs

CMD ["bun", "run", "src/index.ts"]
