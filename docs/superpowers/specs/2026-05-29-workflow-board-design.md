---
name: workflow-board
description: 工作流看板面板分组设计，支持一个 org 内创建多个 Board（看板面板），每个 Board 独立管理自己的 Job 卡片，Board 在 org 内共享可见
---

# Workflow Board 设计文档

## 概述

在现有 Workflow Kanban 基础上引入「Board」概念。Board 是 Job 的分组容器，一个 org 可以有多个 Board，每个 Board 拥有独立的 Job 看板视图。Workflow 定义保持 org 级共享，不受 Board 影响。Board 在 org 内共享可见，区分 Owner/Member 两种角色。

## 设计决策汇总

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 分组粒度 | Board 只包含 Job，不包含 Workflow 定义 | Workflow 是 org 级共享资源，不应被 Board 隔离 |
| 角色模型 | Owner（创建者）+ Member（其他 org 成员） | 二元角色满足需求，无需独立 member 表 |
| Owner 判定 | `workflow_board.userId` 直接判定 | 简单可靠，不需要关联表 |
| 默认 Board | 每个org 自动创建一个 default board | 避免空状态，新建 Job 始终有归属 |
| 切换方式 | 看板内下拉选择器 | 不改动侧边栏结构，改动最小 |
| 删除策略 | 级联删除 Job，不可删除 default board | 防止孤立 Job |
| Board 名称 | org 内唯一 | 避免混淆 |
| 方案选择 | 方案 A：独立表 + 简单角色 | 改动最小，满足需求 |

## 数据模型

### workflow_board 表（新增）

```sql
CREATE TABLE workflow_board (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  name VARCHAR(100) NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,  -- Owner
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_workflow_board_org_name ON workflow_board(organization_id, name);
CREATE INDEX idx_workflow_board_org ON workflow_board(organization_id);
```

### workflow_job 表（修改）

新增 `board_id` 列：

```sql
ALTER TABLE workflow_job ADD COLUMN board_id UUID NOT NULL REFERENCES workflow_board(id) ON DELETE CASCADE;
CREATE INDEX idx_workflow_job_board ON workflow_job(board_id);
```

### 关键约束

- 每个 org 有且仅有一个 `is_default = true` 的 Board
- `workflow_job.board_id` NOT NULL：每个 Job 必须属于一个 Board
- Board 名称在 org 内唯一（`idx_workflow_board_org_name`）
- 删除 Board 级联删除其下所有 Job
- `is_default = true` 的 Board 不允许删除
- Owner 通过 `workflow_board.userId` 判定，不需要独立的 member 表

## 后端 API

### 新增路由：POST /web/workflow-boards

action 分发模式，与现有 `workflow-defs` / `workflow-jobs` 路由一致。所有操作通过 `authCtx.organizationId` 做 org 隔离。

#### list

列出当前 org 下所有 Board。

```typescript
// Request
{ action: "list" }

// Response
{
  success: true,
  data: [
    { id, name, userId, isDefault, createdAt, updatedAt }
  ]
}
```

行为：
- 查询 `workflow_board` 表，WHERE `organizationId = authCtx.organizationId`
- 按 `createdAt` 排序（default board 排最前）
- 如果 org 下没有任何 board，自动创建 default board 并返回

#### get

获取单个 Board 详情。

```typescript
// Request
{ action: "get", boardId: string }

// Response
{
  success: true,
  data: { id, name, userId, isDefault, createdAt, updatedAt }
}
```

#### create

创建新 Board。所有 org 成员可创建。

```typescript
// Request
{ action: "create", name: string }

// Response
{
  success: true,
  data: { id, name, userId: authCtx.userId, isDefault: false, ... }
}
```

行为：
- 校验名称在 org 内唯一（违反返回 409 ConflictError）
- `userId` = 当前用户（即 Owner）
- `isDefault` = false

#### update

重命名 Board。仅 Owner 可操作。

```typescript
// Request
{ action: "update", boardId: string, name: string }

// Response
{ success: true, data: { id, name, ... } }
```

行为：
- 校验当前用户 === `board.userId`，不匹配返回 403
- 校验新名称在 org 内唯一
- 更新 `name` + `updatedAt`

#### delete

删除 Board。仅 Owner 可操作。

```typescript
// Request
{ action: "delete", boardId: string }

// Response
{ success: true, data: true }
```

行为：
- 校验当前用户 === `board.userId`，不匹配返回 403
- 校验 `isDefault !== true`，default board 不可删除（返回 400）
- 级联删除该 Board 下所有 Job（DB 外键 CASCADE 自动处理）

### 现有路由修改：POST /web/workflow-jobs

#### create（修改）

新增 `boardId` 参数，必填。

```typescript
// Request
{
  action: "create",
  boardId: string,       // 新增，必填
  workflowId: string,
  params?: Record<string, unknown>
}
```

行为不变，新增 `boardId` 写入 `workflow_job` 记录。

#### list（修改）

新增 `boardId` 参数，必填。

```typescript
// Request
{
  action: "list",
  boardId: string    // 新增，必填
}
```

行为：WHERE 条件增加 `boardId` 过滤。

### SSE 端点

`/web/workflow-jobs/events` 行为不变。事件 payload 中增加 `boardId` 字段，前端按当前选中的 board 过滤显示。

### 权限汇总

| 操作 | Owner | Member |
|------|-------|--------|
| 列出所有 Board | ✅ | ✅ |
| 查看某个 Board | ✅ | ✅ |
| 创建 Board | ✅ | ✅ |
| 重命名 Board | ✅ | ❌ |
| 删除 Board | ✅ | ❌ |
| 在 Board 中创建 Job | ✅ | ✅ |
| 运行/取消/审批 Job | ✅ | ✅ |
| 删除 Job | ✅ | ✅ |

## 前端 UI

### 看板 tab 顶部改造

在现有 Kanban toolbar 区域增加 Board 选择器：

```
┌──────────────────────────────────────────────────────────┐
│  [📋 默认看板 ▾]  [+ 新建看板]        [🔄 刷新]         │
├──────────┬──────────┬──────────┬──────────────────────────┤
│ 准备运行  │  运行中   │ 待审批    │ 已完成                   │
│  (3)     │   (1)    │   (2)    │   (5)                    │
├──────────┼──────────┼──────────┼──────────────────────────┤
│ [卡片]   │ [卡片]   │ [卡片]   │ [卡片]                   │
└──────────┴──────────┴──────────┴──────────────────────────┘
```

### Board 选择器（BoardSelector）

- 使用 Radix Popover 或 DropdownMenu 实现
- 展示所有 Board 列表，当前选中高亮
- 底部有「+ 新建看板」按钮
- 每个 Board 条目右侧有 `...` 菜单（仅 Owner 可见）：
  - 重命名：弹出内联编辑或对话框
  - 删除：确认后删除（default board 不可删除，菜单项禁用）

### 状态管理

- 当前选中的 `boardId` 存在 `WorkflowKanban` 组件的 state 中
- 首次加载时（无选中 board）自动选中 default board
- 切换 board 时重新加载 Job 列表（带 boardId 过滤）

### 创建 Job

- `KanbanJobDialog` 自动携带当前 `boardId`
- 不提供 board 切换（当前看板 = 当前 Board）

### 创建 Board

- 点击「+ 新建看板」弹出简单对话框（名称输入）
- 创建成功后自动切换到新 Board

### Default Board 自动创建

- 前端首次加载 Board 列表时，如果后端返回空，后端自动创建 default board
- Default board 名称由 i18n key 决定（`kanban:default_board_name`）

## 数据迁移策略

### 现有数据迁移

1. 创建 `workflow_board` 表
2. 为每个 `organizationId` 自动创建一个 default board（从 `workflow_job` 表中提取不重复的 `organizationId`）
3. `workflow_job` 新增 `board_id` 列（先允许 NULL）
4. 将所有现有 Job 的 `board_id` 更新为其 org 的 default board id
5. `workflow_job.board_id` 改为 NOT NULL
6. 添加外键约束

迁移 SQL 由 `drizzle-kit generate` 生成，但需要手写数据迁移脚本（设置 default board + 回填 board_id）。

### 新用户

当 org 首次进入看板页时，后端 `list` action 检测到无 board 时自动创建 default board。

## 文件清单

### 后端新增

| 文件 | 说明 |
|------|------|
| `src/db/schema.ts`（修改） | 新增 `workflowBoard` 表定义，`workflowJob` 增加 `boardId` |
| `drizzle/` | 迁移文件 |
| `src/repositories/workflow-board.ts` | Board 数据访问层 |
| `src/routes/web/workflow-boards.ts` | Board API 路由（action 分发） |
| `src/schemas/workflow-board.schema.ts` | 请求体校验 schema |

### 后端修改

| 文件 | 说明 |
|------|------|
| `src/routes/web/workflow-jobs.ts` | `create`/`list` 增加 `boardId` 参数 |
| `src/routes/web/workflow-jobs-sse.ts` | SSE 事件 payload 增加 `boardId` |
| `src/services/workflow/workflow-job-events.ts` | 事件发布时携带 `boardId` |

### 前端新增

| 文件 | 说明 |
|------|------|
| `web/src/api/workflow-boards.ts` | Board API 客户端 |
| `web/src/pages/workflow/components/BoardSelector.tsx` | Board 下拉选择器组件 |

### 前端修改

| 文件 | 说明 |
|------|------|
| `web/src/pages/workflow/WorkflowKanban.tsx` | 增加 Board 选择器、boardId state、Job 列表过滤 |
| `web/src/pages/workflow/components/KanbanJobDialog.tsx` | 创建 Job 时携带 boardId |
| `web/src/i18n/locales/en/kanban.json` | 英文翻译增加 Board 相关 key |
| `web/src/i18n/locales/zh/kanban.json` | 中文翻译增加 Board 相关 key |
| `web/src/i18n/index.ts` | 如需新增 namespace 则更新 |
