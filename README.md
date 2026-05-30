# FenixAgent

FenixAgent 是一个 ACP Agent的统一后端服务，你可以通过它来控制所有支持 ACP 协议的 Agent，比如 OpenCode、OpenClaw、Claude Code 等。

## 功能

- **统一的Harness支持** — 为 ACP Agent 提供统一的 Harness 支持，使用不同的 Agent 也能保持一致的体验
- **ACP Agent适配** — 可控制所有支持 ACP 协议的 Agent（需要实现 Agent 的适配层）

## 快速开始

### Docker 部署（推荐）

```bash
docker compose up -d --build 
```

默认提供 OpenCode 作为 ACP Agent

### 本地 部署

```bash
bash restart-server.sh
```

需要安装 OpenCode 作为 ACP Agent

### 使用

1、模型页 - 配置模型
2、技能页 - 新增技能，或者手动把技能 cp 到 /root/.agents/skills，后续支持 skill 目录上传
3、MCP页 - 配置MCP来提供额外的工具
4、Agent页 - 配置Agent
5、仪表盘 - 注册环境、启动实例、接入实例对话


## 新机器部署

首次在新机器上部署时，需要先初始化数据库表结构，否则启动会报 `relation "xxx" does not exist` 错误。

```bash
# 1. 确保 PostgreSQL 已运行，并配置 DATABASE_URL
export DATABASE_URL="postgres://rcs:rcs@localhost:5432/rcs"

# 2. 创建数据库（如果还没创建）
createdb -h localhost -U rcs rcs

# 3. 同步数据库表结构（二选一）
#    方式 A：直接推送 schema（适合首次部署 / 开发环境，交互式）
bunx drizzle-kit push
#    方式 B：按迁移文件逐步应用（适合生产环境，非交互式）
bunx drizzle-kit migrate

# 4. 启动服务
bun run start
```

> 如果 `drizzle/` 目录下没有迁移文件（全新项目），先用 `push` 建基线，之后改 schema 时用 `bunx drizzle-kit generate --name xxx` 生成迁移文件。

## 开发

```bash
# 安装依赖
bun install

# 构建前端（更新前端代码后）
bun run build:web

# 开发模式（热重载）
bun run dev

# 类型检查
bun run typecheck

# 运行测试
bun test
```

## acp-link 独立部署

acp-link 是 ACP stdio-to-WebSocket 桥接器，部署在远端机器上，负责将 opencode 等 ACP Agent 子进程桥接到 RCS。

### 架构

```
RCS (Server)                             远端 Machine
┌──────────────────┐                   ┌─────────────────────┐
│ /acp/ws          │◀──── WS ────────│ acp-link (client)    │
│ /acp/relay/:id   │                   │   └── spawn opencode │
└──────────────────┘                   └─────────────────────┘
```

### 部署方式

#### 方式一：Docker（推荐，Linux）

```bash
# 构建镜像
docker build -f docker/machine-agent/Dockerfile -t fenix-machine .

# 启动，自动向 RCS 注册
docker run -d \
  -e ANTHROPIC_API_KEY=sk-xxx \
  -e ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
  fenix-machine \
  --rcs-url ws://<rcs-host>:3000 \
  --rcs-secret your-secret \
  --labels production,gpu \
  -- opencode acp
```

多机验收测试（同时启动两台）：
```bash
ANTHROPIC_API_KEY=sk-xxx ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
REGISTRY_SECRET=test-secret-2026 \
docker compose -f docker-compose.machines.yml up -d --build
```

#### 方式二：直接运行二进制（macOS / Windows / Linux）

无需安装 Bun 或 Node.js。预编译二进制位于 `docker/acp-link/`，或自行编译：

```bash
# 编译（在开发机上）
cd packages/acp-link
bun run compile:mac-arm64      # macOS Apple Silicon
bun run compile:mac-x64        # macOS Intel
bun run compile:linux-x64      # Linux x64
bun run compile:linux-arm64    # Linux ARM64
bun run compile:windows-x64    # Windows x64

# 全平台
bun run compile:all
```

将编译产物拷贝到目标机器，直接运行：

```bash
# macOS
./acp-link-darwin-arm64 \
  --rcs-url ws://10.0.0.1:3000 \
  --rcs-secret your-secret \
  --labels production \
  -- opencode acp

# Windows
acp-link-windows-x64.exe \
  --rcs-url ws://10.0.0.1:3000 \
  --rcs-secret your-secret \
  --labels production \
  -- opencode acp
```

目标机器需要预装 opencode（`bun install -g opencode-ai`）及运行时依赖（Python3、git、ripgrep）。

### CLI 参数

| 参数 | 环境变量 | 说明 |
|------|---------|------|
| `--rcs-url` | `RCS_URL` | RCS 注册中心地址，如 `ws://10.0.0.1:3000` |
| `--rcs-secret` | `RCS_SECRET` | 注册密钥，需与 RCS 侧 `REGISTRY_SECRET` 一致 |
| `--labels` | — | 机器标签，逗号分隔，用于 Agent 绑定 |
| `--tenant-id` | `RCS_TENANT_ID` | 租户 ID（可选） |
| `--user-id` | `RCS_USER_ID` | 用户 ID（可选） |

RCS 服务端需配置 `REGISTRY_SECRET` 环境变量，与各 machine 的 `--rcs-secret` 保持一致。
