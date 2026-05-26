# Workflow 编辑器 Meta Agent 事件上下文设计

> 日期：2026-05-25
> 状态：已确认，待实现

## 背景

Workflow 编辑器已集成 meta agent（通过 ChatPanel + scenePrompt），但 meta agent 只知道工作流 ID 和名称，无法感知运行时发生的错误和状态变化。用户需要手动描述问题，交互效率低。

## 目标

将 Workflow 编辑器运行时产生的系统信息（报错、运行状态摘要）通过 context queue 传递给 meta agent，使 agent 能主动了解当前发生了什么。

## 设计决策

| 维度 | 决策 | 理由 |
|------|------|------|
| 事件来源 | 前端截获已有的运行时信息 | 前端已通过 API 和事件流接收这些信息，不需要额外后端机制 |
| 捕获范围 | 错误完整保留 + 正常状态做摘要 | 错误需要完整信息供 agent 诊断；正常状态只保留最新摘要 |
| 封装方式 | 独立 hook（`useWorkflowEvents`） | WorkflowEditor 已很大（2500+ 行），抽离保持整洁 |
| 推送机制 | 每次调用 push 函数时立即更新 context queue | 简单直接，flushContext 时自然拿走最新内容 |
| 生命周期 | flush 后清空，和现有 context queue 一致 | 统一行为 |
| YAML 不传 | agent 自己通过文件系统读取 draft.yaml | 文件可能很大，agent 的 skill 已支持文件读取 |

## 组件设计

### 1. useWorkflowEvents Hook

**文件**：`web/src/lib/use-workflow-events.ts`

**接口**：

```typescript
interface WorkflowEventPushers {
  pushWorkflowError: (source: string, message: string) => void;
  pushWorkflowRunStatus: (summary: string) => void;
  clearWorkflowEvents: () => void;
}

function useWorkflowEvents(): WorkflowEventPushers;
```

**三个函数**：

- `pushWorkflowError(source, message)` — 记录一条错误。source 标识来源（如 `"validation"`、`"save"`、`"publish"`、`"run"`、`"node:shell_1"`），message 是错误内容。错误累积，不覆盖。
- `pushWorkflowRunStatus(summary)` — 记录运行状态摘要（如 `"工作流运行中，3/5 节点已完成"`）。每次调用覆盖上一次，只保留最新一条。
- `clearWorkflowEvents()` — 清空所有已记录的错误和状态摘要。

**内部实现**：

- 两个模块级变量：`string[]`（错误列表）和 `string | null`（运行状态摘要）
- 每次调用 push 函数时，重新拼接所有事件为文本，调用 `pushContext("workflow-events", text)` 更新 context queue
- 拼接格式：
  ```
  [工作流事件]
  运行状态: 工作流运行中，3/5 节点已完成
  错误 (validation): 循环依赖 detected: shell_1 → python_1 → shell_1
  错误 (save): 保存失败: Network error
  ```

### 2. buildRunSummary 辅助函数

从 `DAGSnapshot` 中提取状态摘要。

```typescript
function buildRunSummary(snap: DAGSnapshot): string | null
```

生成逻辑：
- 统计各状态的节点数量
- 如果有失败的节点，列出失败节点 ID
- 示例输出：
  - `"运行中 (2/5 完成, 1 失败: python_1)"`
  - `"运行成功 (5/5 完成)"`
  - `"等待审批 (audit_1)"`
  - `null`（无运行状态时）

### 3. WorkflowEditor 集成

**文件**：`web/src/pages/workflow/WorkflowEditor.tsx`

在 WorkflowEditor 顶部调用 hook：
```typescript
const { pushWorkflowError, pushWorkflowRunStatus, clearWorkflowEvents } = useWorkflowEvents();
```

**6 个插入点**：

| # | 位置 | 事件 | 调用 |
|---|------|------|------|
| 1 | `handleSaveDraft` catch 块 | 保存失败 | `pushWorkflowError("save", err.message)` |
| 2 | `handlePublish` catch 块 | 发布失败 | `pushWorkflowError("publish", err.message)` |
| 3 | `handleDryRun` catch 块 | 验证错误 | `pushWorkflowError("validation", err.message)` |
| 4 | `handleRun` catch 块（需新增） | 运行失败 | `pushWorkflowError("run", err.message)` |
| 5 | `loadRunData` 成功回调 | 运行状态变化 | `pushWorkflowRunStatus(buildRunSummary(snap))` |
| 6 | `handleRun` 开始时 | 清空旧事件 | `clearWorkflowEvents()` |

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `web/src/lib/use-workflow-events.ts` | 新建 | hook + buildRunSummary |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 调用 hook，6 个事件处理点插入调用 |

## 边界情况

- **无事件时**：context queue 中没有 `"workflow-events"` key，flushContext 不包含该内容
- **多次错误**：错误累积显示，不覆盖
- **运行状态频繁更新**：轮询每 2 秒更新一次摘要，但只保留最新一条
- **离开编辑器**：hook unmount 时 `removeContext("workflow-events")` 自动清理
- **handleRun 当前无 catch**：需要新增 try-catch 包裹 `workflowEngineApi.run()` 调用
