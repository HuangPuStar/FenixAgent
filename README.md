# Mothership

Mothership 一个 ACP Agent的统一后端服务，你可以通过它来控制所有支持 ACP 协议的 Agent，比如 OpenCode、OpenClaw、Claude Code 等。

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
