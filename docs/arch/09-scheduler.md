# 定时任务

## 这个模块干什么

定时任务系统是一个 **HTTP Cron 触发器**——用户配置 URL + cron 表达式，系统按时发送 HTTP 请求到目标地址。每次执行记录日志，支持手动触发、启用/禁用、分页查询历史。

三个核心模块分工：

- **调度引擎**——基于 `node-schedule` 管理 cron job 的注册和取消
- **任务管理**——任务的 CRUD、执行协调（HTTP 请求发送）、日志写入
- **Agent 执行器**——独立 Agent 执行器，spawn Agent 进程执行任务。**不接入调度系统**，是独立功能模块

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
| `workspacePath` | varchar | workspace 路径（Agent 执行器使用） |
| `workspaceName` | varchar | workspace 名称（Agent 执行器使用） |
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
校验 cron 格式（5 字段）、name 长度、URL 非空、method 白名单
    │
    ├── 写入 DB，enabled 默认 true
    ├── 注册 node-schedule job（按 cron 表达式调度）
    │
    ▼
返回任务响应
```

### 调度注册

服务器启动时从 DB 读取所有 `enabled=true` 的任务，逐个注册到 `node-schedule` 调度器。

每个任务触发时：

```text
cron 触发
    │
    ▼
检查是否已在执行中 → 是：记录 "skipped" 日志，跳过本次
    │
    ├── 否：标记为"执行中"
    │
    ▼
读取任务配置（url、method、headers、body）
    │
    ▼
发送 HTTP 请求（30 秒超时）
    │
    ├── 成功 (response.ok) → status="success"
    ├── HTTP 错误 → status="failed"（记录状态码 + 响应体摘要）
    ├── 超时 → status="timeout"
    └── 其他异常 → status="failed"
    │
    ▼
写入执行日志，更新任务 lastStatus，清除执行标记
```

### 防止并发

用执行中集合跟踪正在执行的任务。同一个任务同时只能有一个实例在跑，后续触发会被跳过并记录 "skipped" 日志。

### 手动触发

`POST /tasks/:id/trigger` 绕过并发检查，直接执行。

## 任务管理 API

| 方法 | URL | 说明 |
|------|-----|------|
| GET | `/web/tasks` | 列出当前组织所有任务 |
| POST | `/web/tasks` | 创建任务 |
| GET | `/web/tasks/:id` | 获取任务详情 |
| PUT | `/web/tasks/:id` | 更新任务（cron/时区/enabled 变化时自动重新调度） |
| DELETE | `/web/tasks/:id` | 删除任务并取消调度 |
| POST | `/web/tasks/:id/toggle` | 切换启用/禁用 |
| POST | `/web/tasks/:id/trigger` | 手动触发一次执行 |
| GET | `/web/tasks/:id/logs` | 分页查询执行日志（最大 pageSize 100） |
| DELETE | `/web/tasks/:id/logs` | 清空任务所有日志 |

## AgentTaskRunner（独立执行器）

AgentTaskRunner 是一个**独立的 Agent 执行器**，不接入调度系统。它通过 spawn Agent 进程执行任务：

- **用途**：独立场景下 spawn Agent 进程执行任务文本
- **执行**：在 environment workspace 下创建专用的执行子目录，写入运行时配置文件
- **超时**：配置超时后先 SIGTERM，再延迟后 SIGKILL 确保进程终止
- **返回**：执行状态、workspace 路径、结果摘要、错误信息、耗时

**与调度器的关系：平行独立**。调度器触发 HTTP 请求，AgentTaskRunner 由外部调用者 spawn Agent 进程。两者互不依赖。

## 和其他模块的关系

- → **数据库 Schema**：操作 `scheduledTask` 和 `taskExecutionLog` 表
- → **数据访问层**：任务仓储和日志仓储
- ← **服务器入口**：启动时注册 job，关闭时取消所有 job
- ← **路由层**：调用任务 CRUD 函数
