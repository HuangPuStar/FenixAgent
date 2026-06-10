# 工作流异常日志补全设计

日期：2026-06-10

## 问题

工作流执行失败时，异常信息在服务器日志中完全不可见。根因是异常传播链路存在结构性缺漏：节点失败 → 调度器标记 FAILED → 返回正常 result（status="FAILED"）→ 引擎门面 resolve → 路由层 resolve。这条"正常失败"路径上没有任何一层记录日志。

### 已确认的缺漏点

| # | 位置 | 问题 |
|---|------|------|
| 1 | `DAGScheduler.executeNode()` catch 块 | 节点 FAILED 无日志 |
| 2 | `DAGScheduler.run()` catch 块 | 未预期异常被忽略（`_error`） |
| 3 | `DAGScheduler.executeNode()` AbortError | 取消/超时原因不记录 |
| 4 | `WorkflowEngine.runAsync()` | 返回 FAILED 结果时无日志 |
| 5 | `AgentExecutor` AbortError → WorkflowError | 原始超时信息被替换为 "Node cancelled" |

## 方案

在调度器层和引擎门面层补日志。调度器记录节点级失败详情，引擎门面记录运行级终态摘要。路由层不改动。

### 改动 1：`DAGScheduler.executeNode()` — 节点失败日志

在 catch 块的 FAILED 分支添加 `console.error`，记录节点 ID、节点类型、错误消息和错误类型。

**失败路径**（`dag-scheduler.ts` FAILED 分支）：
```
[workflow] Node FAILED: nodeId=<id> type=<type> error=<error.message>
```

**取消路径**（AbortError 分支）：
```
[workflow] Node CANCELLED: nodeId=<id> type=<type> reason=<error.message>
```

### 改动 2：`DAGScheduler.run()` — 未预期异常日志

将 `_error` 改为 `error`，添加 `console.error` 记录异常完整信息。

```
[workflow] DAG unexpected error: runId=<id> error=<error>
```

### 改动 3：`WorkflowEngine.runAsync()` — 运行终态日志

在 `runAsync` 的后台执行完成后（`try` 块 return 前），无论终态是什么都记录一行摘要。

```
[workflow] Run completed: runId=<id> status=<status> nodes=<total> completed=<n> failed=<n>
```

### 改动 4：`AgentExecutor` — 保留原始超时信息

将 AbortError 转换为 WorkflowError 时，把原始 `error.message` 携带到 details 中而非丢弃。`WorkflowError` 的 message 保持 `"Node cancelled"`（兼容前端），但 details 中新增 `abortReason` 字段。

```typescript
throw new WorkflowError("Node cancelled", WorkflowErrorCode.DAG_CANCELLED, {
  node_id: node.id,
  abort_reason: error.message,  // 如 "Agent init timed out after 120000ms"
});
```

调度器的 catch 块从 `WorkflowError.details.abort_reason` 中提取原始原因记录到日志。

## 改动范围

| 文件 | 改动 |
|------|------|
| `packages/workflow-engine/src/scheduler/dag-scheduler.ts` | catch 块加 `console.error`（3 处） |
| `packages/workflow-engine/src/engine/workflow-engine.ts` | `runAsync` 加终态日志（1 处） |
| `packages/workflow-engine/src/executor/agent-executor.ts` | AbortError details 中加 `abort_reason`（1 处） |

## 不改动

- 路由层（`workflow-engine.ts`、`workflow-jobs.ts`）— 引擎层日志已覆盖
- 其他执行器（ProcessExecutor、ApiExecutor 等）— 它们已有足够的错误信息抛出
- `acp-transport.ts` — 刚刚完成的 JSON-RPC 改造已包含日志
