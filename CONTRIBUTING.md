# Contributing to FenixAgent

本文档面向准备参与 FenixAgent 开发的同学，重点说明本地环境、开发流程、测试和提交约定。

## 适用范围

- 想在本地跑起服务并开始开发
- 想了解仓库结构、常用命令和提交前检查
- 想提交功能、修复问题或补充测试

如果你只是想快速体验项目，先看 [README.md](README.md)。

## 技术栈概览

- 后端：Bun + Elysia
- 前端：React 19 + Vite + TanStack Router
- 数据库：PostgreSQL + Drizzle ORM
- 鉴权：better-auth
- 实时通信：ACP WebSocket / Relay
- Monorepo：根目录 `package.json` + `packages/*`

## 参考规范

- [README.md](README.md)：项目介绍与快速开始
- [CLAUDE.md](CLAUDE.md)：全局补充约束与项目级细节说明
- [DESIGN.md](DESIGN.md)：更高层的产品与设计背景
- [前端开发规范](docs/developer/guide/frontend-development.md)：前端目录结构、路由导航、状态管理、组件、API、i18n 和样式规范
- [后端开发规范](docs/developer/guide/backend-development.md)：后端目录分层、数据库、API、注释和日志规范
- [drizzle/README.md](drizzle/README.md)：Drizzle 迁移合并、冲突处理与数据迁移边界说明

## 开发前准备

### 1. 安装依赖

建议准备以下环境：

- Bun
- Node.js
- Docker 与 Docker Compose
- PostgreSQL

安装项目依赖：

```bash
bun install
```

### 2. 准备环境变量

以 `.env.example` 为基础创建本地配置：

```bash
cp .env.example .env
```

按需补充数据库、鉴权等配置。

### 3. 启动依赖服务

本地开发通常先启动基础依赖：

```bash
docker compose up -d
```

### 4. 初始化数据库

开发环境常用：

```bash
bun run db:migrate
```

如果修改了 `src/db/schema.ts`，生成迁移文件：

```bash
bun run db:generate --name <migration-name>
```

## 本地开发

### 启动后端

```bash
bun run dev
```

默认会启动后端服务，并在首次启动时自动创建系统管理员 `admin@fenix.com`。初始密码会写入 `RCS_SYSTEM_ADMIN_PASSWORD_FILE`，默认路径是 `data/password.txt`。

### 启动前端

前端需要单独启动：

```bash
bun run dev:web
```

### 一键启动前后端

如果你希望直接用仓库内脚本启动开发环境，可以执行：

```bash
bash restart-server.sh
```

### 前端构建

修改前端代码后，提交前或需要验证静态产物时必须执行：

```bash
bun run build:web
```

原因：后端会直接托管 `web/dist/`。

## 常用命令

```bash
bun run dev
bun run dev:web
bun run build:web
bun run precheck
bun run check:deps
bun run docs:dev
bun run docs:build
```

测试相关：

```bash
bun test src/__tests__/
bun test src/__tests__/store.test.ts
bun test web/src/__tests__/
bun test web/src/__tests__/config-mcp-page.test.ts
```

## 仓库结构

### 主要目录

- `src/`：后端源码
- `web/`：前端源码
- `packages/`：内部 workspace 包
- `scripts/`：脚本和辅助工具
- `docs/`：文档站点
- `drizzle/`：数据库迁移文件

### 路由结构

- `/web/*`：控制面板业务 API
- `/api/*`：对外 OpenAPI / API Key 接口
- `/acp/*`：ACP WebSocket / relay
- `/mcp/*`：MCP 知识库查询
- `/hooks/*`：Webhook 触发入口

## 开发约定

### 前端

- 详细规范参考 [前端开发规范](docs/developer/guide/frontend-development.md)。
- 涉及页面结构、交互语义和产品设计背景时，补充参考 [DESIGN.md](DESIGN.md)。

### 后端

- 详细规范参考 [后端开发规范](docs/developer/guide/backend-development.md)。
- 迁移合并、节点压缩、生产冲突处理和数据迁移边界，补充参考 [drizzle/README.md](drizzle/README.md)。

## 测试与质量检查

提交前至少做这些检查：

```bash
bun run precheck
```

正式提交前，建议使用项目内的 `fenix-code-review` skill 再做一次 AI 代码审查。

如果使用 Codex / Claude Code 一类支持项目 skill 的 Agent，优先执行：

```text
/fenix-code-review
```

如果需要只审查某个范围，也可以显式指定 `<scope>`，例如文件路径、提交区间或分支 diff 范围。

## 提交规范

项目使用 Angular 风格提交前缀，常见格式：

```text
feat(scope): 新功能
fix(scope): 修复问题
refactor(scope): 重构
test(scope): 补测试
docs(scope): 文档更新
chore(scope): 杂项维护
```

建议：

- 每个提交保持单一职责
- 有代码改动时，提交前先通过 `bun run precheck`
- 涉及 schema 变更时，连同 `drizzle/` 一起提交
- 提交前执行一次 `fenix-code-review` AI 审查

## 新功能开发建议

推荐流程：

1. 先确认需求和影响范围
2. 查现有实现与相邻模块
3. 优先补或改测试
4. 实现代码
5. 运行 `bun run precheck`
6. 如涉及前端，执行 `bun run build:web`
7. 自查文档、迁移和配置是否需要同步更新
8. 提交前执行一次 `fenix-code-review` AI 审查
