# Workflow Trigger 设计文档

**日期**：2026-05-26
**状态**：Draft

## 概述

为 Workflow 引入触发器（Trigger）机制，支持通过 public URL 接收外部事件并触发 workflow 执行。首个触发类型为 `webhook`，用于 GitHub webhook 等场景。

## 背景

用户需要将 GitHub repo 的事件（push、PR、issue 等）接入 RCS workflow，走智能体处理流程。核心诉求：

- 多个 GitHub repo 各自绑定不同的 workflow
- 事件类型由用户自由配置
- 鉴权通过不可猜测的 hash URL 实现（public 模式无需额外认证）
- Payload 直接作为 workflow inputs 传入，用户通过 sub-YAML 格式化处理

## 数据模型

### `workflow_trigger` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `organizationId` | string | 所属组织 |
| `workflowId` | string | 关联的 workflow |
| `type` | enum (`webhook`, `cron`, `message_queue`) | 触发类型，未来扩展 |
| `publicHash` | string | 唯一 hash，作为 URL 路径（仅 webhook 类型） |
| `secret` | string? | 可选的 HMAC secret（用户需要时配置，public 模式不强制） |
| `config` | JSONB | 触发器专属配置（webhook 可存事件过滤规则等） |
| `enabled` | boolean | 是否启用 |
| `createdAt` | timestamp | 创建时间 |
| `updatedAt` | timestamp | 更新时间 |

索引：

- `unique(publicHash)` — hash 唯一约束
- `idx_workflow_trigger_org_workflow(organizationId, workflowId)` — 按组织 + workflow 查询

### Schema 变更

在 `src/db/schema.ts` 新增 `workflowTrigger` 表定义，通过 `drizzle-kit generate` 生成迁移。

## 路由设计

### `POST /hooks/:publicHash` — Webhook 接收端点

- **不挂 authGuardPlugin**，独立于 `/web/*` 路由体系
- 在 `src/index.ts` 中挂载到 `/hooks/*` 前缀
- 处理逻辑独立为 `src/routes/hooks.ts`

**处理流程**：

```
POST /hooks/{publicHash}
  → 查 workflow_trigger 表（WHERE publicHash = ? AND enabled = true）
  → 未找到或 disabled → 404 { error: "trigger not found" }
  → 取出 workflowId + organizationId
  → 检查 workflow 是否存在，不存在则自动 disable trigger 并返回 500
  → 构造 inputs: { headers, body, query, triggerType }
  → 调用 getTeamEngine(orgId).run(yaml, inputs)
  → 立即返回 200 { received: true }（fire-and-forget）
```

**请求体限制**：1MB 上限。

## 数据流

```
GitHub webhook POST payload
  → POST /hooks/{publicHash}
  → 查 workflow_trigger 表 → 得到 workflowId + orgId
  → 从 workflow 表取出 YAML 定义
  → engine.run(yaml, inputs)
  → Workflow 第一个节点（格式化 script）处理 raw payload
  → 下游智能体节点拿到结构化数据执行
```

### 传入 engine.run 的 inputs 结构

```json
{
  "headers": { "x-github-event": "push", "x-github-delivery": "xxx", ... },
  "body": { "ref": "refs/heads/main", "repository": { ... }, "commits": [...] },
  "query": {},
  "triggerType": "webhook"
}
```

### Sub-YAML 格式化

用户在 workflow YAML 的开头定义 transform/script 节点，从 `${inputs.body}` 提取关键字段，输出结构化数据供下游使用。完全由用户编写，后端无特殊处理。

示例：

```yaml
nodes:
  - id: format_github_event
    type: script
    source: |
      const body = inputs.body;
      const eventType = inputs.headers['x-github-event'];
      outputs.event_type = eventType;
      outputs.repo = body.repository.full_name;
      outputs.action = body.action;
      outputs.pr_number = body.number;
      outputs.sender = body.sender.login;
    depends_on: []

  - id: agent_process
    type: agent
    prompt: "处理 ${format_github_event.outputs.event_type} 事件..."
    depends_on: [format_github_event]
```

## Trigger 管理 API

在现有 `POST /web/workflow-engine` 路由基础上，新增 trigger 相关 action 分发：

| action | 说明 | 请求字段 |
|--------|------|----------|
| `createTrigger` | 创建触发器，自动生成 publicHash，返回完整 webhook URL | `workflowId`, `type`, `config?` |
| `listTriggers` | 列出当前 workflow 下的所有触发器 | `workflowId` |
| `deleteTrigger` | 删除触发器，URL 立即失效 | `triggerId` |
| `regenerateHash` | 重新生成 publicHash（旧 URL 作废） | `triggerId` |
| `enableTrigger` | 启用触发器 | `triggerId` |
| `disableTrigger` | 禁用触发器 | `triggerId` |

所有 action 需要 `sessionAuth: true`，并校验 trigger 归属当前组织。

### createTrigger 请求/响应示例

**请求**：

```json
{
  "action": "createTrigger",
  "workflowId": "wf_xxx",
  "type": "webhook",
  "config": { "eventFilter": ["push", "pull_request"] }
}
```

**响应**：

```json
{
  "success": true,
  "data": {
    "id": "trig_xxx",
    "publicHash": "a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5",
    "webhookUrl": "https://your-domain/hooks/a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5",
    "type": "webhook",
    "enabled": true
  }
}
```

### 安全：publicHash 展示策略

- `createTrigger` 和 `regenerateHash` 返回完整的 webhookUrl（唯一获取完整 URL 的时机）
- `listTriggers` 返回 masked publicHash（前 6 位 + `***`），防止日志/响应泄露

## 错误处理

| 场景 | 响应 |
|------|------|
| publicHash 不存在 | `404 { error: "trigger not found" }` |
| trigger 已 disabled | `404 { error: "trigger not found" }`（不暴露 disabled 状态） |
| workflow 不存在或已删除 | `500 { error: "workflow not found" }`，自动 disable 该 trigger |
| engine.run 执行失败 | 返回 `200 { received: true }`，后台 console.error 记录 |
| 请求体超过 1MB | `413 { error: "payload too large" }` |

### 关键设计决策

- **fire-and-forget**：`/hooks/:hash` 立即返回 200，workflow 异步执行。GitHub webhook 期望快速响应（超 10s 超时重试）
- **workflow 删除级联清理**：删除 workflow 时自动删除关联的所有 trigger
- **重复请求**：GitHub 重试可能导致重复触发，由 workflow 内部幂等处理，trigger 层不做去重

## 涉及的文件变更

| 文件 | 变更 |
|------|------|
| `src/db/schema.ts` | 新增 `workflowTrigger` 表定义 |
| `drizzle/` | `drizzle-kit generate` 生成迁移文件 |
| `src/routes/hooks.ts` | 新增，`POST /hooks/:publicHash` 处理逻辑 |
| `src/index.ts` | 挂载 `/hooks/*` 路由 |
| `src/routes/web/workflow-engine.ts` | 新增 trigger 相关 action 分发 |
| `src/repositories/workflow-trigger.ts` | 新增，trigger 数据访问层 |
| `src/services/workflow-trigger.ts` | 新增，trigger 业务逻辑 |
| `src/schemas/workflow-trigger.schema.ts` | 新增，trigger 请求验证 schema |

## 未来扩展

- `type: "cron"`：定时触发，复用现有 scheduler 基础设施
- `type: "message_queue"`：消息队列触发（Redis Streams / RabbitMQ 等）
- 可选 HMAC 签名验证：在 trigger 配置 secret 后自动验证 `X-Hub-Signature-256`
