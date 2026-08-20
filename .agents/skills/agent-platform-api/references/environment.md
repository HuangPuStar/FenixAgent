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
  jq '.data[] | { id, name, agent_config_id, auto_start, instances_count }'
```

返回 `{ success: true, data: [...] }`，每个元素包含 `id`、`name`、`description`、`workspace_path`、`agent_config_id`、`agent_name`、`status`、`machine_name`、`branch`、`auto_start`、`last_poll_at`、`created_at`、`updated_at`、`session_id`、`instance_status`、`instance_id`、`instances`（数组）、`instances_count`。

## 创建环境

```bash
curl -s -X POST "$USER_META_BASE_URL/web/environments" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-env",
    "description": "测试环境",
    "agentConfigId": "<Agent 配置 ID>",
    "autoStart": false
  }' | jq '.data | { id, name, secret }'
```

返回 `{ success: true, data: {...} }`，`data` 中的 environment 字段全部为 snake_case：`id`、`name`、`description`、`workspace_path`、`agent_config_id`、`status`、`machine_name`、`branch`、`auto_start`、`last_poll_at`、`created_at`、`updated_at`、`secret`。

> 后端出于安全考虑在响应中剥离了 `user_id` / `organization_id` 字段。归属信息由 API Key 元数据 (`$USER_META_USER_ID` / `$USER_META_ORG_ID`) 提供，无需从返回体读取。

## 查询单个环境

```bash
curl -s "$USER_META_BASE_URL/web/environments/<ENV_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```

返回与创建相同的字段集合，包含 `secret`。

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
  }' | jq '.data'
```

所有字段均为可选，只传需要更新的字段。

## 删除环境

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/environments/<ENV_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```

## 进入环境（进入已有运行实例）

```bash
curl -s -X POST "$USER_META_BASE_URL/web/environments/<ENV_ID>/enter" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | jq '.data | { session_id, instance_id }'
```

可选参数 `instance_number` 指定启动第几个实例。

返回 `{ success: true, data: {...} }`，`data` 包含 `session_id`、`instance_id`、`instance_number`、`instance_status`、`environment_id`。

`enter` 不会在无实例时自动创建并启动实例；它用于进入已有运行实例。环境尚无运行实例且 `autoStart:false` 时，调用会返回 HTTP 500 `CONFIG_WRITE_ERROR`（`Instance not running and autoStart is disabled`）。需要创建并启动新实例时使用下方的 `POST /web/instances/from-environment`。

该调用还依赖环境绑定的 Agent 配置、Sandbox/运行时和实例配额。运行条件不满足时，可能返回 `CONFIG_WRITE_ERROR`、`SERVICE_UNAVAILABLE` 或 HTTP 429；按主 Skill 的失败响应规则处理，不能只用 `.data` 判断结果。

## 查看环境下的实例列表

```bash
curl -s "$USER_META_BASE_URL/web/environments/<ENV_ID>/instances" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.data.instances[] | { id, status, created_at }'
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

创建实例会受 Agent 总并发、当前用户并发和运行时状态限制；HTTP 429 代表并发限制，错误体可能由全局错误处理返回 `error.type`，而非本模块的 `success: false/error.code` 形状。

## 删除实例

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/instances/<INSTANCE_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```
