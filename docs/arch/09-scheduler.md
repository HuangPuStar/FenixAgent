# 定时任务

> 状态：2026-08-06 重写，对齐 `scheduled_task_v2`（HTTP + Agent 双类型）实现。旧版 `scheduled_task` 表已下线（见迁移 `remove-scheduled-task-v1`），历史数据不迁移。

## 这个模块干什么

定时任务系统是 **HTTP Cron 触发器 + Agent 执行器**双类型系统——用户配置 cron 表达式，系统按时执行任务并记录日志。支持手动触发、启用/禁用、分页查询历史。

核心模块分工：

- **调度引擎**——`SchedulerService`（`src/services/scheduler/index.ts`）基于 `node-schedule` 管理 cron job 的注册和取消；按任务 `type` 分派到对应 executor
- **任务管理**——任务的 CRUD（`src/services/task-v2.ts`）、执行协调、日志写入
- **执行器**——按类型注册：`httpExecutor`（HTTP 请求）与 `agentExecutor`（spawn Agent 进程执行 prompt）

## 数据模型

### `scheduled_task_v2` 表

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
| `timeoutSeconds` | integer | 执行超时秒数（默认 300） |
| `agentId` | uuid | Agent ID（仅 agent 类型，引用 `agent_config`，删除置空） |
| `type` | varchar | 任务类型：`http` / `agent` |
| `definition` | jsonb | 类型化定义（见下） |
| `lastRunAt` / `nextRunAt` | timestamp | 最近/下次执行时间 |
| `lastStatus` | varchar | 上次执行状态 |
| `createdAt` / `updatedAt` | timestamp | 时间戳 |

`definition` 按类型区分：

- **http**：`{ url: string, method?: string, headers?: Record<string,string>, body?: string }`（method 默认 POST）
- **agent**：`{ prompt: string }`

### `task_execution_log` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | uuid | 主键 |
| `taskId` | uuid | 关联任务（CASCADE 删除） |
| `status` | varchar | 执行状态：success / failed / timeout / skipped |
| `error` | text | 错误信息 |
| `duration` | integer | 执行耗时（毫秒） |
| `triggeredBy` | varchar | cron / manual |
| `workspacePath` / `workspaceName` | varchar | Agent 执行器的工作区信息 |
| `taskSnapshot` | jsonb | 执行时的任务定义快照 |
| `skipReason` | text | 跳过原因 |
| `resultSummary` | text | 结果摘要（截断至 2000 字符） |
| `createdAt` | timestamp | 创建时间 |

## 执行器

### httpExecutor（HTTP 请求）

- method 默认 POST（GET 不携带 body），无 Content-Type 时自动补 `application/json`
- 超时经 `AbortSignal.timeout(timeoutSeconds)` 控制
- 结果按 `response.ok` 判定 success / failed，响应体截断至 2000 字符作为 `resultSummary`

### agentExecutor（Agent 执行）

- 复用 `openAgentSession`（`src/services/agent-chat-service.ts`）以 `agentId` 对应的 Agent 执行 `prompt`
- 从 ACP 事件流提取纯文本输出（过滤 tool_call / tool_result 帧），写入 `resultSummary`

## 核心流程

### 调度注册与触发

服务器启动时从 DB 读取所有 `enabled=true` 的任务，逐个注册到 `node-schedule` 调度器；非法 cron 表达式注册失败并计数告警。停止时取消全部 job。

每个任务触发时：

```text
cron 触发
    │
    ▼
检查是否已在执行中（runningTasks 集合）→ 是：记录 "skipped" 日志，跳过本次
    │
    ├── 否：标记"执行中"
    ▼
按 type 分派 executor（http / agent）
    │
    ▼
写入执行日志，更新任务 lastStatus / lastRunAt / nextRunAt，清除执行标记
```

### 手动触发

`POST /tasks/v2/:id/trigger` 走与 cron 相同的 `schedulerService.execute(taskId, "manual")` 执行路径，`triggeredBy=manual` 记录到日志。

## 任务管理 API

| 方法 | URL | 说明 |
|------|-----|------|
| GET | `/web/tasks/v2` | 列出任务（分页，支持 keyword / type / agentId 筛选） |
| POST | `/web/tasks/v2` | 创建任务（name、cron、type 必填；agent 类型需 agentId + prompt） |
| GET | `/web/tasks/v2/:id` | 获取任务详情 |
| PUT | `/web/tasks/v2/:id` | 更新任务（cron/时区/enabled 变化时自动重新调度；**type 不可修改**） |
| DELETE | `/web/tasks/v2/:id` | 删除任务并取消调度 |
| POST | `/web/tasks/v2/:id/toggle` | 切换启用/禁用 |
| POST | `/web/tasks/v2/:id/trigger` | 手动触发一次执行 |
| GET | `/web/tasks/v2/:id/logs` | 分页查询执行日志 |
| DELETE | `/web/tasks/v2/:id/logs` | 清空任务所有日志 |

## 和其他模块的关系

- → **数据库 Schema**：操作 `scheduledTaskV2` 和 `taskExecutionLog` 表
- → **数据访问层**：任务仓储（`src/repositories/task-v2.ts`）和日志仓储
- → **Agent 会话服务**：agent 类型经 `openAgentSession` 执行 prompt
- ← **服务器入口**：启动时注册 job，关闭时取消所有 job
- ← **路由层**：`src/routes/web/tasks-v2.ts` 调用任务 CRUD 函数
