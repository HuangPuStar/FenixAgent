# 数据库

> 对应文件：`src/db/index.ts`、`src/db/schema.ts`

## 这个模块干什么

数据库层是所有持久化数据的地基。RCS 使用 PostgreSQL + Drizzle ORM，所有表定义集中在 `schema.ts` 一个文件里，数据库连接在 `index.ts` 中初始化。

## 连接管理

`db/index.ts` 导出 `db`（Drizzle 实例）和 `initDb()`（初始化函数）。连接字符串从 `DATABASE_URL` 环境变量读取，默认 `postgres://rcs:rcs@localhost:5432/rcs`。

`initDb()` 在服务器启动时调用一次（`index.ts` 第 43 行）。

## 表结构总览

`schema.ts` 定义了 44 张表，按领域分组：

### better-auth 用户系统

4 张表，由 better-auth 库自动管理：

| 表 | 说明 |
|----|------|
| `user` | 用户（id、name、email、emailVerified、image） |
| `session` | 浏览器 session（token、过期时间、关联 user、activeOrganizationId） |
| `account` | OAuth 账号（provider、accessToken、password 密码哈希） |
| `verification` | 邮箱验证码 |

> **注意**：密码哈希存储在 `account.password` 字段，不在 `user` 表。

### 多租户组织（better-auth organization 插件）

3 张表：

| 表 | 说明 |
|----|------|
| `organization` | 组织（name、slug、logo、metadata） |
| `member` | 组织成员（userId + role，owner/admin/member） |
| `invitation` | 组织邀请（email、role、status、expiresAt） |

### API Key

| 表 | 说明 |
|----|------|
| `apikey` | per-user API Key（`rcs_` 前缀，SHA-256 哈希存储，支持限流和过期） |

### ACP 运行时

2 张表，记录 Agent 运行状态：

| 表 | 说明 |
|----|------|
| `environment` | Agent 环境（workspace、状态、secret、capabilities、autoStart 等） |
| `agent_session` | 会话（关联 environment、标题、状态、source） |

### 配置系统

6 张表，存储用户的 AI 配置：

| 表 | 说明 |
|----|------|
| `provider` | AI 服务商（name、baseUrl、apiKey、protocol） |
| `model` | AI 模型（挂在 provider 下，modelId、modalities、cost 等 JSONB） |
| `agent_config` | Agent 配置（prompt、modelId、engineType、extra 等 JSONB） |
| `mcp_server` | MCP 服务器（type + config JSONB） |
| `skill` | 技能元数据（内容在文件系统，支持全局 + organization scope） |
| `user_config` | 用户偏好（每个 organization + user 一行，defaultAgent、currentModel 等） |

### 配置关联表

3 张多对多关联表：

| 表 | 说明 |
|----|------|
| `agent_config_skill` | Agent↔Skill 多对多 |
| `agent_config_mcp` | Agent↔MCP Server 多对多 |
| `agent_config_site_app` | Agent↔Site App 多对多 |

### 资源权限

| 表 | 说明 |
|----|------|
| `resource_permission` | 跨组织资源读取授权（resourceType: provider/skill/mcp_server/agent_config，principalType: all/organization） |

### 定时任务

2 张表：

| 表 | 说明 |
|----|------|
| `scheduled_task` | 任务定义（cron 表达式、HTTP 目标 url/method/headers/body、enabled） |
| `task_execution_log` | 执行日志（status、error、duration、taskSnapshot） |

### 知识库

3 张表：

| 表 | 说明 |
|----|------|
| `knowledge_base` | 知识库（name、slug、provider、remoteId、状态） |
| `knowledge_resource` | 知识资源（文件，关联 knowledge_base，sourceType/sourceName/status） |
| `agent_knowledge_binding` | Agent↔知识库绑定（多对多，priority、enabled、config JSONB） |

### IM 通道

3 张表：

| 表 | 说明 |
|----|------|
| `im_channel` | IM 通道一等资源（platform、credentials JSONB、status） |
| `im_channel_route` | 通道路由规则（chatId → environment 映射） |
| `channel_binding` | Hermes 通道绑定（遗留，platform + chatId → agentId） |

### 分享

2 张表：

| 表 | 说明 |
|----|------|
| `share_link` | 分享链接（token、mode、过期时间、accessCount） |
| `share_event_snapshot` | 分享事件快照（events JSONB） |

### MCP 工具缓存

| 表 | 说明 |
|----|------|
| `mcp_tool` | MCP 工具缓存（serverName、toolName、description、inputSchema JSONB） |

### 数据迁移

| 表 | 说明 |
|----|------|
| `data_migrate_record` | 启动时数据迁移执行记录（幂等保证） |

### 注册中心

2 张表：

| 表 | 说明 |
|----|------|
| `machine` | 机器注册（agentName、status、machineInfo/labels JSONB、heartbeat） |
| `registry_event` | 注册事件历史（type、detail JSONB） |

### Agent Sites

| 表 | 说明 |
|----|------|
| `agent_site_app` | Agent Sites 应用映射（remoteAppId、platformToken 凭证、visibility） |

### 工作流引擎

9 张表：

| 表 | 说明 |
|----|------|
| `workflow` | 工作流定义（name、description、latestVersion、storagePath） |
| `workflow_version` | 工作流版本（version 号、filePath、status: draft/published） |
| `workflow_run` | 工作流执行记录（input/output JSONB、stepResults、triggeredBy） |
| `workflow_event` | 工作流事件流（eventId、runId、nodeId、type、metadata JSONB） |
| `workflow_snapshot` | 工作流快照（nodeStates JSONB、dagStatus） |
| `workflow_node_output` | 节点输出（stdout、json、exitCode、size、ref） |
| `workflow_board` | 看板面板（name、isDefault） |
| `workflow_job` | 看板 Job（关联 board + workflow，params JSONB、status：Ready→Running→Suspended→Completed） |
| `workflow_trigger` | Webhook 触发器（type、publicHash、secret、config JSONB） |

## 表间关系

```text
user
 ├── session (1:N, cascade delete)
 ├── account (1:N, cascade delete)
 ├── api_key (1:N)
 ├── environment (1:N, cascade delete)
 │    └── agent_session (1:N, cascade delete)
 ├── provider (1:N, cascade delete)
 │    └── model (1:N, cascade delete)
 ├── agent_config (1:N, cascade delete)
 │    ├── agent_config_skill → skill (M:N, cascade delete)
 │    ├── agent_config_mcp → mcp_server (M:N, cascade delete)
 │    └── agent_config_site_app → agent_site_app (M:N, cascade delete)
 ├── mcp_server (1:N, cascade delete)
 ├── skill (1:N, cascade delete)
 ├── scheduled_task (1:N, cascade delete)
 │    └── task_execution_log (1:N, cascade delete)
 ├── knowledge_base (1:N, cascade delete)
 │    ├── knowledge_resource (1:N, cascade delete)
 │    └── agent_knowledge_binding → knowledge_base (M:N)
 ├── im_channel (1:N, cascade delete)
 │    └── im_channel_route (1:N, cascade delete)
 ├── workflow (1:N, cascade delete)
 │    ├── workflow_version (1:N, cascade delete)
 │    ├── workflow_run (1:N, cascade delete)
 │    │    ├── workflow_event (1:N, via runId)
 │    │    ├── workflow_snapshot (1:N, via runId)
 │    │    └── workflow_node_output (1:N, via runId)
 │    ├── workflow_board (1:N, cascade delete)
 │    │    └── workflow_job (1:N, cascade delete)
 │    └── workflow_trigger (1:N, cascade delete)
 ├── machine (1:N, user_id nullable)
 │    └── registry_event (1:N, cascade delete)
 └── agent_site_app (1:N, cascade delete)

organization
 ├── member (1:N, cascade delete)
 ├── invitation (1:N, cascade delete)
 └── resource_permission (按 organizationId 隔离)

user_config (organizationId PK, userId FK → user)
```

## 迁移流程

RCS 使用 Drizzle ORM 的程序化迁移器，而非 `drizzle-kit` CLI：

```bash
# 1. 修改 src/db/schema.ts 后生成迁移 SQL
bunx drizzle-kit generate --name <描述>  # 生成迁移 SQL 到 drizzle/ 目录

# 2. 开发环境验证
bun run db:push  # 直接同步 schema 到数据库，无迁移追踪记录

# 3. 执行迁移（生产环境）
bun run scripts/migrate.ts  # 或 Docker 中 bun migrate.js
```

**迁移入口**：`scripts/migrate.ts`，使用 `drizzle-orm/postgres-js/migrator` 的 `migrate()` 函数程序化执行迁移，而非 `drizzle-kit migrate` CLI 命令。

**核心逻辑**：
```typescript
// scripts/migrate.ts
import { migrate } from "drizzle-orm/postgres-js/migrator";
const db = drizzle(postgres(connectionString, { max: 1 }));
await migrate(db, { migrationsFolder: "./drizzle" });
```

**幂等性**：已执行的迁移自动跳过（通过 `drizzle.__drizzle_migrations` 追踪表，按 SQL 文件 SHA-256 哈希匹配）。

**Docker 构建**：`bun build scripts/migrate.ts --target=bun` 打包为独立 `migrate.js`，生产镜像包含 `migrate.js` + `drizzle/` 目录。

## 和其他模块的关系

- ← `repositories/*`（通过 Drizzle ORM 操作表）
- ← `services/config/*`（直接操作 6 张配置表 + 3 张关联表）
- ← `auth/better-auth.ts`（better-auth 自动管理 user/session/account/verification + organization/member/invitation）
- ← `auth/api-key-service.ts`（操作 apikey 表）
- ← `services/scheduler.ts`（读取 scheduled_task 表）
- ← `services/knowledge-base.ts`（操作 knowledge 系列表）
- ← `services/workflow/*`（操作 workflow 系列 9 张表）
- ← `routes/registry.ts`（操作 machine + registry_event 表）
- 迁移使用 `scripts/migrate.ts`（drizzle-orm migrator 程序化执行）
