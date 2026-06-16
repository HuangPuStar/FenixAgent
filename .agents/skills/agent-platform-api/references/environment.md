---
name: api-environment
description: 环境（Environment）管理 API。当需要"列出环境"、"创建环境"、"进入环境"、"查看实例"、"删除环境"、"更新环境配置"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Environment API

管理 Agent 运行环境（Environment）。

> **重要**：所有 environment 路由都不读 query 参数，后端从 API Key 元数据自动取 `$USER_META_ORG_ID` 作为组织隔离范围。无需在 URL 或 body 中显式传 `organizationId`。

## 列出所有环境

```bash
curl -s "$USER_META_BASE_URL/web/environments" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.[] | { id, name, agent_config_id, auto_start, instances_count }'
```

返回**扁平数组**（无 `data` 包装），每个元素包含 `id`、`name`、`description`、`workspace_path`、`agent_config_id`、`agent_name`、`status`、`machine_name`、`branch`、`auto_start`、`last_poll_at`、`created_at`、`updated_at`、`session_id`、`instance_status`、`instance_id`、`instances`（数组）、`instances_count`。

## 创建环境

```bash
curl -s -X POST "$USER_META_BASE_URL/web/environments" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-env",
    "description": "测试环境",
    "agentConfigId": "<可选，Agent 配置 ID>",
    "autoStart": false
  }' | jq '{ id, name, secret }'
```

返回完整 environment 对象，**字段全部为 snake_case**：`id`、`name`、`description`、`workspace_path`、`agent_config_id`、`status`、`machine_name`、`branch`、`auto_start`、`last_poll_at`、`created_at`、`updated_at`、`secret`。

> 后端出于安全考虑在响应中剥离了 `user_id` / `organization_id` 字段。归属信息由 API Key 元数据 (`$USER_META_USER_ID` / `$USER_META_ORG_ID`) 提供，无需从返回体读取。

## 查询单个环境

```bash
curl -s "$USER_META_BASE_URL/web/environments/<ENV_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq .
```

返回与创建相同的字段集合（但不含 `secret`）。

## 更新环境

```bash
curl -s -X PUT "$USER_META_BASE_URL/web/environments/<ENV_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "new-name",
    "description": "更新后的描述",
    "agentConfigId": "<新的 Agent 配置 ID>",
    "autoStart": true
  }' | jq .
```

所有字段均为可选，只传需要更新的字段。

## 删除环境

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/environments/<ENV_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '{ ok: .ok }'
```

## 进入环境（创建会话 + 启动实例）

```bash
curl -s -X POST "$USER_META_BASE_URL/web/environments/<ENV_ID>/enter" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq '{ sessionId: .sessionId, instanceId: .instanceId }'
```

可选参数 `instance_number` 指定启动第几个实例。

返回 `sessionId`、`instanceId`、`environmentId`。

## 查看环境下的实例列表

```bash
curl -s "$USER_META_BASE_URL/web/environments/<ENV_ID>/instances" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.instances[] | { id, status, created_at }'
```

## 从环境 spawn 新实例

```bash
curl -s -X POST "$USER_META_BASE_URL/web/instances/from-environment" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"environmentId": "<ENV_ID>"}' | \
  jq '.data | { id, environment_id, status, session_id }'
```

返回 `{ success: true, data: {...} }`，`data` 字段为 snake_case：`id`、`port`、`status`、`error`、`group_id`、`environment_id`、`session_id`、`instance_number`、`created_at`。

## 删除实例

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/instances/<INSTANCE_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```
