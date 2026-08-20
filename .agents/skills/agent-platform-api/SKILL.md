---
name: agent-platform-api
description: RCS Platform API 完整参考。Agent 通过 curl + jq 调用 REST API 操作平台资源：环境、工作流、配置、任务、知识库、组织等。
allowed-tools: Bash
---

# RCS Platform API

## 认证

以下环境变量由系统自动注入：

- `$USER_META_BASE_URL` — API 服务器地址（**仅限 agent 内部调用 RCS API 使用**）

> **`$USER_META_BASE_URL` 是服务器内部地址，与用户通过浏览器访问的外部地址不同。** 该变量只用于 `curl` 调用 RCS 后端 API（如 `curl $USER_META_BASE_URL/web/...`），**禁止直接拼接后展示给用户**。建站等需要告知用户访问地址的场景，统一通过 `<agent-sites>` 卡片标签或引导用户操作 UI tab 来提供入口，不要手工拼接和暴露 URL。
- `$USER_META_API_KEY` — Bearer token，所有请求必须携带
- `$USER_META_USER_ID` — 当前请求用户 ID，用于标注资源归属或调用 user-scoped API
- `$USER_META_ORG_ID` — 当前组织 ID，多租户隔离/调用 organization-scoped API 时使用

> **沙盒网络例外**：先使用注入的 `$USER_META_BASE_URL`。只有当其主机为 `localhost` / `127.0.0.1` 且在当前沙盒中连接失败时，才在当前 shell 将主机替换为 `host.docker.internal` 后重试；保留原协议、端口和路径。该替换后的内部地址同样不得向用户展示。

所有请求必须携带 `Authorization` 头：

```bash
AUTH="-H 'Authorization: Bearer $USER_META_API_KEY' -H 'Content-Type: application/json'"
```

> **关于组织隔离**：绝大多数 `/web/*` 路由后端会从 API Key 元数据自动取 `$USER_META_ORG_ID` 作为隔离范围，**无需在 URL query 或 body 中显式传 `organizationId`**。`$USER_META_ORG_ID` / `$USER_META_USER_ID` 仅在少数需要明确指定目标组织/用户的接口（如 `/web/organizations` 的 action 类操作）中作为 body 字段传入。

## 响应格式

成功响应通常为：`{ "success": true, "data": ... }`。

失败响应**尚未全局统一**：路由主动返回的业务错误通常是 `{ "success": false, "error": { "code": "ERROR_CODE", "message": "..." } }`；全局错误处理、限流等也可能是 `{ "error": { "type": "ERROR_CODE", "message": "..." } }`，没有 `success` 字段。调用方必须先判断 HTTP 状态码，再兼容读取 `error.code` 和 `error.type`；不要把其中任一形状当作所有 `/web/*` 接口的保证。

## API 模块索引

| 模块 | 文档 | 说明 |
|------|------|------|
| 环境 | `references/environment.md` | 环境创建/列表/进入/实例管理 |
| 工作流 | `references/workflow.md` | 工作流定义/执行引擎/触发器 |
| 配置 | `references/config.md` | Provider/Model/Agent/Skill/MCP 配置 |
| 任务 | `references/task.md` | 定时任务 CRUD/触发/日志 |
| 知识库 | `references/knowledge.md` | 知识库 CRUD/文件上传 |
| 组织 | `references/org.md` | 当前不可用；禁止调用组织、成员和 API Key 接口 |
| Agent Sites | `references/agent-sites.md` | 建站部署/App 管理/PocketBase 后端配置/前端上传 |

**使用某个模块的 API 前，先 `cat references/<module>.md` 读取完整文档和 curl 示例。**

## 常用 jq 技巧

```bash
| jq '.data'                  # 提取 data 字段
| jq '.data[] | { id, name }' # 列表提取 id 和 name
| jq -r '.data.draftYaml'     # 原文输出工作流草稿
| jq '{ success }'            # 只看成功状态
```
