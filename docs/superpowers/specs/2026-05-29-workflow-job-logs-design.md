---
name: workflow-job-logs
description: 工作流看板日志查看功能，支持实时查看 Job 执行过程中的节点状态和 stdout 输出
---

# Workflow Job Logs 设计文档

## 概述

在看板卡片上增加「查看日志」入口，点击后打开右侧抽屉（Sheet），实时展示 Job 执行过程中每个节点的状���变化和 stdout 输出。仅 running/completed 状态的卡片可查看。

## 设计决策汇总

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 交互方式 | 右侧 Sheet 抽屉 | 不打断看板操作，可同时查看日志和看板 |
| 日志内容 | 节点状态 + stdout | 用户最关心的信息：哪个节点在跑、输出是什么 |
| 实时机制 | SSE 推送节点事件 + 轮询 stdout | 复用现有 SSE 基础设施，stdout 轮询间隔 2s 够用 |
| 触发条件 | 仅 running/completed/suspended | ready 状态无日志可看，suspended 有活跃 run 可查看 |
| stdout 展示 | 终端风格（monospace + 深色背景） | 用户心智模型匹配「日志」概念 |
| 方案选择 | 方案 A：SSE + 轮询 | 复用现有基础设施，改动最小 |

## 后端 API

### 新增 SSE 端点：GET /web/workflow-jobs/:jobId/logs

实时推送 Job 对应 run 的 DAG 节点事件。

**认证**：sessionAuth + org 隔离（通过 `authCtx.organizationId`）

**行为**：
1. 查 Job 获取 `lastRunId`
2. 从 `workflowEvent` 表加载该 runId 的历史事件（按 timestamp 排序）
3. 订阅 organization kanban EventBus，过滤该 runId 相关事件
4. 过滤只转发节点状态事件：`node.started`、`node.completed`、`node.failed`、`node.cancelled`、`node.retrying`、`dag.completed`
5. 支持 `Last-Event-ID` / `fromSeqNum` 断线重连
6. keepalive 15s

**事件格式**：
```json
{
  "type": "node.started",
  "runId": "run_xxx",
  "nodeId": "node-a",
  "nodeType": "agent",
  "timestamp": "2026-05-29T10:00:00Z",
  "metadata": {}
}
```

### 新增 action：POST /web/workflow-jobs → getOutputs

获取 Job 最近一次 run 的所有节点输出。

```typescript
// Request
{ action: "getOutputs", jobId: string }

// Response
{
  success: true,
  data: [
    {
      nodeId: string,
      stdout: string,
      json: unknown | null,
      exitCode: number,
      size: number | null,
      createdAt: string
    }
  ]
}
```

行为：
1. 查 Job 获取 `lastRunId`
2. 查 `workflowNodeOutput` 表，WHERE `runId = lastRunId` AND `organizationId`
3. 按 `createdAt` 排序返回

## 前端 UI

### KanbanCard 改动

- running/completed/suspended 状态的卡片底部增加「查看日志」按钮（`ScrollText` 图标）
- 点击回调 `onViewLogs(job)`

### 新增 JobLogsSheet 组件

**布局**：

```
┌──────────────────────────────────┐
│  工作流名称          [Running ●] │  ← SheetHeader: 名称 + 状态 badge
├──────────────────────────────────┤
│ ● node-a (agent)    ✅ 2.3s      │  ← 节点行：状态图标 + 名称 + 耗时
│   ┌──────────────────────────┐   │
│   │ $ Processing input...    │   │  ← 展开的 stdout（终端风格）
│   │ $ Writing output...      │   │
│   │ Done.                    │   │
│   └──────────────────────────┘   │
│ ● node-b (agent)    🔄 running   │
│   ┌──────────────────────────┐   │
│   │ $ Starting...            │   │  ← 实时追加的 stdout
│   │ █                         │   │  ← 闪烁光标
│   └──────────────────────────┘   │
│ ○ node-c            ⏳ pending    │  ← 未开始
├──────────────────────────────────┤
│ 底部：总耗时 | 3/7 节点完成       │
└──────────────────────────────────┘
```

**节点状态图标映射**：

| 状态 | 图标 | 颜色 |
|------|------|------|
| pending | `○` (hollow circle) | gray |
| running | `●` (filled + pulse animation) | blue |
| completed | `✓` (check) | green |
| failed | `✗` (x) | red |
| cancelled | `⊘` | gray |

**交互**：
- 节点行可点击展开/折叠 stdout
- running 节点默认展开
- completed 节点默认折叠
- stdout 区域自动滚到底部（running 状态）
- 深色背景 + monospace 字体

### 实时更新机制

**SSE 连接**：
- 打开 Sheet 时建立 SSE 连接到 `/web/workflow-jobs/:jobId/logs`
- 关闭 Sheet 时断开

**事件处理**：
- `node.started` → 标记节点为 running，展开该节点
- `node.completed` → 标记节点为 completed，刷新该节点 stdout
- `node.failed` → 标记节点为 failed，刷新该节点 stdout
- `dag.completed` → 标记整体完成，停止轮询

**stdout 轮询**：
- 有 running 节点时，每 2 秒调 `getOutputs` 刷新 stdout
- 所有节点完成后停止轮询
- 抽屉关闭时停止轮询

### 文件清单

#### 后端新增

| 文件 | 说明 |
|------|------|
| `src/routes/web/workflow-jobs-logs.ts` | Job logs SSE 端点 |

#### 后端修改

| 文件 | 说明 |
|------|------|
| `src/routes/web/index.ts` | 注册新 SSE 路由 |
| `src/routes/web/workflow-jobs.ts` | 新增 `getOutputs` action |

#### 前端新增

| 文件 | 说明 |
|------|------|
| `web/src/pages/workflow/components/JobLogsSheet.tsx` | 日志抽屉主组件 |
| `web/src/api/workflow-job-logs.ts` | 日志 SSE + API 客户端 |

#### 前端修改

| 文件 | 说明 |
|------|------|
| `web/src/pages/workflow/components/KanbanCard.tsx` | 增加「查看日志」按钮 |
| `web/src/pages/workflow/WorkflowKanban.tsx` | 管理 JobLogsSheet 状态 |
| `web/src/i18n/locales/en/kanban.json` | 日志相关英文 key |
| `web/src/i18n/locales/zh/kanban.json` | 日志相关中文 key |
