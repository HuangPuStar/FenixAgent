# Plan 07：Workflow 独立领域模块

## Context

Workflow 是 RCS 的独立领域模块，负责编排 Agent 的多步执行流程。当前代码中已有 `routes/web/workflow-proxy.ts` 反向代理到 acpx-g 引擎，但核心 Workflow 领域模型待设计实现。

## 现状分析

### 当前状态

| 文件 | 状态 |
|------|------|
| `src/routes/web/workflow-proxy.ts` | 已存在，反向代理到 acpx-g 引擎 |
| 其他 Workflow 代码 | 待设计 |

### Workflow 定位

- 独立领域模块，归 Team 所有
- 通过 Environment 操作 Agent（不直接接触 Instance 或 acp-link）
- 提供 URL 入口，ScheduledTask 通过 HTTP 调用 Workflow URL 定时触发
- 封装 Environment 和 AgentConfig 的便捷调用方式

## 改动范围

### Phase 1：领域模型设计

**需要设计的内容**：

1. **Workflow 定义**：
   - 名称、描述
   - 步骤列表（steps）
   - 每个步骤：AgentConfig 引用、输入模板、输出处理
   - 条件分支、循环、并行执行

2. **Workflow 执行记录**：
   - 执行 ID、状态（running/completed/failed）
   - 每步骤执行结果
   - 输入/输出快照

3. **URL 入口**：
   - `POST /web/workflows/:id/run` — 触发执行
   - `GET /web/workflows/:id/runs` — 查询执行历史

### Phase 2：数据库表设计

```sql
-- Workflow 定义
CREATE TABLE workflow (
  id UUID PRIMARY KEY,
  team_id UUID NOT NULL,
  name VARCHAR NOT NULL,
  description TEXT,
  steps JSONB NOT NULL,     -- 步骤定义
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

-- Workflow 执行记录
CREATE TABLE workflow_run (
  id UUID PRIMARY KEY,
  workflow_id UUID NOT NULL,
  status VARCHAR NOT NULL,  -- running/completed/failed
  input JSONB,
  output JSONB,
  step_results JSONB,       -- 每步骤结果
  triggered_by VARCHAR,     -- manual/cron/api
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
```

### Phase 3：API 设计

```
POST   /web/workflows                    — 创建 Workflow
GET    /web/workflows                    — 列表
GET    /web/workflows/:id                — 详情
PUT    /web/workflows/:id                — 更新
DELETE /web/workflows/:id                — 删除
POST   /web/workflows/:id/run            — 触发执行
GET    /web/workflows/:id/runs           — 执行历史
GET    /web/workflows/:id/runs/:runId    — 执行详情
```

### Phase 4：执行引擎

- 简单版：顺序执行步骤，每步骤通过 Environment → Agent 发送任务
- 复杂版（后续）：条件分支、并行执行、错误重试

### 涉及文件

| 文件 | 说明 |
|------|------|
| `src/db/schema.ts` | 新增 workflow、workflow_run 表 |
| `src/repositories/workflow.ts` | Workflow 仓储 |
| `src/services/workflow.ts` | Workflow 服务 + 执行引擎 |
| `src/services/workflow-executor.ts` | 步骤执行器 |
| `src/routes/web/workflows.ts` | Workflow 路由 |
| `web/src/pages/WorkflowsPage.tsx` | Workflow 前端页面 |

## 实施策略

### 最小可行方案（MVP）

1. 单步骤 Workflow（类似当前 Task 但通过 Workflow 语义）
2. 同步执行，等待完成
3. 基础 CRUD + 触发
4. URL 入口可供 ScheduledTask 调用

### 后续扩展

- 多步骤编排
- 条件分支
- 并行执行
- 异步执行 + 回调

## 验证方式

```bash
# 单元测试
bun test src/__tests__/

# 集成验证
bun run dev
# 1. 创建 Workflow（单步骤，指定 AgentConfig）
# 2. POST /web/workflows/:id/run 触发执行
# 3. 查看执行历史和结果
# 4. ScheduledTask 调用 Workflow URL
```

## 依赖关系

- 依赖 Plan 06（ScheduledTask 简化为 HTTP Cron），Workflow 提供 URL 入口
- 可与 Plan 08-10 并行
- Plan 11（Team）需要在之前或并行（Workflow 归 Team 所有）
