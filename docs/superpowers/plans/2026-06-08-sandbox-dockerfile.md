# Sandbox Dockerfile 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建独立的生产级 Agent 运行沙箱镜像，以 `start-remote-runtime.ts` 为核心，基于 Node.js slim，连接远程 RCS 主服务器。

**Architecture:** 三阶段 Dockerfile（deps → build → sandbox），构建上下文为 repo 根目录。运行时为 `node:22-bookworm-slim`，只装 git + ripgrep + opencode。独立 docker-compose.yml 通过环境变量连接 RCS。

**Tech Stack:** Node.js 22, Bun (build-only), opencode-ai, Docker multi-stage build

**Spec:** `docs/superpowers/specs/2026-06-08-sandbox-dockerfile-design.md`

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `docker/sandbox/Dockerfile` | 创建 | 三阶段独立构建 |
| `docker/sandbox/docker-compose.yml` | 创建 | 独立编排，环境变量内嵌 |

---

### Task 1: 创建 Dockerfile

**Files:**
- Create: `docker/sandbox/Dockerfile`

- [ ] **Step 1: 创建 docker/sandbox/ 目录和 Dockerfile**

```dockerfile
# ── Stage 1: 安装依赖 ──────────────────────────
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile \
    && rm -rf /root/.bun/install/cache /tmp/bun-*

# ── Stage 2: 打包 start-remote-runtime ──────────
FROM deps AS build
COPY scripts/start-remote-runtime.ts ./scripts/start-remote-runtime.ts
COPY tsconfig.json tsconfig.base.json ./
# --target=node: 输出 Node.js 兼容的单文件 bundle
# acp-link server.ts 内置 Bun/Node 运行时检测，client 模式（sandbox 场景）
# 只用全局 WebSocket（Node 22 内置），不依赖 ws 库
RUN bun build scripts/start-remote-runtime.ts --target=node --outdir /tmp/bundle

# ── Stage 3: 最小运行时 ────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@1.15.10 \
    && rm -rf /root/.npm/_cacache

COPY --from=build /tmp/bundle/start-remote-runtime.js ./

RUN mkdir -p /app/workspaces
VOLUME ["/app/workspaces"]

CMD ["node", "start-remote-runtime.js", "opencode", "acp"]
```

- [ ] **Step 2: 验证 Dockerfile 语法**

Run: `docker build -f docker/sandbox/Dockerfile -t rcs-sandbox:test --check . 2>&1 || echo "如果 --check 不支持则跳过"`

- [ ] **Step 3: 本地构建测试**

Run: `docker build -f docker/sandbox/Dockerfile -t rcs-sandbox:test .`

Expected: 构建成功，无报错

- [ ] **Step 4: 验证镜像体积**

Run: `docker images rcs-sandbox:test --format "{{.Size}}"`

Expected: ~350-450MB

- [ ] **Step 5: 验证镜像可启动**

Run: `docker run --rm rcs-sandbox:test node -e "console.log('ok')"`

Expected: 输出 `ok`

---

### Task 2: 创建 docker-compose.yml

**Files:**
- Create: `docker/sandbox/docker-compose.yml`

- [ ] **Step 1: 创建 docker-compose.yml**

```yaml
# Sandbox 镜像 — 独立启动，连接远程 RCS 主服务器
# Usage:
#   docker compose -f docker/sandbox/docker-compose.yml build
#   docker compose -f docker/sandbox/docker-compose.yml up -d
#   docker compose -f docker/sandbox/docker-compose.yml up -d --scale sandbox=3

services:
  sandbox:
    build:
      context: ../../
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

- [ ] **Step 2: 验证 compose 配置有效**

Run: `docker compose -f docker/sandbox/docker-compose.yml config`

Expected: 输出完整 YAML 配置，无报错

---

### Task 3: 端到端验证

- [ ] **Step 1: 构建镜像**

Run: `docker compose -f docker/sandbox/docker-compose.yml build`

Expected: 构建成功

- [ ] **Step 2: 启动容器（预期连接失败但进程正常启动）**

Run: `docker compose -f docker/sandbox/docker-compose.yml up 2>&1 | head -20`

Expected: 输出 `RCS (ws://host.docker.internal:3000) 未响应，请先启动 RCS` 后退出（因为本地无 RCS）

- [ ] **Step 3: 清理**

Run: `docker compose -f docker/sandbox/docker-compose.yml down`

---

### Task 4: 提交

- [ ] **Step 1: 提交所有文件**

```bash
git add docker/sandbox/Dockerfile docker/sandbox/docker-compose.yml docs/superpowers/specs/2026-06-08-sandbox-dockerfile-design.md
git commit -m "feat(sandbox): 添加独立 Agent 运行沙箱 Dockerfile 和 docker-compose"
```
