# 组织默认引擎设置

日期：2026-07-08

## 概述

组织管理员可为组织设置默认的引擎类型（`engineType`）和远程执行节点（`machineId`）。设置后，该组织内创建的所有新 Agent 将自动预填这些默认值，用户可手动覆盖。

核心卖点：组织配置一次远程节点，后续所有 Agent 自动继承，无需每个 Agent 单独选择。

## 功能范围

| 项 | 说明 |
|---|---|
| 默认引擎类型 | `engineType`：opencode / ccb / claude-code |
| 默认远程节点 | `machineId`：远程 Machine 的 ID（空字符串 = 本地执行） |
| 默认模型 | **不在范围内**（`modelId` 不从 org 默认值继承） |
| 覆盖行为 | Agent 创建时表单预填默认值，用户可修改 |
| 权限 | 仅 `owner` 角色可修改默认引擎设置 |

## 设计决策

### 存储：organization.metadata JSONB

在 `organization.metadata` 中新增 `defaultEngine` 对象：

```json
{
  "defaultEngine": {
    "engineType": "ccb",
    "machineId": "machine-shanghai-01"
  }
}
```

选择 `metadata` 而非新建表的原因：
- organization 表目前没有独立 settings 表，符合现有架构风格
- 改动最小，不需要迁移
- 后续可平滑迁移到独立表

### API：复用现有 PUT /web/organizations/:id

请求示例：
```json
PUT /web/organizations/:id
{
  "data": {
    "metadata": {
      "defaultEngine": {
        "engineType": "ccb",
        "machineId": "machine-shanghai-01"
      }
    }
  }
}
```

`UpdateOrganizationBodySchema` 中 `data: z.record(z.string(), z.unknown()).optional()` 已支持透传任意结构，无需改动。

响应中 `metadata` 字段自然包含 `defaultEngine`，获取组织详情时前端可直接读取。

### Agent 创建时的兜底逻辑

`POST /web/config/agents` 创建 Agent 时：

1. 如果请求体已传 `engineType` / `machineId` → 使用用户传入的值
2. 如果未传 → 从当前组织的 `metadata.defaultEngine` 读取兜底值
3. 如果组织也未设置 → 使用业务现有默认值（`engineType` 默认 `opencode`，`machineId` 默认 null/本地）

## 实现任务

### 1. 后端：Agent 创建兜底逻辑

**文件**：`src/repositories/agents.ts` 或 `src/routes/web/config/agents.ts`

在 Agent 创建路径中，从 `authContext.organizationId` 读取组织 metadata，填充未传入的 `engineType` / `machineId`。

```typescript
// 伪代码示意
if (!body.engineType && org.metadata?.defaultEngine?.engineType) {
  body.engineType = org.metadata.defaultEngine.engineType;
}
if (!body.machineId && org.metadata?.defaultEngine?.machineId) {
  body.machineId = org.metadata.defaultEngine.machineId;
}
```

### 2. 前端：组织管理页面

**文件**：`web/src/routes/organization/` 相关页面

在组织管理页面中新增"默认引擎设置"卡片/区域：
- 引擎类型下拉选择（opencode / ccb / claude-code）
- 远程节点下拉选择（从 Machine 列表获取）
- 仅 `owner` 角色可编辑
- 保存时调 `PUT /web/organizations/:id`

### 3. 前端：Agent 创建表单

**文件**：`web/src/pages/` 中 Agent 创建相关页面

- Agent 创建表单打开时，从组织详情获取 `metadata.defaultEngine`
- 预填 `engineType` 和 `machineId` 字段
- 用户可修改

## 非目标

- 不锁定 Agent 创建时的引擎选择
- 不影响已创建的 Agent
- 不处理多租户下的组织继承（每个组织独立设置）
- 不包含模型（modelId）的默认值
