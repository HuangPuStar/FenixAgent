# 定时任务

> 对应文件：`src/services/scheduler.ts`、`src/services/task.ts`、`src/services/agent-task-runner.ts`

## 这个模块干什么

定时任务系统让用户可以配置 "每天早上 9 点自动执行代码审查" 这样的自动化场景。三个文件分工：

- **scheduler.ts**——调度引擎，管理 cron job 的注册和取消
- **task.ts**——任务的 CRUD 和执行协调
- **agent-task-runner.ts**——实际的执行器，构造 prompt 并发送给 Agent

## 核心流程

### 创建任务

用户通过 `POST /web/tasks` 创建一个定时任务，指定：
- `cron`：cron 表达式（如 `0 9 * * *`）
- `environmentId`：在哪个环境执行
- `task`：要执行的任务描述（文本）
- `timezone`：时区（可选）
- `timeoutMinutes`：超时时间

任务存入 `scheduled_task` 表。

### 调度注册

`scheduler.ts` 使用 `node-schedule` 库，根据 cron 表达式注册定时回调。

服务器启动时，`startScheduler()` 从数据库读取所有 `enabled=true` 的任务，逐个注册。

每个任务触发时：

```text
cron 触发
    │
    ▼
executeTask(taskId)
    │
    ├── 任务正在运行？→ 记录 "skipped" 日志，跳过
    │
    ▼
标记 runningTasks.add(taskId)
    │
    ▼
executeTaskById(taskId, "cron")
    │
    ├── 读取任务配置
    ├── 创建 taskExecutionLog（status=running）
    │
    ▼
AgentTaskRunner.run()
    │
    ├── 查找 environment 的 running instance
    ├── 构造 prompt（task 描述 + context）
    ├── 发送 ACP prompt 消息
    │
    ▼
等待结果
    │
    ├── 成功 → executionLog status=completed
    └── 失败 → executionLog status=error
    │
    ▼
runningTasks.delete(taskId)
```

### 防止并发

用 `runningTasks` Set 跟踪正在执行的任务。同一个任务同时只能有一个实例在跑，后续触发会被跳过并记录 "skipped" 日志。

## 任务管理 API

通过 `routes/web/tasks.ts` 提供：

| 操作 | 说明 |
|------|------|
| 列表 | 查看所有定时任务 |
| 创建 | 新建定时任务，自动注册 cron job |
| 更新 | 修改任务配置，自动重新调度 |
| 删除 | 删除任务，取消 cron job |
| 启用/禁用 | 控制是否执行 |
| 手动触发 | 立即执行一次 |
| 执行日志 | 查看历史执行记录 |

## 任务执行日志

每次执行都会在 `task_execution_log` 表中记录一条日志：

- `status`：running / completed / error / skipped
- `duration`：执行时长（毫秒）
- `error`：错误信息
- `taskSnapshot`：执行时的任务配置快照（任务可能在执行期间被修改）
- `triggeredBy`：cron / manual

## 和其他模块的关系

- → `db/schema.ts`：操作 `scheduled_task` 和 `task_execution_log` 表
- → `services/instance.ts`：查找 running instance，通过它发送 prompt
- → `transport/acp-relay-handler.ts`：通过 `sendToInstanceLocalWs` 发消息给 acp-link
- → `transport/acp-ws-handler.ts`：通过 `sendToAgentWs` 发消息给 acp-link（回退方式）
- ← `index.ts`：启动时 `startScheduler()`，关闭时 `stopScheduler()`
- ← `routes/web/tasks.ts`：路由层调用 task CRUD 函数
