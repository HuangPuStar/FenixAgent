# Workflow 运行记录优化 + 删除看板/统计

## 概述

删除 Workflow 模块的统计页面和看板页面，将运行记录从卡片列表重构为标准表格 + 分页视图，同时将运行记录 API 从 `POST /web/workflow-engine { action: "listRuns" }` 迁移为 RESTful `GET /web/workflow-runs`。

## 决策记录

### Tab 简化
- `workflow.tsx` Tab 栏从 4 个缩减为 2 个：列表 + 运行记录
- 删除 WorkflowStats、WorkflowKanban 及所有关联组件

### API 标准化
- 新增 `GET /web/workflow-runs?page=&pageSize=&status=&q=`
- 不向下兼容旧 API action，其他调用方同步迁移

### 表格视图
- 6 列表格：工作流名称 / 状态 / 进度 / 开始时间 / 耗时 / 操作
- 前端分页组件：页码省略号、pageSize 切换 (20/50/100)

### i18n
- 删除 kanban namespace
- 删除 stats_* 翻译 key
- 新增 runs 表格相关翻译 key

## 变更范围

### 后端
- 新增 `src/routes/web/workflow-runs.ts` — GET /web/workflow-runs 路由
- 新增 schema `WorkflowRunsQuerySchema`
- 修改 `src/services/workflow/pg-storage-adapter.ts` — listRuns 支持分页
- 修改 `src/routes/web/index.ts` — 注册新路由
- 修改 `src/schemas/workflow.schema.ts` — 移除旧 listRuns action schema

### SDK
- 修改 `packages/sdk/src/modules/workflow-engine.ts` — 新增 listRuns(分页) 方法

### 前端
- 删除 12 个文件（统计/看板相关）
- 修改 `workflow.tsx` — Tab 简化
- 重写 `WorkflowRuns.tsx` — 表格 + 分页
- 新增 `Pagination.tsx` — 分页组件
- 修改 `web/src/api/workflow-engine.ts` — 适配新 API
- 修改 `web/src/i18n/locales/{en,zh}/workflows.json` — 删除/新增 key
- 删除 `web/src/i18n/locales/{en,zh}/kanban.json`
- 修改 `web/src/i18n/index.ts` — 移除 kanban namespace
- 修改 `RunListPanel.tsx`、`useWorkflowRun.ts` — 适配新 API

### 测试
- 后端：pg-storage-adapter 分页逻辑 + 路由集成测试
- 前端：WorkflowRuns 表格渲染 + Pagination 组件测试
