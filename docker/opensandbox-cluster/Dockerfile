FROM oven/bun:1

WORKDIR /app

COPY packages/opensandbox-cluster/package.json ./package.json
RUN bun install --production

COPY packages/opensandbox-cluster/src ./src
COPY packages/opensandbox-cluster/drizzle ./drizzle
COPY packages/opensandbox-cluster/drizzle.config.ts ./drizzle.config.ts

ENV NODE_ENV=production

CMD ["bun", "run", "src/index.ts"]
