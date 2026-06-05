---
name: agent-platform-api
description: RCS Platform API 完整参考。Agent 通过 curl + jq 调用 REST API 操作平台资源：环境、会话、工作流、配置、任务、知识库、组织等。
allowed-tools: Bash
---

# RCS Platform API

## 认证

两个环境变量由系统自动注入，所有请求必须携带：

```bash
AUTH="-H 'Authorization: Bearer $USER_META_API_KEY' -H 'Content-Type: application/json'"
```

- `$USER_META_BASE_URL` — API 服务器地址
- `$USER_META_API_KEY` — Bearer token

## 响应格式

成功：`{ "success": true, "data": ... }`
失败：`{ "success": false, "error": { "type": "ERROR_CODE", "message": "..." } }`

## API 模块索引

| 模块 | 文档 | 说明 |
|------|------|------|
| 环境 | `references/environment.md` | 环境创建/列表/进入/实例管理 |
| 会话 | `references/session.md` | 会话列表/历史/控制/中断 |
| 工作流 | `references/workflow.md` | 工作流定义/执行引擎/触发器/看板/作业 |
| 配置 | `references/config.md` | Provider/Model/Agent/Skill/MCP 配置 |
| 任务 | `references/task.md` | 定时任务 CRUD/触发/日志 |
| 知识库 | `references/knowledge.md` | 知识库 CRUD/文件上传/URL 导入 |
| 组织 | `references/org.md` | 组织管理/成员/API Key |

**使用某个模块的 API 前，先 `cat references/<module>.md` 读取完整文档和 curl 示例。**

## 常用 jq 技巧

```bash
| jq '.data'                  # 提取 data 字段
| jq '.data[] | { id, name }' # 列表提取 id 和 name
| jq -r '.data.draftYaml'     # 原文输出工作流草稿
| jq '{ success }'            # 只看成功状态
```
