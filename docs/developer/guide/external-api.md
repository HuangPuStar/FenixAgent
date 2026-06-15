# External API 使用指南

Fenix 对外提供了一套独立的 External API，供其他系统通过 API Key 调用。外部系统应使用 `/api/*` 路径，不要直接依赖控制台内部使用的 `/web/*` 接口。

## 文档入口

- 交互式文档：`http://server/docs/openapi/external`
- OpenAPI JSON：`http://server/docs/openapi/external/json`

具体字段、请求体和响应体定义，请直接以交互式文档为准，不要以本文档中的示例推断全部接口形态。

## API Key

登录控制台后，进入 API Key 页面创建密钥。系统会返回一次性明文 token，形如：

```text
rcs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

注意：

- 明文 key 只会在创建时展示一次
- 后端只保存哈希值，无法再次查看原文
- 外部系统拿到 key 后应自行安全保存

## 鉴权方式

External API 使用 Bearer Token 鉴权，请把 API Key 放到 `Authorization` 请求头中：

```http
Authorization: Bearer rcs_xxx
```

## 请求示例

下面用“查询 Agent 列表”作为一个最小示例：

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
      "description": "示例 Agent"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

## 更多接口

更多接口的使用方式，请直接参考：

- 交互式文档：`http://server/docs/openapi/external`
- Agent 管理与会话说明：`/developer/guide/external-agent-session-guide`
- 代码示例：`/docs/developer/api-demo`
