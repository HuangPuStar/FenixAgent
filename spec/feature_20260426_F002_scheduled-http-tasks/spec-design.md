# Feature: 20260426_F002 - scheduled-http-tasks

## 需求背景

RCS 目前支持环境管理、配置管理、会话管理等核心功能，但缺少定时任务能力。用户需要在特定时间或周期性地触发 HTTP 请求来执行外部操作（例如定时调用 webhook、定期触发 CI/CD pipeline、定时检查服务健康状态等）。当前只能依赖外部 cron 工具或手动触发，不够便捷。

## 目标

- 提供可视化定时任务管理界面，支持创建、编辑、删除、启停定时任务
- 每个任务定义一次 HTTP 请求触发（URL、方法、Headers、Body）
- 使用 cron 表达式配置调度规则
- 任务定义持久化到 SQLite，服务重启后自动恢复调度
- 记录每次执行的历史（状态码、耗时、响应摘要），支持失败自动重试
- 前端提供任务列表、执行历史、手动触发入口

## 方案设计

### 架构总览

```
前端 TasksPage
        │
        ▼
/web/tasks API (Hono 路由)
        │
        ├── TaskService ←── 业务逻辑层（CRUD + 调度管理）
        │
        ├── SchedulerEngine ←── node-schedule 调度引擎
        │       │
        │       └── 执行 HTTP 请求 → 记录日志到 task_execution_log
        │
        └── SQLite (Drizzle ORM)
                ├── scheduled_task 表（任务定义）
                └── task_execution_log 表（执行记录）
```

### 数据模型

SQLite 新增两张表（Drizzle ORM schema，追加到 `src/db/schema.ts`）：

**`scheduled_task`** — 任务定义：

```typescript
export const scheduledTask = sqliteTable("scheduled_task", {
  id: text("id").primaryKey(),                        // task_xxx
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),                       // 任务名称（用户可读）
  description: text("description"),                   // 可选描述

  // 调度配置
  cron: text("cron").notNull(),                       // 标准 cron 表达式（5 字段）
  timezone: text("timezone").notNull().default("UTC"), // 时区
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

  // HTTP 请求配置
  url: text("url").notNull(),                         // 请求 URL
  method: text("method").notNull().default("GET"),    // GET | POST | PUT | DELETE | PATCH
  headers: text("headers"),                           // JSON string，自定义请求头
  body: text("body"),                                 // JSON string，请求体
  timeout: integer("timeout").notNull().default(30000), // 请求超时（ms）

  // 重试配置
  retryEnabled: integer("retry_enabled", { mode: "boolean" }).notNull().default(false),
  retryCount: integer("retry_count").notNull().default(3),     // 最大重试次数
  retryInterval: integer("retry_interval").notNull().default(60), // 重试间隔（s）

  // 状态
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  nextRunAt: integer("next_run_at", { mode: "timestamp" }),
  lastStatus: text("last_status"),                    // success | failed | pending

  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
```

**`task_execution_log`** — 执行记录：

```typescript
export const taskExecutionLog = sqliteTable("task_execution_log", {
  id: text("id").primaryKey(),                        // log_xxx
  taskId: text("task_id")
    .notNull()
    .references(() => scheduledTask.id, { onDelete: "cascade" }),
  status: text("status").notNull(),                   // success | failed | retrying
  statusCode: integer("status_code"),                 // HTTP 响应状态码
  responseBody: text("response_body"),                // 响应体（截断到 4096 字符）
  error: text("error"),                               // 错误信息
  duration: integer("duration"),                      // 执行耗时（ms）
  attempt: integer("attempt").notNull().default(1),   // 第几次尝试（重试时递增）
  triggeredBy: text("triggered_by").notNull().default("cron"), // cron | manual
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
```

### API 设计

新增路由组 `/web/tasks`（需 `sessionAuth` 中间件）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/web/tasks` | 列出当前用户所有任务 |
| POST | `/web/tasks` | 创建新任务 |
| GET | `/web/tasks/:id` | 获取任务详情 |
| PUT | `/web/tasks/:id` | 更新任务配置 |
| DELETE | `/web/tasks/:id` | 删除任务 |
| POST | `/web/tasks/:id/toggle` | 启用/禁用任务 |
| POST | `/web/tasks/:id/trigger` | 手动触发一次执行 |
| GET | `/web/tasks/:id/logs` | 获取执行历史（分页） |
| DELETE | `/web/tasks/:id/logs` | 清空执行历史 |

#### 创建任务 POST /web/tasks

请求体：

```json
{
  "name": "每日健康检查",
  "description": "检查 API 服务是否在线",
  "cron": "0 9 * * 1-5",
  "timezone": "Asia/Shanghai",
  "url": "https://api.example.com/health",
  "method": "GET",
  "headers": { "Authorization": "Bearer xxx" },
  "body": null,
  "timeout": 10000,
  "retryEnabled": true,
  "retryCount": 3,
  "retryInterval": 60
}
```

响应：

```json
{
  "success": true,
  "data": {
    "id": "task_xxx",
    "name": "每日健康检查",
    "cron": "0 9 * * 1-5",
    "enabled": true,
    "nextRunAt": 1714089600,
    ...
  }
}
```

#### 执行历史 GET /web/tasks/:id/logs?page=1&pageSize=20

响应：

```json
{
  "success": true,
  "data": {
    "total": 42,
    "items": [
      {
        "id": "log_xxx",
        "status": "success",
        "statusCode": 200,
        "responseBody": "{\"status\":\"ok\"}",
        "duration": 230,
        "attempt": 1,
        "triggeredBy": "cron",
        "createdAt": 1714089600
      }
    ]
  }
}
```

### 调度引擎

新增 `src/services/scheduler.ts`，基于 `node-schedule` 封装：

```typescript
import schedule from "node-schedule";

interface ScheduledJob {
  taskId: string;
  job: schedule.Job;  // node-schedule Job 实例
}

// 内存中维护所有活跃的 Job
const activeJobs = new Map<string, ScheduledJob>();

// 核心方法
export function startScheduler(): void;       // 服务启动时加载所有 enabled 任务
export function scheduleTask(task: Task): void;   // 注册单个任务的 cron 调度
export function unscheduleTask(taskId: string): void; // 取消调度
export function rescheduleTask(task: Task): void;     // 更新调度规则
export function stopScheduler(): void;        // 服务关闭时清理所有 Job
```

**任务执行流程**：

1. cron 触发 → 从内存获取任务配置
2. 发起 HTTP 请求（使用 `fetch`，按 `timeout` 设置超时）
3. 记录执行结果到 `task_execution_log`
4. 更新 `scheduled_task.lastRunAt`、`lastStatus`、`nextRunAt`
5. 如果失败且 `retryEnabled=true` 且未达 `retryCount` 上限 → 延迟 `retryInterval` 后重试
6. 重试时 `attempt` 递增，记录 `triggeredBy: "retry"`

**服务启动恢复**：

```
服务启动
    │
    ├── Drizzle 自动建表（CREATE TABLE IF NOT EXISTS）
    │
    └── startScheduler()
            ├── 查询所有 enabled=true 的任务
            └── 逐个调用 scheduleTask() 注册 node-schedule Job
```

**服务关闭清理**：

在 `gracefulShutdown` 中调用 `stopScheduler()`，取消所有 `node-schedule` Job。

### 前端页面设计

新增 `TasksPage` 页面，使用现有的 DataTable + FormDialog 模式。

**导航**：在侧边栏添加「定时任务」导航项（`Clock` 图标），位于 MCP 和 API Key 之间。

**任务列表页**：
- DataTable 展示所有任务
- 列：名称、cron 表达式、HTTP 方法 + URL、状态（启用/禁用）、上次执行、下次执行、操作
- 行操作：手动触发、编辑、删除、启用/禁用切换
- 顶部：创建任务按钮

**创建/编辑表单**（FormDialog）：
- 基本信息：名称（必填）、描述（可选）
- 调度配置：cron 表达式（必填，提供常用表达式快捷选择）、时区（默认 UTC）
- HTTP 配置：
  - URL（必填）
  - 方法（Select：GET/POST/PUT/DELETE/PATCH）
  - Headers（Key-Value 编辑器，可动态增删行）
  - Body（JSON 编辑器，仅 POST/PUT/PATCH 时显示）
  - 超时（数字输入，默认 30s）
- 重试配置：
  - 启用重试（开关）
  - 重试次数（数字输入，默认 3）
  - 重试间隔（数字输入，默认 60s）

**执行历史**：
- 点击任务行展开/跳转到执行历史
- DataTable 展示执行记录
- 列：执行时间、状态（成功/失败）、状态码、耗时、触发方式、操作
- 行操作：查看响应体
- 顶部：清空历史按钮

**常用 cron 快捷选项**：
| 表达式 | 说明 |
|--------|------|
| `*/5 * * * *` | 每 5 分钟 |
| `0 * * * *` | 每小时 |
| `0 9 * * *` | 每天早 9 点 |
| `0 9 * * 1-5` | 工作日早 9 点 |
| `0 0 1 * *` | 每月 1 号 |

### 目录结构

```
src/
  services/
    scheduler.ts         # 调度引擎（node-schedule 封装）
    task.ts              # 任务 CRUD 业务逻辑
  routes/
    web/
      tasks.ts           # /web/tasks 路由
  db/
    schema.ts            # 新增 scheduledTask + taskExecutionLog 表

web/src/
  pages/
    TasksPage.tsx        # 定时任务页面
  api/
    client.ts            # 新增 tasks API 方法
```

## 实现要点

1. **node-schedule 依赖**：需安装 `node-schedule` 包（`bun add node-schedule` + `bun add -d @types/node-schedule`）
2. **表创建**：项目无正式迁移系统，使用 Drizzle 的 `sql` tag 执行 `CREATE TABLE IF NOT EXISTS`，与其他自定义表一致
3. **HTTP 执行**：使用原生 `fetch`，通过 `AbortController` 实现超时控制
4. **响应体截断**：`task_execution_log.responseBody` 截断到 4096 字符，避免大响应撑爆数据库
5. **Headers 安全**：请求头中的敏感字段（Authorization 等）在 API 响应中脱敏显示，仅保留 key hint
6. **并发执行**：同一任务如果上一次执行未完成，新的 cron 触发应跳过（避免并发执行同一任务）
7. **时区处理**：`node-schedule` 支持时区参数，使用 `TZ` 环境变量或 Luxon 处理
8. **优雅关闭**：在 `gracefulShutdown` 中调用 `stopScheduler()` 取消所有活跃 Job

## 验收标准

- [ ] SQLite `scheduled_task` 和 `task_execution_log` 表创建成功
- [ ] 前端可通过表单创建定时任务，包含完整的 HTTP 配置
- [ ] 任务列表展示所有任务，含状态、cron 表达式、下次执行时间
- [ ] cron 调度正常触发 HTTP 请求，执行结果记录到数据库
- [ ] 任务可手动启用/禁用，禁用后不触发调度
- [ ] 支持手动触发任务执行
- [ ] 执行历史分页展示，含状态码、耗时、响应体
- [ ] 失败自动重试功能正常（重试次数和间隔可配置）
- [ ] 服务重启后自动恢复所有已启用任务的调度
- [ ] 前端「定时任务」导航项出现在侧边栏
- [ ] 类型检查通过（`bun run typecheck`）
- [ ] 后端测试通过（`bun test src/__tests__`）
