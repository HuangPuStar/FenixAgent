# FenixAgent

FenixAgent 是一个 ACP Agent的统一后端服务，你可以通过它来控制所有支持 ACP 协议的 Agent，比如 OpenCode、OpenClaw、Claude Code 等。

## 功能

- **统一的Harness支持** — 为 ACP Agent 提供统一的 Harness 支持，使用不同的 Agent 也能保持一致的体验
- **统一的资源管理** — 为 ACP Agent 提供统一的 模型、技能、工具、知识库等资源 的配置和注入，可以在同一套资源配置下使用不同的 Agent，不需要对不同的 Agent 做重复配置
- **ACP Agent适配** — 可控制所有支持 ACP 协议的 Agent（需要实现 Agent 的适配层）

## 快速开始

### Docker 部署（推荐）

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

默认提供 OpenCode 作为 ACP Agent

默认服务启动在 http://localhost:3001/

### 本地 开发 部署

```bash
# 使用 docker 启动服务依赖的 postgres 等
docker compose up -d

# 安装依赖（有更新时候执行）
bun install

# 同步数据库表结构（有更新时候执行）
bun db:migrate

# 本地启动服务
bash restart-server.sh
```

需要安装 OpenCode 作为 ACP Agent

默认服务启动在 http://localhost:3000/

### 使用

- 模型页 - 配置模型
- 技能页 - 配置技能
- MCP页 - 配置MCP来提供额外的工具
- 组织页 - 配置组织和成员关系 
- 智能体 - 配置和使用 Agent，进入 Agent 会话
- 设置 - 其他非常用功能
- 组织切换 - 切换不同组织，以使用不同资源

## 开发

开发前

```bash
# 安装依赖（有更新时候执行）
bun install

# 同步数据库表结构（有更新时候执行）
bun db:migrate
```

开发中

```bash
# 构建前端（更新前端代码后）
bun run build:web

# 开发模式（热重载）
bun run dev

# 服务快捷启动脚本，包含上面那两个命令
bash restart-server.sh
```

开发完待提交

```bash
# 代码检查（提交前必做）
bun precheck

# 运行测试（提交前必做）
bun test
```

## acp-link 独立部署（分布式执行节点）

acp-link 是 ACP stdio-to-WebSocket 桥接器，部署在远端机器上，负责将 opencode 等 ACP Agent 子进程桥接到 RCS。

### 架构

```
RCS (Server)                             远端 Machine
┌──────────────────┐                   ┌──────────────────────┐
│ /acp/ws          │◀──── WS ────────  │ acp-link (client)    │
│ /acp/relay/:id   │                   │   └── spawn opencode │
└──────────────────┘                   └──────────────────────┘
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
