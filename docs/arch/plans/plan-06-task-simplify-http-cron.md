# Plan 06：ScheduledTask 简化为 HTTP Cron 触发器

## Context

ScheduledTask 当前是一个复杂的领域概念：绑定 Environment、包含任务描述文本、执行时需要找 Instance 或 spawn 临时进程。需要简化为纯粹的 HTTP cron 触发器——定时调一个 URL。

## 现状分析

### 当前 ScheduledTask 架构

| 文件 | 职责 |
|------|------|
| `src/db/schema.ts` (scheduledTask) | environmentId, task(text), timeoutMinutes, cron, timezone |
| `src/services/task.ts` | CRUD + 复杂执行逻辑 |
| `src/services/scheduler.ts` | cron 调度 + 并发控制 |
| `src/services/agent-task-runner.ts` | 构造 prompt + spawn opencode 进程执行 |
| `src/routes/web/tasks.ts` | 完整 CRUD + toggle + trigger + logs |
| `web/src/pages/TasksPage.tsx` | Task 管理 UI |

### 要移除的逻辑

1. `agent-task-runner.ts`：整个文件移除
2. `task.ts` 中的 `executeTaskById()`：替换为 HTTP 请求
3. `scheduledTask.environmentId` 外键：移除
4. `scheduledTask.task` 字段：移除
5. `scheduledTask.timeoutMinutes`：移除

### 新增字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `url` | text | 目标 URL |
| `method` | varchar | HTTP 方法（GET/POST/PUT 等） |
| `headers` | jsonb | 请求头 |
| `body` | text | 请求体 |

### 涉及文件

**后端**：

| 文件 | 改动 |
|------|------|
| `src/db/schema.ts` | scheduledTask 表结构变更 |
| `src/db/migrations/` | 新增迁移 |
| `src/services/task.ts` | 大幅简化，执行逻辑改为 HTTP 请求 |
| `src/services/scheduler.ts` | 简化，触发 HTTP 请求 |
| `src/services/agent-task-runner.ts` | **移除** |
| `src/routes/web/tasks.ts` | CRUD 接口简化 |

**前端**：

| 文件 | 改动 |
|------|------|
| `web/src/pages/TasksPage.tsx` | 表单改为 URL 配置 |

## 具体实施步骤

### Step 1：数据库 Schema 变更

```typescript
// src/db/schema.ts - scheduledTask 表
// 新增字段
url: text("url").notNull(),
method: varchar("method", { length: 10 }).default("POST"),
headers: jsonb("headers").default({}),
body: text("body"),

// 移除字段（迁移中处理）
// environmentId, task, timeoutMinutes
```

### Step 2：简化 Task Service

```typescript
// src/services/task.ts
// executeTaskById() 改为：
async function executeTaskById(taskId: string, triggeredBy: string) {
  const task = await getTask(userId, taskId);
  const result = await fetch(task.url, {
    method: task.method,
    headers: task.headers,
    body: task.body,
  });
  // 记录执行日志
}
```

### Step 3：简化 Scheduler

```typescript
// src/services/scheduler.ts
// executeTask() 触发 HTTP 请求而非 Agent 进程
```

### Step 4：移除 agent-task-runner.ts

- 整个文件删除
- 清理所有 import 引用

### Step 5：路由和前端

- 创建 Task 时不再需要选择 Environment
- 表单字段改为：name, cron, url, method, headers, body, enabled
- 执行日志展示 HTTP 响应状态码和 body

## 验证方式

```bash
# 单元测试
bun test src/__tests__/

# 集成验证
bun run dev
# 1. 创建 HTTP Cron Task（URL = httpbin.org/post）
# 2. 手动触发，验证 HTTP 请求发送
# 3. 查看执行日志
# 4. 设置 cron 表达式，验证定时触发
```

## 数据迁移

- 现有 Task 的 environmentId + task 数据如何处理？
- 建议：标记为 deprecated，引导用户迁移到新的 HTTP Task
- 或提供迁移工具：根据 environmentId + task 生成对应的 Workflow URL

## 依赖关系

- 独立可实施
- Plan 07（Workflow）可在之后提供 URL 编排能力
