---
name: api-task
description: 定时任务 V2 API。当需要"列出任务"、"创建定时任务"、"更新任务"、"删除任务"、"手动触发"、"查看日志"、"开关任务"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Task V2 API

管理定时任务（Scheduled Task V2），支持 HTTP 和 Agent 两种任务类型，cron 表达式调度。

> 所有端点前缀：`/web/tasks/v2`，响应统一为 `{ "success": true, "data": ... }` / `{ "success": false, "error": { ... } }`。

## 任务类型

| 类型 | 定义字段 | 说明 |
|------|----------|------|
| `http` | `{ url, method?, headers?, body? }` | HTTP 请求任务 |
| `agent` | `{ prompt }` | Agent 对话任务 |

## 分页列出任务

支持按名称关键字和类型筛选，服务端分页。

```bash
curl -s "$USER_META_BASE_URL/web/tasks/v2?page=1&pageSize=20" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.data | { items: [.items[] | { id, name, type, enabled, cron, lastStatus }], total, page, pageSize }'
```

查询参数：
- `page`（number，默认 1）：页码
- `pageSize`（number，默认 20）：每页条数
- `keyword`（string，可选）：按任务名称模糊搜索（大小写不敏感）
- `type`（`http` | `agent`，可选）：按任务类型筛选

## 创建任务

### HTTP 类型

```bash
curl -s -X POST "$USER_META_BASE_URL/web/tasks/v2" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "每日报告",
    "description": "每天早晨生成数据报告",
    "cron": "0 9 * * *",
    "timezone": "Asia/Shanghai",
    "timeoutSeconds": 300,
    "type": "http",
    "definition": {
      "url": "https://api.example.com/report",
      "method": "POST",
      "headers": {"Content-Type": "application/json"},
      "body": "{\"action\":\"daily\"}"
    }
  }' | jq '.data | { id, name, type, enabled }'
```

### Agent 类型

```bash
curl -s -X POST "$USER_META_BASE_URL/web/tasks/v2" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Agent 自动分析",
    "cron": "0 */6 * * *",
    "type": "agent",
    "agentId": "<AGENT_ID>",
    "definition": {
      "prompt": "请总结分析现在平台的整体运行情况和最新的运行趋势。"
    }
  }' | jq '.data | { id, name, type, enabled, agentId }'
```

字段说明：
- `name`（必填，1-128 字符）：任务名称
- `cron`（必填）：5 字段 cron 表达式，如 `*/5 * * * *`、`0 9 * * *`
- `type`（必填）：`http` 或 `agent`
- `definition`（必填）：任务定义，HTTP 类型为 `{ url, method?, headers?, body? }`，Agent 类型为 `{ prompt }`
- `agentId`（仅 agent 类型必填）：关联的 Agent ID
- `description`（可选）：任务描述
- `timezone`（可选）：时区，如 `Asia/Shanghai`
- `timeoutSeconds`（可选，默认 300）：超时秒数

## 查询任务详情

```bash
curl -s "$USER_META_BASE_URL/web/tasks/v2/<TASK_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```

返回字段：`id`, `name`, `description`, `cron`, `timezone`, `enabled`, `timeoutSeconds`, `type`, `agentId`, `definition`, `lastRunAt`, `nextRunAt`, `lastStatus`, `createdAt`, `updatedAt`。

时间戳均为 Unix 秒。

## 更新任务

```bash
curl -s -X PUT "$USER_META_BASE_URL/web/tasks/v2/<TASK_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "cron": "0 10 * * *",
    "description": "更新后的描述",
    "enabled": true,
    "definition": {
      "url": "https://api.example.com/new-report",
      "method": "GET"
    }
  }' | jq '.data | { id, name, cron, enabled }'
```

所有字段均可选，只传需要更新的。注意：
- `type` 字段不可修改
- `agentId` 仅 agent 类型可设置
- HTTP 类型不能设置 `agentId`
- 修改 `cron` / `timezone` / `enabled` 会自动同步调度状态

## 删除任务

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/tasks/v2/<TASK_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '{ success }'
```

## 启用/禁用任务

```bash
curl -s -X POST "$USER_META_BASE_URL/web/tasks/v2/<TASK_ID>/toggle" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.data | { id, enabled }'
```

## 手动触发任务

```bash
curl -s -X POST "$USER_META_BASE_URL/web/tasks/v2/<TASK_ID>/trigger" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.data | { status, duration, resultSummary, error }'
```

立即执行一次，不影响 cron 调度。返回执行状态和耗时。

## 查看执行日志

```bash
curl -s "$USER_META_BASE_URL/web/tasks/v2/<TASK_ID>/logs?page=1&pageSize=20" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.data | { total, logs: [.items[] | { id, status, triggeredBy, duration, resultSummary, createdAt }] }'
```

查询参数：
- `page`（number，默认 1，最小 1）
- `pageSize`（number，默认 20，最大 100）

日志字段：`id`, `taskId`, `status`（success/failed/timeout/skipped）, `triggeredBy`（cron/manual）, `duration`（ms，可能为 null）, `error`, `skipReason`, `resultSummary`, `createdAt`（Unix 秒）。

## 清空执行日志

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/tasks/v2/<TASK_ID>/logs" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '{ success }'
```
