# Feature: 20260427_F001 - scheduled-agent-tasks

## 需求背景

当前仓库已经落地了一版“定时 HTTP 任务”能力，但这套能力的核心模型和用户目标已经变化：

- 用户不再需要定时发起 HTTP 请求
- 用户需要定时触发现有 environment 对应的 Agent
- 每次触发都要在独立 workspace 中执行一段一次性 task
- 执行结束后保留 workspace，便于回看产物

如果继续沿用 HTTP 任务模型，只会保留大量无用字段和 UI，增加维护成本，也会让“任务执行”和“Agent 会话执行”两条链路长期割裂。因此本次 feature 直接将定时任务能力重构为“定时 Agent 任务”，替换现有 HTTP 任务方案。

## 目标

- 提供面向 Agent 的定时任务配置：cron、environment、task、超时、启停
- 不选择时区时按服务器本地时间解释 cron
- 每次执行创建一个新的临时 workspace，并在结束后保留目录供查看
- 同一个定时任务在上一次未结束时，新的 cron 触发应跳过
- 保留执行历史，记录运行状态、workspace 路径、触发方式、跳过原因和超时结果

## 方案设计

### 方案选择

本需求有三种可选方向：

1. 继续扩展 HTTP 任务，在原任务上增加 “执行 Agent” 模式  
问题是数据模型和前端会长期保留两套互斥字段，复杂度高，不符合当前需求收敛方向。

2. 保留任务壳层，但把执行器改成“environment + task”  
这是推荐方案。复用现有 `/web/tasks`、调度器、执行日志和任务列表入口，但彻底移除 HTTP 配置，转成面向 environment 的一次性任务执行。

3. 直接把定时能力做进 environment 本体  
这样会把“环境管理”和“任务编排”耦合在一起，一个 environment 难以配置多个计划任务，扩展性差。

推荐采用方案 2：保留“任务”作为独立领域对象，但任务内容从 HTTP 请求改为“对某个 environment 发起一次性 Agent task 执行”。

### 总体架构

```text
TasksPage
   │
   ▼
/web/tasks API
   │
   ├── TaskService
   │     ├── 任务 CRUD
   │     ├── environment 校验
   │     └── 执行日志持久化
   │
   ├── SchedulerEngine
   │     ├── cron 调度
   │     ├── 单任务并发保护（运行中则跳过）
   │     └── 超时控制
   │
   ├── AgentTaskRunner
   │     ├── 基于 environment 派生执行上下文
   │     ├── 创建临时 workspace
   │     ├── 启动一次性 agent 执行
   │     └── 保留执行目录与摘要
   │
   └── SQLite
         ├── scheduled_task
         └── task_execution_log
```

核心变化不是新增一个独立子系统，而是把现有 `task + scheduler` 链路的执行器从 `fetch(url)` 替换为 `run task on environment in new workspace`。

### 数据模型调整

现有 `scheduled_task` 和 `task_execution_log` 已经存在，但字段围绕 HTTP 请求设计。本次直接迁移字段语义，不保留 HTTP 配置。

#### `scheduled_task`

建议调整为：

```typescript
export const scheduledTask = sqliteTable("scheduled_task", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),

  name: text("name").notNull(),
  description: text("description"),

  cron: text("cron").notNull(),
  timezone: text("timezone"), // null 表示服务器本地时间
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

  environmentId: text("environment_id").notNull()
    .references(() => environment.id, { onDelete: "cascade" }),
  task: text("task").notNull(),
  timeoutMinutes: integer("timeout_minutes").notNull().default(30),

  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  nextRunAt: integer("next_run_at", { mode: "timestamp" }),
  lastStatus: text("last_status"), // success | failed | timeout | skipped

  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
```

说明：

- 删除 `url`、`method`、`headers`、`body`
- 删除 `retryEnabled`、`retryCount`、`retryInterval`
- 删除 `timeout` 毫秒字段，改为面向任务语义的 `timeoutMinutes`，默认 30 分钟
- `timezone` 改为可空，`null` 表示按服务器时间执行，而不是默认写死 `UTC`
- 新增 `environmentId` 和 `task`

#### `task_execution_log`

建议调整为：

```typescript
export const taskExecutionLog = sqliteTable("task_execution_log", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => scheduledTask.id, { onDelete: "cascade" }),

  status: text("status").notNull(), // success | failed | timeout | skipped
  error: text("error"),
  duration: integer("duration"),
  triggeredBy: text("triggered_by").notNull().default("cron"), // cron | manual

  workspacePath: text("workspace_path"),
  workspaceName: text("workspace_name"),
  environmentId: text("environment_id"),
  environmentName: text("environment_name"),
  taskSnapshot: text("task_snapshot"),
  skipReason: text("skip_reason"),
  resultSummary: text("result_summary"),

  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
```

说明：

- 删除 `statusCode`、`responseBody`、`attempt`
- 增加执行结果定位字段，便于前端直接展示“在哪个 workspace 跑的”
- `taskSnapshot` 存触发时的 task 文本快照，避免后续编辑任务后日志失真
- `skipReason` 用于记录“上次还在运行，已跳过本次”

本次不做历史兼容迁移。已有 HTTP 任务数据可视为废弃测试数据，开发态直接通过建表 SQL 对齐新结构。

### 任务执行语义

一个定时任务绑定一个现有 environment。触发时：

1. 读取 environment 的 `workspacePath`
2. 在其下创建执行目录，例如：
   `"<environment.workspacePath>/.scheduled-runs/<taskId>/<yyyyMMdd-HHmmss>-<logId>"`
3. 将该目录作为本次独立 workspace
4. 启动一次性 Agent 执行，内容为任务配置中的 `task`
5. 执行结束后保留目录，不自动清理
6. 将执行状态、耗时、workspace 路径写入日志

这样满足“独立 workspace”和“结果可查看”两个要求，同时把运行结果天然归档在 environment 相关目录下，避免散落到系统临时目录。

### 一次性 Agent 执行方式

推荐新增 `src/services/agent-task-runner.ts`，封装“针对某个 environment 运行一次性任务”的流程，而不是把逻辑塞进 `scheduler.ts`。

`AgentTaskRunner` 的职责：

- 校验 environment 是否存在、是否属于当前用户
- 创建本次执行目录
- 启动一次性执行进程
- 收集 stdout/stderr 摘要
- 实现超时中断
- 产出统一结果对象供 `TaskService` 记录日志

推荐结果结构：

```typescript
interface AgentTaskRunResult {
  status: "success" | "failed" | "timeout";
  workspacePath: string;
  resultSummary: string | null;
  error: string | null;
  duration: number;
}
```

具体执行实现建议采用“直接在 workspace 下启动 opencode 一次性 task 命令”的模式，而不是复用 relay/WebSocket 聊天链路。原因：

- 这是后台无人值守任务，不需要前端实时交互
- 定时执行的生命周期是“一次性命令”，不是长连接会话
- 更容易做超时杀进程、收集退出码和结果摘要

如果现有仓库还没有稳定的一次性命令封装，本次先在 runner 中集中实现，后续再抽象复用。

### 调度与并发控制

保留 `node-schedule`，但调整 cron 时区逻辑：

- 当 `timezone` 有值时，传 `tz`
- 当 `timezone` 为空时，不传 `tz`，让 `node-schedule` 使用服务器本地时间

同一个任务的并发策略固定为“跳过本次”：

- 调度器发现 `taskId` 已在运行集合中
- 不重复启动第二次执行
- 写一条 `status=skipped` 的日志，`skipReason="previous_run_still_active"`
- 更新 `lastStatus=skipped`

这样不会出现同一个任务积压出多个并行 workspace，也更符合定时任务的可预测性。

### 超时控制

每个任务新增超时配置，单位为分钟，默认 30 分钟。

- 字段：`timeoutMinutes`
- 默认值：`30`
- 最小值建议：`1`
- 最大值建议：`180`

执行器通过 `AbortController` 或子进程 kill timer 控制超时：

- 到达超时时间后终止执行进程
- 本次执行记为 `timeout`
- `error` 写入 `"Task execution timed out"`
- workspace 保留，不清理

超时是最终态，不自动重试。

### API 设计

继续使用现有 `/web/tasks` 路由组，但字段整体替换。

#### 创建任务 `POST /web/tasks`

请求体：

```json
{
  "name": "每日巡检",
  "description": "每天早上执行环境巡检",
  "cron": "0 9 * * *",
  "timezone": "",
  "environmentId": "env_xxx",
  "task": "检查当前仓库状态，汇总未提交变更，并生成一份巡检报告",
  "timeoutMinutes": 30
}
```

约定：

- `timezone: ""` 或缺省时，后端归一化为 `null`
- `environmentId` 必须属于当前用户
- `task` 不能为空，建议限制长度，例如 1 到 10000 字符
- `timeoutMinutes` 为空时使用默认 30 分钟

响应体返回：

- 任务基础信息
- 关联的 `environmentName`
- `nextRunAt`

#### 更新任务 `PUT /web/tasks/:id`

允许修改：

- `name`
- `description`
- `cron`
- `timezone`
- `environmentId`
- `task`
- `timeoutMinutes`
- `enabled`

更新后若任务处于启用状态，需要立即重建 scheduler job。

#### 手动触发 `POST /web/tasks/:id/trigger`

语义不变，但执行器改为 Agent 任务执行。返回本次日志记录：

```json
{
  "success": true,
  "data": {
    "id": "log_xxx",
    "status": "success",
    "workspacePath": "/path/to/.scheduled-runs/task_xxx/20260427-090000-log_xxx",
    "triggeredBy": "manual",
    "duration": 42150,
    "resultSummary": "已生成巡检报告 report.md"
  }
}
```

#### 执行日志 `GET /web/tasks/:id/logs`

列表项重点展示：

- 执行时间
- 状态
- 触发方式
- 执行耗时
- workspace 路径
- 结果摘要
- 跳过原因

### 前端页面调整

现有 `TasksPage` 可以复用骨架，但表单和列表字段要整体改造。

#### 列表页

建议列：

- 名称
- cron
- environment
- 状态
- 上次执行
- 下次执行
- 最近结果
- 操作

“最近结果”显示 `lastStatus`，不再显示 HTTP 方法和 URL。

#### 创建/编辑表单

保留：

- 名称
- 描述
- cron
- 时区
- 启用状态

新增/替换：

- environment 下拉框：数据来源为现有 `environments`
- task 多行文本框
- 超时（分钟）

移除：

- URL
- Method
- Headers
- Body
- Retry 配置

时区交互建议：

- 默认留空
- 文案显示“留空则使用服务器时间”

#### 执行日志视图

新增更直接的信息展示：

- 可点击查看 `workspacePath`
- 状态为 `skipped` 时显示“上次运行未结束，已跳过”
- 状态为 `timeout` 时显示“执行超时”

### 执行结果可查看性

“保留结果目录供查看”至少包含两层能力：

1. 日志中能看到 workspace 路径
2. 用户可通过现有文件浏览能力查看该目录内容

因此本次不必新增新的“任务产物”数据表，只需保证：

- workspace 目录位于现有系统可访问路径下
- 日志保存准确路径
- 如果需要，可新增“打开目录”或“复制路径”交互

### 与现有 HTTP 任务实现的替换边界

这次 feature 不是在原有实现上加字段，而是替换任务领域模型。需要同步修改：

- `src/db/schema.ts`
- `src/db/index.ts`
- `src/services/task.ts`
- `src/services/scheduler.ts`
- `src/routes/web/tasks.ts`
- `web/src/api/client.ts`
- `web/src/pages/TasksPage.tsx`
- 相关测试：`task-core.test.ts`、`task-routes.test.ts`、`scheduler.test.ts`、`tasks-page.test.ts`

已有 HTTP 相关逻辑应全部删除，避免留下无效字段、假日志语义和误导性 UI 文案。

## 实现要点

- 复用现有 `/web/tasks` 路由和 `node-schedule`，减少外部 API 变更
- 新增 `agent-task-runner.ts`，隔离“后台一次性执行 Agent task”的进程控制逻辑
- cron 时区空值必须映射为“服务器本地时间”，不能再默认写入 `UTC`
- 调度器在跳过执行时也要落日志，否则用户无法理解为什么没有新 workspace
- workspace 路径生成必须稳定可追踪，建议包含 `taskId + timestamp + logId`
- 超时控制要覆盖“进程已启动但无输出”的情况，不能只依赖应用层回调
- 前端修改后必须重新执行 `bun run build:web`

## 验收标准

- [ ] 创建任务时不再出现任何 HTTP 配置字段，只能选择 environment、填写 task 和超时
- [ ] 时区留空时，任务按服务器本地时间执行；设置具体时区时，按指定时区执行
- [ ] 手动触发任务时，会创建独立 workspace，并在执行结束后保留目录
- [ ] 同一任务运行中再次到达 cron，不会并发启动，而是记录一条 `skipped` 日志
- [ ] 任务超时后会被终止，状态记为 `timeout`，workspace 仍可查看
- [ ] 执行日志中能看到 environment、workspace 路径、触发方式、结果摘要和错误信息
- [ ] 原有 HTTP 配置、响应状态码、重试相关前后端代码已清理，不再出现在任务功能中
