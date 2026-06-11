# External API 使用指南

RCS 对外提供了一套独立的 External API，供其他系统通过 API Key 调用。外部系统应使用 `/api/*` 路径，不要直接依赖控制台内部使用的 `/web/*` 接口。

## 文档入口

External API 的 OpenAPI 文档入口：

- 交互式文档：`/docs/openapi/external`
- OpenAPI JSON：`/docs/openapi/external/json`

## 如何生成 API Key

登陆控制台，进入 API Key 页面，创建密钥，系统会返回一次性明文 token，形如：

```text
rcs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

注意：

- 明文 key 只会在创建时展示一次
- 后端只保存哈希值，无法再次查看原文
- 外部系统拿到 key 后应自行安全保存

## 如何请求 External API

External API 使用 Bearer Token 鉴权，请把 API Key 放到 `Authorization` 请求头中：

```http
Authorization: Bearer rcs_xxx
```

示例：

```bash
curl -X GET 'https://rcs.example.com/api/agents?page=1&pageSize=20' \
  -H 'Authorization: Bearer rcs_xxx'
```

## 当前可用接口

当前 External API 已提供 AgentConfig 的 CRUD 能力：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/agents` | 查询 Agent 列表 |
| `GET` | `/api/agents/:id` | 查询单个 Agent |
| `POST` | `/api/agents` | 创建 Agent |
| `PUT` | `/api/agents/:id` | 更新 Agent |
| `DELETE` | `/api/agents/:id` | 删除 Agent |

这些接口在 External OpenAPI 文档中归类在 `External AgentConfig` tag 下。

## 请求示例

### 1. 查询 Agent 列表

```bash
curl -X GET 'https://rcs.example.com/api/agents?page=1&pageSize=20' \
  -H 'Authorization: Bearer rcs_xxx'
```

示例响应：

```json
{
  "items": [
    {
      "id": "95136b37-1af8-48cf-a29d-59e092e4f5a1",
      "name": "Demo Agent",
      "description": "示例 Agent",
      "modelId": "a151efd6-3f93-4d4d-934d-0427ad3fe2c2",
      "systemPrompt": "You are a helpful assistant."
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

### 2. 查询单个 Agent

```bash
curl -X GET 'https://rcs.example.com/api/agents/95136b37-1af8-48cf-a29d-59e092e4f5a1' \
  -H 'Authorization: Bearer rcs_xxx'
```

### 3. 创建 Agent

```bash
curl -X POST 'https://rcs.example.com/api/agents' \
  -H 'Authorization: Bearer rcs_xxx' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "External Demo Agent",
    "description": "通过 External API 创建",
    "modelId": "a151efd6-3f93-4d4d-934d-0427ad3fe2c2",
    "systemPrompt": "You are a helpful external agent.",
    "skillIds": [],
    "mcpIds": [],
    "knowledgeIds": []
  }'
```

### 4. 更新 Agent

```bash
curl -X PUT 'https://rcs.example.com/api/agents/95136b37-1af8-48cf-a29d-59e092e4f5a1' \
  -H 'Authorization: Bearer rcs_xxx' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "External Demo Agent Updated",
    "description": "更新后的描述",
    "modelId": "a151efd6-3f93-4d4d-934d-0427ad3fe2c2",
    "systemPrompt": "You are an updated external agent.",
    "skillIds": [],
    "mcpIds": [],
    "knowledgeIds": []
  }'
```

### 5. 删除 Agent

```bash
curl -X DELETE 'https://rcs.example.com/api/agents/95136b37-1af8-48cf-a29d-59e092e4f5a1' \
  -H 'Authorization: Bearer rcs_xxx'
```

## 常见说明

### `/web/*` 和 `/api/*` 的区别

- `/web/*`：给控制台前端使用的内部 API
- `/api/*`：给外部系统使用的 External API

外部调用方应只接入 `/api/*`。

## 推荐接入方式

对接外部系统时，建议按下面的顺序使用：

1. 先在控制台生成 API Key
2. 打开 `/docs/openapi/external` 查看最新接口定义
3. 用 `Authorization: Bearer rcs_xxx` 方式请求 `/api/*`
4. 不要直接依赖 `/web/*` 内部接口
