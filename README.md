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

首次启动后，系统会自动创建管理员账号 `admin@fenix.com`。初始密码会写入 `RCS_SYSTEM_ADMIN_PASSWORD_FILE`，默认路径是 `data/password.txt`。

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

首次启动后，系统会自动创建管理员账号 `admin@fenix.com`。初始密码会写入 `RCS_SYSTEM_ADMIN_PASSWORD_FILE`，默认路径是 `data/password.txt`。

## 开发

开发流程、提交前检查、测试约定和代码贡献方式，统一参考 [CONTRIBUTING.md](CONTRIBUTING.md)。

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

#### Docker（推荐，Linux）

```bash
# 构建镜像
docker build -f docker/machine/Dockerfile -t fenix-machine .

# 启动，自动向 RCS 注册
docker run -d \
  --name fenix-machine \
  --add-host host.docker.internal:host-gateway \
  -e RCS_URL=ws://host.docker.internal:3000 \
  -e RCS_SECRET=your-secret \
  -e RCS_TENANT_ID=org_xxx \
  -e RCS_LABELS=production,gpu \
  fenix-machine
```

如果 RCS 不在宿主机上，可将 `RCS_URL` 改成实际地址（如 `ws://10.0.0.12:3000`），此时通常不需要 `--add-host`。

其中几个 RCS 相关环境变量的含义如下：

| 变量 | 含义 | 如何取值 |
|------|------|---------|
| `RCS_URL` | machine 回连的 RCS WebSocket 基地址 | 如果 RCS 跑在宿主机上，填 `ws://host.docker.internal:3000`；如果跑在其他机器上，填实际可访问地址，如 `ws://10.0.0.12:3000` 或 `wss://rcs.example.com` |
| `RCS_SECRET` | machine 注册到 RCS 时使用的共享密钥 | 必须与 RCS 服务端的 `REGISTRY_SECRET` 完全一致 |
| `RCS_TENANT_ID` | machine 注册到哪个组织（tenant / organization）下 | 填 RCS 中目标组织的真实 ID，例如 `org_xxx` 或数据库中的组织主键；不能随便填显示名称 |
| `RCS_LABELS` | machine 的标签列表，供调度和筛选使用 | 逗号分隔字符串，例如 `production,gpu`、`machine-a,test`；可选，不填时默认 `remote-runtime` |

`RCS_URL`、`RCS_SECRET`、`RCS_TENANT_ID` 是启动 machine runtime 的必填项；缺少其中任意一个，容器会直接退出。

多机验收测试（同时启动两台）：
```bash
RCS_TENANT_ID=org_xxx REGISTRY_SECRET=test-secret-2026 \
docker compose -f docker/machine/docker-compose.yml up -d --build
```
