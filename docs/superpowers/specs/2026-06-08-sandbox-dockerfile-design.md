# Sandbox Dockerfile 设计

## 目标

为生产环境创建独立的、slim 的 Agent 运行沙箱镜像，以 `start-remote-runtime.ts` 为核心，连接到远程 RCS 主服务器。

## 文件结构

```
docker/sandbox/
├── Dockerfile          # 三阶段独立构建
└── docker-compose.yml  # 独立编排，环境变量内嵌
```

## Dockerfile 设计

### Stage 1: deps

```dockerfile
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile
```

### Stage 2: build

```dockerfile
FROM deps AS build
COPY scripts/start-remote-runtime.ts ./scripts/start-remote-runtime.ts
COPY tsconfig.json tsconfig.base.json ./
RUN bun build scripts/start-remote-runtime.ts --target=node --outdir /tmp/bundle
```

- `--target=node` 确保输出在 Node.js 运行时可执行
- acp-link 的 `server.ts` 内置 Bun/Node 运行时检测，Node 走 `adapter-node.js`

### Stage 3: sandbox

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@1.15.10

COPY --from=build /tmp/bundle/start-remote-runtime.js ./

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

CMD ["node", "start-remote-runtime.js", "opencode", "acp"]
```

- 基础镜像 `node:22-bookworm-slim`（~200MB），自带 `npm`/`npx`
- 只装 `git` + `ripgrep`（opencode agent 基本依赖）
- 不装 Python、curl、jq、zip、unzip
- 不需要 `npx` shim hack

## docker-compose.yml 设计

```yaml
services:
  sandbox:
    build:
      context: ../../          # repo 根目录（需要 packages/ 和 bun.lock）
      dockerfile: docker/sandbox/Dockerfile
    container_name: rcs-sandbox
    restart: unless-stopped
    environment:
      RCS_URL: ws://host.docker.internal:3000
      RCS_SECRET: rcs-registry-secret
      RCS_TENANT_ID: ""
      RCS_USER_ID: ""
      RCS_LABELS: remote-runtime
      AGENT_TYPE: opencode
    volumes:
      - sandbox-workspaces:/app/workspaces

volumes:
  sandbox-workspaces:
```

- `context: ../../` 指向 repo 根（Dockerfile 在 `docker/sandbox/` 下）
- 环境变量全部内嵌，用户按需修改
- `RCS_URL` 默认用 `host.docker.internal` 连接宿主机上的 RCS
- Linux 部署时改为宿主机 IP 或 `network_mode: host`

## 构建 & 运行

```bash
# 构建
docker compose -f docker/sandbox/docker-compose.yml build

# 启动
docker compose -f docker/sandbox/docker-compose.yml up -d

# 多实例
docker compose -f docker/sandbox/docker-compose.yml up -d --scale sandbox=3
```

## 镜像体积预估

- node:22-bookworm-slim: ~200MB
- git + ripgrep: ~50MB
- opencode-ai: ~100MB
- app bundle: ~1MB
- **总计约 ~350-400MB**（vs 现有 remote-runtime ~500-600MB）
