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

补充背景和细节约束见 [CLAUDE.md](CLAUDE.md)。

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

按需补充数据库、鉴权、S3、Hermes 等配置。

### 3. 启动依赖服务

本地开发通常先启动基础依赖：

```bash
docker compose up -d
```

### 4. 初始化数据库

开发环境常用：

```bash
bun run db:push
```

如果你正在验证迁移链路，或需要按迁移文件执行：

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
- `spec/`：需求、设计、验收等过程文档

### 路由结构

- `/v1/code/sessions/*`：Code Session / Worker API，源码在 `src/routes/v2/`
- `/v2/session_ingress/*`：Session bridge 入口
- `/web/*`：控制面板业务 API
- `/acp/*`：ACP WebSocket / relay
- `/mcp/*`：MCP 知识库查询
- `/hooks/*`：Webhook 触发入口

## 开发约定

### 前端

- 不要在 JSX 中硬编码用户可见字符串，统一走 i18n
- 路由跳转使用 TanStack Router，避免直接改 `window.location`
- 修改前端后务必执行 `bun run build:web`
- 使用 `lucide-react` 作为图标来源，不要内联 SVG

### 后端

- 新增 organization 级资源时，注意组织作用域校验
- Skill 写入必须保持数据库和文件系统双同步
- Workspace 路径通过 `resolveWorkspacePath()` 计算，不依赖历史字段
- 文档注释是强制要求：类头部、公共函数、公共方法、导出工具和类型定义必须提供清晰简洁的文档注释
- 长函数和复杂逻辑必须补充代码注释，按处理阶段说明结构，并解释非直观控制流、兼容性约束、临时取舍和关键分支原因
- 业务流程、状态变化、外部调用、异常处理、降级、重试和兜底逻辑必须补齐必要日志，保证出现问题后可以通过日志排查，不要只打印空泛文本
- 数据库操作尽量内聚到对应的 service 文件中，并通过函数统一暴露给其他 service 使用；避免把同一类数据访问逻辑分散到多个地方
- API 需要默认保证向后兼容；新增字段优先兼容旧客户端，删除或修改旧字段语义前必须评估影响；如果新功能难以兼容旧行为，应新增新版本 API，而不是直接破坏原有接口

### 数据库

- `src/db/schema.ts` 是 schema 真相来源
- 不要手写 SQL 迁移
- 修改 schema 后要生成并提交 `drizzle/` 下完整迁移产物
- 生产环境不要使用 `db:push`
- 如果一个功能在开发过程中生成了多个迁移节点，或当前迁移链与远端冲突，需要先在本地整理迁移再提交
- 更详细的 Drizzle 迁移合并、节点压缩和冲突处理规则，见 [drizzle/README.md](drizzle/README.md)

## 测试与质量检查

提交前至少做这些检查：

```bash
bun run precheck
```

如果改动影响后端逻辑，补跑对应后端测试。

如果改动影响前端页面、表单或交互，补跑对应前端测试，并执行：

```bash
bun run build:web
```

`precheck` 会完成这些事情：

- Biome 格式化
- import 排序
- 后端 TypeScript 检查
- 前端 TypeScript 检查
- Biome 静态检查

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

## 新功能开发建议

推荐流程：

1. 先确认需求和影响范围
2. 查现有实现与相邻模块
3. 优先补或改测试
4. 实现代码
5. 运行 `bun run precheck`
6. 如涉及前端，执行 `bun run build:web`
7. 自查文档、迁移和配置是否需要同步更新

## 需要先读的文档

- [README.md](README.md)：项目介绍与快速开始
- [CLAUDE.md](CLAUDE.md)：当前仓库的开发规则与架构说明
- [DESIGN.md](DESIGN.md)：更高层的产品与设计背景

如果你准备长期参与开发，建议把 `CLAUDE.md` 当作团队内开发约定手册来用。
