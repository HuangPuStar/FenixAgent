---
name: workflow-kanban-board
description: 工作流看板面板设计，基于 Kanban 布局编排工作流 Job 的创建、运行、审批和完成流程
---

# Workflow Kanban Board 设计文档

## 概述

在工作流管理页面新增「Kanban」tab，提供看板式的工作流运行编排界面。看板是工作流引擎的上层抽象，用户可以选择工作流、填写入参、创建 Job 卡片，通过手动触发执行、审批、重跑等操作管理工作流的运行生命周期。

## 设计决策汇总

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 实体模型 | 新建 `workflow_job` 表 | 与 `workflow_run` 解耦，Job 是 UI 编排概念，run 是引擎执行概念 |
| 触发方式 | 纯手动 | 看板核心价值是暂存区，直接跑用编辑器 |
| 定时触发 | 不支持 | 定时任务走现有 scheduler 模块 |
| 页面位置 | workflow 页第三个 tab | 与 Workflows/Run History 并列，职责清晰 |
| 完成列 | 合并一列，颜色区分 | 节省水平空间，筛选即可区分 |
| 完成列堆积 | 默认折叠 10 条 + 手动删除 | 避免自动移除丢失信息，历史查询走 Run History |
| 创建入口 | 看板内 + 工作流列表 | 看板主入口，列表页快捷跳转 |
| 入参来源 | 后端 `getParamDefs` API | 前端不解析 YAML，优先 published version |
| 版本绑定 | 创建时锁定 | 可复现，不随 latest 变化 |
| 重跑 | 原地重跑，同一卡片 | 符合看板心智模型 |
| 审批 | 看板上直接审批 | 审批是二选一操作，不需要看拓扑 |
| 实时更新 | 看板级 SSE | 一个连接推送所有 Job 变更 |
| 拖拽 | 不支持 | 状态由引擎驱动，不允许手动篡改 |
| 可见范围 | 组织级 | 支持团队协作 |
| 并发 | 不允许 | 同一 Job 同时只有一个活跃 run |
| 参数编辑 | 仅 ready 状态可编辑 | 暂存区允许修正参数 |

## 数据模型

### workflow_job 表

```sql
CREATE TABLE workflow_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,           -- 绑定的 YAML 版本号
  params JSONB,                       -- 用户填入的参数
  status VARCHAR(20) NOT NULL DEFAULT 'ready',
    -- ready / running / suspended / completed
  last_run_id VARCHAR,                -- 最近一次 run 的 ID
  last_dag_status VARCHAR(20),        -- SUCCESS / FAILED / CANCELLED / ERROR
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workflow_job_org ON workflow_job(organization_id);
CREATE INDEX idx_workflow_job_status ON workflow_job(organization_id, status);
CREATE INDEX idx_workflow_job_workflow ON workflow_job(workflow_id);
```

### 状态映射

| Job status | 看板列 | 触发条件 |
|------------|--------|----------|
| `ready` | 准备运行 | 创建时默认 |
| `running` | 运行中 | 用户点运行 → `engine.runAsync()` |
| `suspended` | 待审批 | 引擎 run 进入 SUSPENDED 状态 |
| `completed` | 已完成 | run 到达终态（SUCCESS/FAILED/CANCELLED/ERROR） |

### 状态流转

```
ready ──[用户点运行]──→ running ──[run 成功]──→ completed
                            │                       ↑
                            ├──[audit 节点]──→ suspended
                            │                       │
                            └──[run 失败/取消]──→ completed
                                                     │
                          completed ──[用户点重跑]──→ running
```

`completed` 状态的 Job 重跑时回到 `running`，`runCount` 递增，`lastRunId` 指向新 run。

## 后端 API

### 新增路由：POST /web/workflow-jobs

action 分发模式，与现有 `workflow-defs` / `workflow-engine` 路由一致。

#### create

创建 Job。

```typescript
// Request
{
  action: "create",
  workflowId: string,
  params?: Record<string, unknown>
}

// Response
{
  success: true,
  data: { id, status: "ready", workflowId, version, params, ... }
}
```

行为：
1. 查询 workflow 定义，获取 `latestVersion`（无 published version 则使用 draft，version = 0）
2. 插入 `workflow_job` 记录，status = `ready`
3. 发布 `job.created` SSE 事件

#### updateParams

修改参数（仅 `ready` 状态允许）。

```typescript
// Request
{
  action: "updateParams",
  jobId: string,
  params: Record<string, unknown>
}
```

#### run

触发运行。

```typescript
// Request
{
  action: "run",
  jobId: string
}

// Response
{
  success: true,
  data: { runId }
}
```

行为：
1. 校验 Job 状态为 `ready` 或 `completed`
2. 读取绑定版本号的 YAML（调 `getVersionYaml`）
3. 调 `engine.runAsync(yaml, job.params)`
4. 更新 Job：status = `running`，lastRunId = runId，runCount++
5. 发布 `job.started` SSE 事件
6. result Promise 回调中：更新 Job status 为 `completed`，lastDagStatus 为终态
7. 发布 `job.completed` SSE 事件

SUSPENDED 状态检测（独立于 result Promise）：
- 在 `run` action 触发后，启动一个 per-run 的监听器，订阅 EventBus 中的 `audit.requested` 事件（workflow-engine 已有此事件类型）
- 收到 `audit.requested` 事件且 `runId === job.lastRunId` 时，更新 Job status = `suspended`
- 发布 `job.suspended` SSE 事件
- 审批通过后引擎发出 `audit.approved` 事件，此时更新 Job status = `running`，发布 `job.started` SSE 事件

#### cancel

取消运行。

```typescript
// Request
{
  action: "cancel",
  jobId: string
}
```

行为：
1. 调 `engine.cancel(job.lastRunId)`
2. 更新 Job：status = `completed`，lastDagStatus = `CANCELLED`
3. 发布 `job.completed` SSE 事件

#### getPendingApprovals

获取 Job 的待审批节点列表。

```typescript
// Request
{
  action: "getPendingApprovals",
  jobId: string
}

// Response
{
  success: true,
  data: [
    { nodeId, token, displayData, expiresIn }
  ]
}
```

行为：调 `engine.getPendingApprovals(job.lastRunId)` 透传返回。前端用此信息渲染审批按钮和提示语。

#### approve

审批通过。

```typescript
// Request
{
  action: "approve",
  jobId: string,
  nodeId: string,
  token: string,
  data?: unknown
}
```

行为：
1. 校验 Job 状态为 `suspended`
2. 调 `engine.approveNode(job.lastRunId, nodeId, token, data)`
3. 更新 Job：status = `running`
4. 发布 `job.started` SSE 事件

#### delete

删除 Job。运行中的 Job 需先取消。

```typescript
// Request
{
  action: "delete",
  jobId: string
}
```

#### list

列出当前组织所有 Job。

```typescript
// Response
{
  success: true,
  data: [
    {
      id, status, params, lastRunId, lastDagStatus, runCount,
      workflowId, workflowName, version,
      userId, userName,
      createdAt, updatedAt,
      // 运行中/已完成时的附加信息
      startedAt, completedAt, nodeSummary
    }
  ]
}
```

list 需要关联查询：
- workflow 表获取名称
- user 表获取创建人名称
- workflow_snapshot 获取 run 的 nodeSummary 和时间信息

#### get

获取单个 Job 详情（含完整运行信息）。

### 现有路由扩展：POST /web/workflow-defs

#### getParamDefs（新增 action）

解析工作流参数定义。

```typescript
// Request
{
  action: "getParamDefs",
  workflowId: string,
  version?: number   // 可选，不传时用最新 published version
}

// Response
{
  success: true,
  data: {
    version: number,           // 实际使用的版本号
    params: Record<string, {
      type?: "string" | "number" | "boolean" | "object",
      default?: unknown,
      required?: boolean
    }>
  }
}
```

行为：
1. 有 `version` 参数 → 读取指定版本的 YAML
2. 无 `version` → 获取 workflow 的 `latestVersion`
3. 有 published version → 读取该版本 YAML
4. 无 published version → 读取 draft（version 0）
5. 解析 `params` 字段返回

### SSE 端点：GET /web/workflow-jobs/events

- per-organization EventBus
- 事件格式：`{ type: "job.xxx", jobId, data }`
- 支持 `Last-Event-ID` / `fromSeqNum` 断线重连
- keepalive 15s

事件类型：
- `job.created` — Job 创建
- `job.started` — Job 开始运行（包括审批后恢复）
- `job.suspended` — Job 等待审批
- `job.completed` — Job 运行完成（含成功/失败/取消/错误）
- `job.deleted` — Job 被删除
- `job.params_updated` — 参数被修改

## 前端 UI

### 页面结构

在 `web/src/routes/agent/_panel/workflow.tsx` 新增第三个 tab：

```
┌──────────────────────────────────────────────────┐
│  [Pencil Workflows]  [Kanban Kanban]  [History Runs]  │
├──────────────────────────────────────────────────┤
│                                                  │
│              Kanban 内容区                         │
│                                                  │
└──────────────────────────────────────────────────┘
```

### 看板布局

四列水平排列，等宽（flex 均分），列间有分割线。

```
┌──────────┬──────────┬──────────┬──────────┐
│ 准备运行  │  运行中   │ 待审批    │ 已完成    │
│   (3)    │   (1)    │   (2)    │   (5)    │
├──────────┼──────────┼──────────┼──────────┤
│ [卡片]   │ [卡片]   │ [卡片]   │ [卡片]   │
│ [卡片]   │          │ [卡片]   │ [卡片]   │
│ [卡片]   │          │          │ [卡片]   │
│          │          │          │  ···     │
│          │          │          │ 查看更多  │
│          │          │          │ [卡片]   │
│          │          │          │ [卡片]   │
└──────────┴──────────┴──────────┴──────────┘
```

每列：
- 列头：标题 + 计数 badge
- 列体：卡片纵向排列，溢出滚动
- 完成列：默认显示最近 10 条，底部「查看更多」展开

### 卡片组件（KanbanCard）

```
┌─────────────────────────────┐
│ 工作流名称              [···] │  ← 三点菜单
│ 入参: key1=val1, key2=va... │  ← 超长截断 hover tooltip
│ ● Running  2m 30s           │  ← 状态点 + 时长
│ ━━━━━░░░░  3/7              │  ← 进度条（仅运行中）
│ 创建人 · 5 min ago           │  ← 底部元信息
└─────────────────────────────┘
```

不同列的卡片差异：

| 列 | 状态显示 | 进度条 | 操作 |
|----|---------|--------|------|
| 准备运行 | `○ Ready` | 无 | 运行、编辑参数、删除 |
| 运行中 | `● Running` + 脉冲动画 | 有 | 取消 |
| 待审批 | `◉ Awaiting Approval` | 有（停在审批节点） | 审批通过 |
| 已完成 | `✓ Success` 绿 / `✗ Failed` 红 | 无 | 重新运行、删除 |

三点菜单项根据状态动态显示。

### 创建 Job 对话框（KanbanJobDialog）

1. 下拉选择工作流（调 `workflow-defs list`，展示名称 + 描述）
2. 选择后加载参数定义（调 `getParamDefs`）
3. 根据参数定义动态渲染表单：
   - `string` → 文本输入
   - `number` → 数字输入
   - `boolean` → 开关
   - `required` 标记必填
   - `default` 预填默认值
4. 确认创建

### 审批交互

待审批卡片展示审批信息：
- 审批节点 ID
- 审批提示语（audit 节点的 `display_data`）
- 「通过」按钮

点击通过后调 `workflow-jobs approve` action。审批通过后卡片自动移回运行中列。

### 工作流列表页快捷入口

在 `WorkflowList` 组件的每个工作流行增加「添加到看板」按钮（`KanbanSquare` 图标），点击后：
1. 切换到 Kanban tab
2. 自动打开创建对话框
3. 预选当前工作流

### 实时更新

- 前端通过 `EventSource` 订阅 `/web/workflow-jobs/events`
- 收到事件后根据 `jobId` 更新对应卡片状态
- 运行中的卡片通过 `setInterval` 每秒刷新时长显示
- 断线自动重连（`Last-Event-ID`）

## i18n

新增命名空间 `kanban`（NS.KANBAN），中英双语翻译文件。

覆盖所有看板相关文字：列标题、按钮、状态标签、对话框文案、toast 消息等。

## 文件清单

### 后端新增

| 文件 | 说明 |
|------|------|
| `src/db/schema.ts` | 新增 `workflowJob` 表定义 |
| `drizzle/` | 迁移文件（`drizzle-kit generate`） |
| `src/repositories/workflow-job.ts` | Job 数据访问层 |
| `src/routes/web/workflow-jobs.ts` | Job API 路由（action 分发） |
| `src/routes/web/workflow-jobs-sse.ts` | 看板 SSE 端点 |
| `src/services/workflow/workflow-job-events.ts` | 看板事件 bus + publish |
| `src/schemas/workflow-job.schema.ts` | 请求体校验 schema |

### 后端修改

| 文件 | 说明 |
|------|------|
| `src/routes/web/workflow-defs.ts` | 新增 `getParamDefs` action |
| `src/routes/web/workflow-engine.ts` | run/cancel 回调中同步 Job 状态 |

### 前端新增

| 文件 | 说明 |
|------|------|
| `web/src/pages/workflow/WorkflowKanban.tsx` | 看板主组件 |
| `web/src/pages/workflow/components/KanbanCard.tsx` | 卡片组件 |
| `web/src/pages/workflow/components/KanbanJobDialog.tsx` | 创建/编辑 Job 对话框 |
| `web/src/pages/workflow/components/KanbanColumn.tsx` | 看板列组件 |
| `web/src/api/workflow-jobs.ts` | Job API 客户端 |
| `web/src/i18n/locales/en/kanban.json` | 英文翻译 |
| `web/src/i18n/locales/zh/kanban.json` | 中文翻译 |

### 前端修改

| 文件 | 说明 |
|------|------|
| `web/src/routes/agent/_panel/workflow.tsx` | 新增 Kanban tab |
| `web/src/pages/workflow/WorkflowList.tsx` | 新增「添加到看板」按钮 |
| `web/src/i18n/index.ts` | 注册 kanban 命名空间 |
