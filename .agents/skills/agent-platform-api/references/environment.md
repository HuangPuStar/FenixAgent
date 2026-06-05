---
name: api-environment
description: 环境（Environment）管理 API。当需要"列出环境"、"创建环境"、"进入环境"、"查看实例"、"删除环境"、"更新环境配置"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Environment API

管理 Agent 运行环境（Environment）。

## 列出所有环境

```bash
curl -s "$USER_META_BASE_URL/web/environments" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.environments[] | { id, name, agentConfigId, autoStart }'
```

返回数组，每个元素包含 `id`、`name`、`description`、`agentConfigId`、`autoStart`、`createdAt`、`updatedAt`。

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
  }' | jq '{ id: .id, name: .name, secret: .secret }'
```

返回完整环境对象，包含 `id`、`secret`、`userId`、`organizationId`。

## 查询单个环境

```bash
curl -s "$USER_META_BASE_URL/web/environments/<ENV_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq .
```

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
  jq '.instances[] | { id, status, createdAt }'
```

## 从环境 spawn 新实例

```bash
curl -s -X POST "$USER_META_BASE_URL/web/instances/from-environment" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"environmentId": "<ENV_ID>"}' | \
  jq '.data | { instanceId, environmentId, status }'
```

## 删除实例

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/instances/<INSTANCE_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```
