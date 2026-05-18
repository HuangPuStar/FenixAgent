# Workflow Engine 前端对接文档

> 后端 API 已就绪，本文档供前端开发对接使用。
> 统一端点：`POST /web/workflow-engine`，通过 `action` 字段分发。
> 需要登录态（cookie-based session）。

---

## 1. API 概览

| action | 说明 | 关键参数 |
|--------|------|----------|
| `run` | 执行工作流 | `yaml`, `params?` |
| `dryRun` | 校验 + 执行计划（不执行） | `yaml` |
| `cancel` | 取消运行中的工作流 | `runId` |
| `approve` | 审批通过（AuditNode） | `runId`, `nodeId`, `token`, `data?` |
| `getRunStatus` | 获取运行状态快照 | `runId` |
| `getEvents` | 获取事件流 | `runId`, `nodeId?` |
| `getOutput` | 获取节点输出 | `runId`, `nodeId` |
| `getPendingApprovals` | 获取待审批列表 | `runId` |
| `listRuns` | 列出所有运行记录 | — |
| `recover` | 崩溃恢复 | `runId`, `yaml` |

---

## 2. 通用约定

### 请求

```typescript
const res = await fetch("/web/workflow-engine", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include",  // 携带 better-auth session cookie
  body: JSON.stringify({ action: "run", yaml: "...", params: {} }),
});
const json = await res.json();
```

### 响应格式

**成功**：

```jsonc
{ "success": true, "data": { ... } }
```

**失败**：

```jsonc
{ "error": { "type": "VALIDATION_ERROR", "message": "Workflow validation failed: ..." } }
```

### HTTP 状态码映射

| 状态码 | error.type | 场景 |
|--------|-----------|------|
| 400 | `VALIDATION_ERROR` | YAML 校验失败 / action 不存在 |
| 404 | `RUN_NOT_FOUND` | runId 不存在或已结束 |
| 500 | `INTERNAL_ERROR` / 其他 | 服务器内部错误 |

---

## 3. 各 action 详解

### 3.1 `run` — 执行工作流

```typescript
// 请求
{
  action: "run",
  yaml: string,           // 工作流 YAML 定义（新格式，schema_version: "1"）
  params?: Record<string, unknown>  // 参数注入（对应 YAML 中的 params 声明）
}

// 响应 data
{
  runId: string,          // "run_xxxxxxxxxx"
  status: DAGStatus,      // "SUCCESS" | "FAILED" | "CANCELLED" | "SUSPENDED" | "ERROR"
  summary: RunSummary
}
```

> **注意**：`run` 是同步等待的（会阻塞直到工作流完成或进入 SUSPENDED）。
> 对于长时间运行的工作流，建议前端先调用 `run`，拿到 `runId` 后轮询 `getRunStatus` 查看进度。
> 后续版本会支持异步执行 + SSE 推送。

**示例 YAML**：

```yaml
schema_version: "1"
name: "hello-world"
nodes:
  - id: greet
    type: shell
    command: echo "Hello ${{ params.name || 'World' }}"
```

### 3.2 `dryRun` — 校验 + 执行计划

不实际执行，只校验 YAML 合法性并返回执行计划。

```typescript
// 请求
{ action: "dryRun", yaml: string }

// 响应 data
{
  valid: boolean,
  issues: Array<{ type: "error" | "warning", message: string, field?: string }>,
  executionPlan: {
    topologicalOrder: string[],     // 节点执行顺序
    parallelGroups: string[][]       // 可并行的节点组
  }
}
```

### 3.3 `cancel` — 取消运行

```typescript
// 请求
{ action: "cancel", runId: string }

// 响应
{ success: true }
```

### 3.4 `getRunStatus` — 获取运行状���

```typescript
// 请求
{ action: "getRunStatus", runId: string }

// 响应 data（DAGSnapshot）
{
  snapshot_id: string,
  run_id: string,
  last_event_id: string,
  timestamp: string,       // ISO 8601
  node_states: {
    [nodeId]: {
      status: NodeStatus,   // "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "SKIPPED"
      exit_code?: number
    }
  },
  dag_status: DAGStatus     // "PENDING" | "RUNNING" | "SUSPENDED" | "FAILED" | "CANCELLED" | "ERROR" | "SUCCESS"
}
```

### 3.5 `getEvents` — 获取事件流

```typescript
// 请求
{ action: "getEvents", runId: string, nodeId?: string }

// 响应 data（DAGEvent[]）
[{
  event_id: string,
  run_id: string,
  node_id?: string,
  timestamp: string,       // ISO 8601
  type: EventType,
  node_type?: NodeType,
  metadata?: Record<string, unknown>
}]
```

**EventType 枚举**（全部 15 种）：

| 类型 | 触发时机 | metadata |
|------|---------|----------|
| `dag.started` | 工作流开始 | `{ params }` |
| `dag.completed` | 工作流结束 | `{ status, duration_ms }` |
| `dag.cancelled` | 工作流被取消 | `{ reason }` |
| `node.started` | 节点开始执行 | `{ inputs, pid? }` |
| `node.completed` | 节点执行成功 | `{ exit_code, output_size, output_ref?, tokens?, model?, latency_ms? }` |
| `node.failed` | 节点执行失败 | `{ error, exit_code? }` |
| `node.cancelled` | 节点被取消 | `{ reason }` |
| `node.retrying` | 节点重试中 | `{ attempt, next_delay_ms }` |
| `node.skipped` | 节点被跳过 | `{ reason: "upstream_failed" \| "condition_false" }` |
| `sub_workflow.started` | 子流程开始 | `{ sub_run_id }` |
| `sub_workflow.completed` | 子流程完成 | `{ sub_run_id, outputs? }` |
| `loop.iteration_started` | 循环迭代开始 | `{ iteration, max_iterations }` |
| `loop.iteration_completed` | 循环迭代完成 | `{ iteration, will_continue }` |
| `audit.requested` | 审批请求 | `{ approval_token, expires_at, display_data }` |
| `audit.approved` | 审批通过 | `{ approval_token }` |

### 3.6 `getOutput` — 获取节点输出

```typescript
// 请求
{ action: "getOutput", runId: string, nodeId: string }

// 响应 data（NodeOutput）
{
  stdout: string,         // 节点标准输出
  json?: unknown,         // stdout 尝试 JSON.parse 成功时填充
  exit_code: number,      // 0 = 成功
  size?: number,          // stdout 字节数
  ref?: string            // 大输出时的外部存储引用路径（>1MB）
}
```

### 3.7 `getPendingApprovals` — 获取待审批列表

```typescript
// 请求
{ action: "getPendingApprovals", runId: string }

// 响应 data（PendingApproval[]）
[{
  runId: string,
  nodeId: string,
  approvalToken: string,  // 用于 approve action
  expiresAt: string,      // ISO 8601 过期时间
  displayData?: unknown   // 审批展示数据（YAML 中 display_data 字段）
}]
```

### 3.8 `approve` — 审批通过

```typescript
// 请求
{
  action: "approve",
  runId: string,
  nodeId: string,
  token: string,          // approvalToken（从 getPendingApprovals 获取）
  data?: unknown          // 审批附带的额外数据（可选）
}

// 响应
{ success: true }
```

### 3.9 `listRuns` — 列出运行记录

```typescript
// 请求
{ action: "listRuns" }

// 响应 data（RunSummary[]）
[{
  run_id: string,
  project_id?: string,
  workflow_name: string,
  status: DAGStatus,
  started_at: string,     // ISO 8601
  completed_at?: string,  // ISO 8601
  node_summary: {
    total: number,
    completed: number,
    failed: number,
    running: number
  }
}]
```

### 3.10 `recover` — 崩溃恢复

从快照恢复执行（服务器崩溃后使用，需提供原始 YAML）。

```typescript
// 请求
{
  action: "recover",
  runId: string,
  yaml: string            // 原始工作流 YAML
}

// 响应 data — 同 run
{
  runId: string,
  status: DAGStatus,
  summary: RunSummary
}
```

---

## 4. 类型定义（TypeScript）

可直接复制到前端项目中使用：

```typescript
// ── 状态枚举 ──

type DAGStatus =
  | "PENDING" | "RUNNING" | "SUSPENDED"
  | "FAILED" | "CANCELLED" | "ERROR" | "SUCCESS";

type NodeStatus =
  | "PENDING" | "RUNNING" | "COMPLETED"
  | "FAILED" | "CANCELLED" | "SKIPPED";

type NodeType = "shell" | "agent" | "api" | "audit" | "workflow" | "loop";

type EventType =
  | "dag.started" | "dag.completed" | "dag.cancelled"
  | "node.started" | "node.completed" | "node.failed"
  | "node.cancelled" | "node.retrying" | "node.skipped"
  | "sub_workflow.started" | "sub_workflow.completed"
  | "loop.iteration_started" | "loop.iteration_completed"
  | "audit.requested" | "audit.approved";

// ── 核心数据结构 ──

interface NodeOutput {
  stdout: string;
  json?: unknown;
  exit_code: number;
  size?: number;
  ref?: string;
}

interface DAGEvent {
  event_id: string;
  run_id: string;
  node_id?: string;
  timestamp: string;
  type: EventType;
  node_type?: NodeType;
  metadata?: Record<string, unknown>;
}

interface DAGSnapshot {
  snapshot_id: string;
  run_id: string;
  last_event_id: string;
  timestamp: string;
  node_states: Record<string, { status: NodeStatus; exit_code?: number }>;
  dag_status: DAGStatus;
}

interface RunSummary {
  run_id: string;
  project_id?: string;
  workflow_name: string;
  status: DAGStatus;
  started_at: string;
  completed_at?: string;
  node_summary: { total: number; completed: number; failed: number; running: number };
}

interface DAGRunResult {
  runId: string;
  status: DAGStatus;
  summary: RunSummary;
}

interface PendingApproval {
  runId: string;
  nodeId: string;
  approvalToken: string;
  expiresAt: string;
  displayData?: unknown;
}

// ── dryRun 结果 ──

interface DryRunResult {
  valid: boolean;
  issues: Array<{ type: "error" | "warning"; message: string; field?: string }>;
  executionPlan: {
    topologicalOrder: string[];
    parallelGroups: string[][];
  };
}

// ── API 请求/响应 ──

interface WorkflowApiResponse<T = unknown> {
  success: true;
  data: T;
}

interface WorkflowApiError {
  error: { type: string; message: string };
}
```

---

## 5. 封装 API Client

```typescript
// web/src/api/workflow-engine.ts

import { client } from "./client";

// Eden Treaty 调用
export const workflowEngineApi = {
  /** 执行工作流（同步，会阻塞到完成或 SUSPENDED） */
  async run(yaml: string, params?: Record<string, unknown>): Promise<DAGRunResult> {
    const res = await client.web.workflowEngine.post({
      action: "run",
      yaml,
      params,
    });
    return unwrap(res);
  },

  /** 校验 + 执行计划（不执行） */
  async dryRun(yaml: string): Promise<DryRunResult> {
    const res = await client.web.workflowEngine.post({ action: "dryRun", yaml });
    return unwrap(res);
  },

  /** 取消运行 */
  async cancel(runId: string): Promise<void> {
    await client.web.workflowEngine.post({ action: "cancel", runId });
  },

  /** 获取运行状态快照 */
  async getRunStatus(runId: string): Promise<DAGSnapshot | null> {
    const res = await client.web.workflowEngine.post({ action: "getRunStatus", runId });
    return unwrap(res);
  },

  /** 获取事件流 */
  async getEvents(runId: string, nodeId?: string): Promise<DAGEvent[]> {
    const res = await client.web.workflowEngine.post({ action: "getEvents", runId, nodeId });
    return unwrap(res);
  },

  /** 获取节点输出 */
  async getOutput(runId: string, nodeId: string): Promise<NodeOutput | null> {
    const res = await client.web.workflowEngine.post({ action: "getOutput", runId, nodeId });
    return unwrap(res);
  },

  /** 获取待审批列表 */
  async getPendingApprovals(runId: string): Promise<PendingApproval[]> {
    const res = await client.web.workflowEngine.post({ action: "getPendingApprovals", runId });
    return unwrap(res);
  },

  /** 审批通过 */
  async approve(runId: string, nodeId: string, token: string, data?: unknown): Promise<void> {
    await client.web.workflowEngine.post({ action: "approve", runId, nodeId, token, data });
  },

  /** 列出运行记录 */
  async listRuns(): Promise<RunSummary[]> {
    const res = await client.web.workflowEngine.post({ action: "listRuns" });
    return unwrap(res);
  },

  /** 崩溃恢复 */
  async recover(runId: string, yaml: string): Promise<DAGRunResult> {
    const res = await client.web.workflowEngine.post({ action: "recover", runId, yaml });
    return unwrap(res);
  },
};

/** 解包 { success: true, data: T } 格式的响应 */
function unwrap<T>(res: { success: boolean; data?: T; error?: { type: string; message: string } }): T {
  if (res.success && res.data !== undefined) return res.data as T;
  throw new Error(res.error?.message ?? "Workflow engine request failed");
}
```

---

## 6. 前端页面建议

### 最小可用页面结构

```
/workflows                    — 工作流列表页（listRuns）
/workflows/new                — 新建/编辑工作流（YAML 编辑器）
/workflows/:runId             — 运行详情页（事件流 + 节点状态）
```

### 运行详情页关键交互

1. **状态轮询**：`getRunStatus` 每 2s 轮询，直到 `dag_status` 为终态（SUCCESS/FAILED/CANCELLED/ERROR）
2. **节点状态展示**：用 `node_states` 渲染每个节点的状态徽标（PENDING/RUNNING/COMPLETED/FAILED/SKIPPED）
3. **事件时间线**：`getEvents` 返回的事件流渲染为时间线，类似 CI/CD 的 log
4. **节点输出查看**：点击已完成节点，调用 `getOutput` 查看输出
5. **审批弹窗**：当 `dag_status === "SUSPENDED"` 时，调用 `getPendingApprovals`，展示审批卡片，用户点击"通过"调用 `approve`

### 状态颜色建议

| 状态 | 颜色 | 说明 |
|------|------|------|
| `PENDING` | 灰色 | 等待执行 |
| `RUNNING` | 蓝色（pulse 动画） | 执行中 |
| `COMPLETED` | 绿色 | 成功 |
| `FAILED` | 红色 | 失败 |
| `SKIPPED` | 灰色（斜线） | 被跳过 |
| `SUSPENDED` | 橙色 | 等待审批 |
| `CANCELLED` | 灰色 | 已取消 |
| `ERROR` | 红色 | 系统错误 |

---

## 7. YAML 格式参考

工作流使用 `schema_version: "1"` 的新格式，变量语法为 `${{ }}`。

### 基本结构

```yaml
schema_version: "1"
name: "my-workflow"
description: "示例工作流"
params:                          # 参数声明
  name:
    type: string
    default: "World"
secrets:                         # 密钥声明（从环境变量读取）
  - API_KEY
timeout: 300                     # DAG 级超时（秒）
nodes:
  - id: step1
    type: shell
    command: echo "Hello ${{ params.name }}"
  - id: step2
    type: api
    depends_on: [step1]
    url: "https://api.example.com/data"
    method: POST
    headers:
      Authorization: "Bearer ${{ secrets.API_KEY }}"
    body: '{"key": "${{ nodes.step1.output.stdout }}"}'
  - id: step3
    type: agent
    depends_on: [step2]
    prompt: "分析以下数据: ${{ nodes.step2.output.json }}"
    agent: "general"
    retry: { count: 2, backoff: exponential }
  - id: approve
    type: audit
    depends_on: [step3]
    display_data:
      message: "请审核 Agent 的分析结果"
    expires_in: 86400
```

### 变量引用规则

| 引用 | 说明 |
|------|------|
| `${{ params.xxx }}` | 根参数 |
| `${{ secrets.KEY }}` | 密钥（从环境变量读取） |
| `${{ nodes.<id>.output.stdout }}` | 节点标准输出 |
| `${{ nodes.<id>.output.json.xxx }}` | 节点 JSON 输出的字段 |
| `${{ nodes.<id>.status }}` | 节点状态（字符串） |

### 6 种节点类型

| type | 说明 | 必填字段 |
|------|------|---------|
| `shell` | Shell 命令 | `command` |
| `agent` | AI Agent | `prompt`, 可选 `agent`/`skill` |
| `api` | HTTP 请求 | `url`, 可选 `method`/`headers`/`body` |
| `audit` | 人工审批 | 可选 `display_data`/`expires_in` |
| `workflow` | 子流程 | `ref`（相对路径） |
| `loop` | 循环 | `condition`, `max_iterations`, `body` |

---

## 8. 与旧版 acpx-g 的关系

- **新引擎路由**：`POST /web/workflow-engine`（本文档描述的 API）
- **旧引擎路由**：`/workflow-ui/*` 和 `/api/v1/*`（acpx-g 反向代理，保留兼容）
- **两套系统共存**，前端可并行使用
- 旧版 WorkflowPage 当前是 iframe 容器嵌入 acpx-g UI，新页面为原生 React 组件

---

## 9. 注意事项

1. **`run` 是同步阻塞的** — 工作流可能运行很久，前端应异步发起（`fire-and-forget` 或后台任务），然后轮询 `getRunStatus`
2. **`run` 返回 `SUSPENDED`** — 表示工作流在 AuditNode 处暂停等待审批，前端应展示审批 UI
3. **`recover` 需要原始 YAML** — 前端应存储用户提交的 YAML，以便崩溃恢复时回传
4. **审批 Token 有过期时间** — 默认 24h，过期后需重新执行工作流
5. **大输出（>1MB）** — `getOutput` 返回的 `ref` 字段为外部存储路径，`stdout` 为空字符串
6. **多租户** — API 自动按当前 active team 过滤，无需前端传 teamId
