# 数据库

> 对应文件：`src/db/index.ts`、`src/db/schema.ts`

## 这个模块干什么

数据库层是所有持久化数据的地基。RCS 使用 PostgreSQL + Drizzle ORM，所有表定义集中在 `schema.ts` 一个文件里，数据库连接在 `index.ts` 中初始化。

## 连接管理

`db/index.ts` 导出 `db`（Drizzle 实例）和 `initDb()`（初始化函数）。连接字符串从 `DATABASE_URL` 环境变量读取，默认 `postgres://rcs:rcs@localhost:5432/rcs`。

`initDb()` 在服务器启动时调用一次（`index.ts` 第 43 行）。

## 表结构总览

按领域分成几组：

### better-auth 用户系统

4 张表，由 better-auth 库自动管理：

| 表 | 说明 |
|----|------|
| `user` | 用户（id、name、email、password） |
| `session` | 浏览器 session（token、过期时间、关联 user） |
| `account` | OAuth 账号（email/password 模式下存密码哈希） |
| `verification` | 邮箱验证码 |

### ACP 运行时

3 张表，记录 Agent 运行状态：

| 表 | 说明 |
|----|------|
| `environment` | Agent 环境（workspace、状态、secret、capabilities 等） |
| `agent_session` | 会话（关联 environment、标题、状态、权限模式） |
| `api_key` | per-user API Key（`rcs_` 前缀，关联 user） |

### 配置系统（F002）

6 张表，存储用户的 AI 配置：

| 表 | 说明 |
|----|------|
| `provider` | AI 服务商（name、baseUrl、apiKey） |
| `model` | AI 模型（挂在 provider 下，modelId、参数 JSONB） |
| `agent_config` | Agent 配置（prompt、permission JSONB、模型选择） |
| `mcp_server` | MCP 服务器（type + config JSONB） |
| `skill` | 技能元数据（内容在文件系统，支持全局 + workspace scope） |
| `user_config` | 用户偏好（每个用户一行） |

### 定时任务

2 张表：

| 表 | 说明 |
|----|------|
| `scheduled_task` | 任务定义（cron 表达式、关联 environment、task 内容） |
| `task_execution_log` | 执行日志（状态、耗时、错误信息、任务快照） |

### 知识库

3 张表：

| 表 | 说明 |
|----|------|
| `knowledge_base` | 知识库（name、slug、provider、远程 ID、状态） |
| `knowledge_resource` | 知识资源（文件，关联 knowledge_base，状态跟踪） |
| `agent_knowledge_binding` | Agent↔知识库绑定（多对多） |

### Channel

| 表 | 说明 |
|----|------|
| `channel_binding` | 聊天平台→Agent 绑定（platform、chatId、agentId） |

### 分享

| 表 | 说明 |
|----|------|
| `share_link` | 分享链接（token、模式、过期时间） |
| `share_event_snapshot` | 分享事件快照 |

### MCP 工具缓存

| 表 | 说明 |
|----|------|
| `mcp_tool` | MCP 工具缓存（serverName、toolName、inputSchema） |

## 表间关系

```text
user
 ├── session (1:N, cascade delete)
 ├── account (1:N, cascade delete)
 ├── api_key (1:N, cascade delete)
 ├── environment (1:N, cascade delete)
 │    ├── agent_session (1:N, set null on delete)
 │    └── skill (1:N, cascade delete)
 ├── provider (1:N, cascade delete)
 │    └── model (1:N, cascade delete)
 ├── agent_config (1:N, cascade delete)
 ├── mcp_server (1:N, cascade delete)
 ├── scheduled_task (1:N, cascade delete)
 │    └── task_execution_log (1:N, cascade delete)
 ├── knowledge_base (1:N, cascade delete)
 │    ├── knowledge_resource (1:N, cascade delete)
 │    └── agent_knowledge_binding → knowledge_base (M:N)
 ├── channel_binding (独立，agentId 是逻辑外键)
 └── user_config (1:1)
```

## 和其他模块的关系

- ← `repositories/*`（通过 Drizzle ORM 操作表）
- ← `services/config-pg.ts`（直接操作 6 张配置表）
- ← `auth/better-auth.ts`（better-auth 自动管理 user/session/account/verification）
- ← `auth/api-key-service.ts`（操作 api_key 表）
- ← `services/scheduler.ts`（读取 scheduled_task 表）
- ← `services/knowledge-base.ts`（操作 knowledge 系列表）
- 迁移使用 Drizzle Kit（`bunx drizzle-kit generate && bunx drizzle-kit migrate`）
