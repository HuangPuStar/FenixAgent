# 定时任务

> 对应文件：`src/services/scheduler.ts`、`src/services/task.ts`、`src/services/agent-task-runner.ts`、`src/routes/web/tasks.ts`、`src/repositories/task.ts`

## 这个模块干什么

定时任务系统是一个 **HTTP Cron 触发器**——用户配置 URL + cron 表达式，系统按时发送 HTTP 请求到目标地址。每次执行记录日志，支持手动触发、启用/禁用、分页查询历史。

三个核心文件分工：

- **scheduler.ts**——调度引擎，基于 `node-schedule` 管理 cron job 的注册和取消
- **task.ts**——任务的 CRUD、执行协调（`fetch` 发 HTTP 请求）、日志写入
- **agent-task-runner.ts**——独立 Agent 执行器，spawn `opencode run` 执行 Agent 任务。**不接入调度系统**，是独立功能模块

## 数据模型

### `scheduled_task` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid | 主键 |
| `userId` | text | 创建者（引用 `user` 表） |
| `organizationId` | text | 所属组织 |
| `name` | varchar | 任务名称 |
| `description` | text | 任务描述 |
| `cron` | varchar | 5 字段 cron 表达式 |
| `timezone` | varchar | 时区（可选） |
| `enabled` | boolean | 是否启用（默认 true） |
| `url` | text | HTTP 请求目标 URL |
| `method` | varchar(10) | HTTP 方法（默认 POST） |
| `headers` | jsonb | 请求头（JSON 对象） |
| `body` | text | 请求体 |
| `lastRunAt` | timestamp | 上次执行时间 |
| `nextRunAt` | timestamp | 下次执行时间 |
| `lastStatus` | varchar | 上次执行状态 |
| `createdAt` / `updatedAt` | timestamp | 时间戳 |

### `task_execution_log` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid | 主键 |
| `taskId` | uuid | 关联任务（CASCADE 删除） |
| `status` | varchar | 执行状态：success / failed / timeout / skipped |
| `error` | text | 错误信息 |
| `duration` | integer | 执行耗时（毫秒） |
| `triggeredBy` | varchar | cron / manual |
| `workspacePath` | varchar | workspace 路径（agent-task-runner 使用） |
| `workspaceName` | varchar | workspace 名称（agent-task-runner 使用） |
| `taskSnapshot` | jsonb | schema 中存在但**代码从不写入** |
| `skipReason` | text | 跳过原因 |
| `resultSummary` | text | 结果摘要（截断至 2000 字符） |
| `createdAt` | timestamp | 创建时间 |

## 核心流程

### 创建任务

用户通过 `POST /web/tasks` 创建，必填字段：`name`、`cron`、`url`。可选：`method`（默认 POST）、`headers`、`body`、`timezone`、`description`。

```text
POST /web/tasks { name, cron, url, method?, headers?, body?, timezone? }
    │
    ▼
createTask(orgId, data, userId)
    │
    ├── validateTaskInput() 校验 cron 格式（5 字段）、name 长度、URL 非空、method 白名单
    ├── scheduledTaskRepo.create() 写入 DB，enabled 默认 true
    ├── scheduleTask() 注册 node-schedule job
    │
    ▼
返回 TaskResponse
```

### 调度注册

`scheduler.ts` 使用 `node-schedule` 库，根据 cron 表达式注册定时回调。

服务器启动时调用 `startScheduler()` → `scheduledTaskRepo.listEnabled()` 从 DB 读取所有 `enabled=true` 的任务，逐个注册。

每个任务触发时：

```text
cron 触发
    │
    ▼
executeTask(taskId)
    │
    ├── runningTasks.has(taskId)？→ 记录 "skipped" 日志，跳过
    │
    ▼
runningTasks.add(taskId)
    │
    ├── 读取任务配置，验证 enabled、存在性
    │
    ▼
executeTaskById(taskId, "cron", task)
    │
    ├── 构造 fetch 请求（task.url, task.method, task.headers, task.body）
    ├── AbortSignal.timeout(30_000) 30 秒超时
    │
    ▼
fetch(task.url) 发送 HTTP 请求
    │
    ├── 成功 (response.ok) → status="success"
    ├── HTTP 错误 → status="failed"（记录状态码 + 响应体前 500 字符）
    ├── 超时 (AbortError) → status="timeout"
    └── 其他异常 → status="failed"
    │
    ▼
writeLogAndReturn() 写入 task_execution_log + 更新 scheduled_task.lastStatus
runningTasks.delete(taskId)
```

### 防止并发

用 `runningTasks` Set 跟踪正在执行的任务。同一个任务同时只能有一个实例在跑，后续触发会被跳过并记录 "skipped" 日志。

### 手动触发

`POST /tasks/:id/trigger` → `triggerTask()` → `executeTaskById(taskId, "manual")` — 绕过 `runningTasks` 检查，直接执行。

## 任务管理 API

通过 `src/routes/web/tasks.ts` 提供，所有端点需要 `sessionAuth`：

| 方法 | URL | 说明 |
|------|-----|------|
| GET | `/web/tasks` | 列出当前组织所有任务 |
| POST | `/web/tasks` | 创建任务（`name`、`cron`、`url`、`method`、`headers`、`body`、`timezone`） |
| GET | `/web/tasks/:id` | 获取任务详情 |
| PUT | `/web/tasks/:id` | 更新任务（cron/时区/enabled 变化时自动重新调度） |
| DELETE | `/web/tasks/:id` | 删除任务并取消调度 |
| POST | `/web/tasks/:id/toggle` | 切换启用/禁用 |
| POST | `/web/tasks/:id/trigger` | 手动触发一次执行 |
| GET | `/web/tasks/:id/logs` | 分页查询执行日志（`?page=1&pageSize=20`，最大 pageSize 100） |
| DELETE | `/web/tasks/:id/logs` | 清空任务所有日志 |

## AgentTaskRunner（独立执行器）

`src/services/agent-task-runner.ts` 是一个**独立的 Agent 执行器**，不接入调度系统。它通过 spawn `opencode run <taskText>` 执行 Agent 任务：

- **用途**：独立场景下 spawn opencode 进程执行 Agent 任务
- **入参**：`RunAgentTaskInput`（`userId`、`environmentId`、`taskId`、`taskText`、`timeoutMinutes`、`logId`）
- **执行**：`buildRunWorkspacePath()` 在 environment workspace 下创建 `.scheduled-runs/{taskId}/{timestamp}-{logId}/` 子目录，写入 `.opencode/config.json` 和 `.claude/settings.json`
- **超时**：`timeoutMinutes * 60000` 后 SIGTERM，再 +5s 后 SIGKILL
- **返回**：`AgentTaskRunResult`（status、workspacePath、workspaceName、resultSummary、error、duration）

这个模块与调度器的关系：**平行独立**。调度器触发 HTTP 请求，agent-task-runner 由外部调用者 spawn Agent 进程。

## 和其他模块的关系

- → `src/db/schema.ts`：操作 `scheduledTask` 和 `taskExecutionLog` 表
- → `src/repositories/task.ts`：数据访问层（`scheduledTaskRepo`、`taskExecutionLogRepo`）
- ← `src/index.ts`：启动时 `startScheduler()`，关闭时 `stopScheduler()`
- ← `src/routes/web/tasks.ts`：路由层调用 task CRUD 函数
