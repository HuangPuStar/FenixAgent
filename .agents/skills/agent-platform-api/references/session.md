---
name: api-session
description: 会话（Session）管理 API。当需要"列出会话"、"查看会话详情"、"获取会话历史"、"发送控制指令"、"中断会话"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Session API

管理 Agent 会话（Session），包括查询、历史回放和控制指令。

## 列出所有会话

```bash
curl -s "$USER_META_BASE_URL/web/sessions" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.[] | { id, title, status, environment_id, agent_name, created_at }'
```

返回数组，每个元素包含 `id`、`title`、`status`、`environment_id`、`agent_name`、`source`、`created_at`、`updated_at`。

## 查询会话详情

```bash
curl -s "$USER_META_BASE_URL/web/sessions/<SESSION_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq .
```

## 获取会话历史

```bash
curl -s "$USER_META_BASE_URL/web/sessions/<SESSION_ID>/history" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.events | length'
```

返回 `{ events: [...] }`，包含该会话所有消息事件。

## 发送事件到会话

```bash
curl -s -X POST "$USER_META_BASE_URL/web/sessions/<SESSION_ID>/events" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "user_message", "content": "你好"}' | \
  jq '{ status: .status }'
```

返回 `{ status: "ok", event: {...} }`。

## 发送控制指令

```bash
curl -s -X POST "$USER_META_BASE_URL/web/sessions/<SESSION_ID>/control" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type": "permission_response", "granted": true}' | \
  jq '{ status: .status }'
```

用于回复权限请求（如允许/拒绝工具调用）。

## 中断会话

```bash
curl -s -X POST "$USER_META_BASE_URL/web/sessions/<SESSION_ID>/interrupt" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '{ status: .status }'
```

立即中断当前正在执行的 Agent 操作。返回 `{ status: "ok" }`。
