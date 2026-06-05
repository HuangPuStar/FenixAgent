---
name: api-task
description: 定时任务 API。当需要"列出任务"、"创建定时任务"、"更新任务"、"删除任务"、"手动触发"、"查看日志"、"开关任务"时使用。使用 curl + jq 调用 REST API。
allowed-tools: Bash
---

# Task API

管理定时任务（Scheduled Task），支持 cron 表达式调度。

## 列出所有任务

```bash
curl -s "$USER_META_BASE_URL/web/tasks" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.[] | { id, name, enabled, cron, url, method }'
```

## 创建任务

```bash
curl -s -X POST "$USER_META_BASE_URL/web/tasks" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "每日报告",
    "cron": "0 9 * * *",
    "url": "https://api.example.com/report",
    "method": "POST",
    "headers": {"Content-Type": "application/json"},
    "body": "{\"action\":\"daily\"}"
  }' | jq '.data | { id, name, enabled }'
```

字段说明：
- `name`（必填）：任务名称
- `cron`（可选）：cron 表达式，如 `*/5 * * * *`、`0 9 * * *`
- `url`（可选）：请求地址
- `method`（可选）：HTTP 方法，默认 `GET`
- `headers`（可选）：请求头对象
- `body`（可选）：请求体字符串

## 查询任务详情

```bash
curl -s "$USER_META_BASE_URL/web/tasks/<TASK_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```

## 更新任务

```bash
curl -s -X PUT "$USER_META_BASE_URL/web/tasks/<TASK_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "cron": "0 10 * * *",
    "url": "https://api.example.com/new-report"
  }' | jq '.data | { id, name, cron }'
```

所有字段均可选，只传需要更新的。

## 删除任务

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/tasks/<TASK_ID>" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '.data'
```

## 启用/禁用任务

```bash
curl -s -X POST "$USER_META_BASE_URL/web/tasks/<TASK_ID>/toggle" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.data | { id, name, enabled }'
```

## 手动触发任务

```bash
curl -s -X POST "$USER_META_BASE_URL/web/tasks/<TASK_ID>/trigger" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '.data | { id, name, lastRunAt }'
```

立即执行一次，不影响 cron 调度。

## 查看执行日志

```bash
curl -s "$USER_META_BASE_URL/web/tasks/<TASK_ID>/logs?page=1&pageSize=10" \
  -H "Authorization: Bearer $USER_META_API_KEY" | \
  jq '{ total: .total, logs: [.logs[] | { id, status, startedAt, completedAt }] }'
```

支持分页参数 `page`（默认 1）和 `pageSize`（默认 20）。

## 清空执行日志

```bash
curl -s -X DELETE "$USER_META_BASE_URL/web/tasks/<TASK_ID>/logs" \
  -H "Authorization: Bearer $USER_META_API_KEY" | jq '{ success }'
```
