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

## System API

除了面向普通外部调用方的 `/api/*` 接口外，Fenix 还提供一组单独的系统级管理接口：`/api/system/*`。

这组接口主要给系统集成使用，和普通 External API 有两个关键区别：

- 普通 External API 使用“用户级 API Key”，通常由控制台里的 API Key 页面创建
- System API 使用环境变量 `RCS_SYSTEM_API_KEYS` 中配置的“系统级 API Key”

例如：

```env
RCS_SYSTEM_API_KEYS=replace-with-one-or-more-system-api-tokens
```

如果配置了多个 key，可以用英文逗号分隔。

### System API 适合做什么

`/api/system/*` 主要用于系统级别的接口，比如：

- 用户全局管理
- 组织全局管理

### System API 的鉴权方式

System API 同样使用 Bearer Token，但这里的 token 不是普通用户级 `rcs_xxx`，而是 `RCS_SYSTEM_API_KEYS` 中配置的值：

```http
Authorization: Bearer your-system-api-key
```

### 注意事项

- `RCS_SYSTEM_API_KEYS` 是系统管理通道，不建议暴露给普通业务方
- system key 一旦泄漏，调用方可以直接创建用户、组织和 API Key，应按高敏感凭证管理

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

## 触发工作流运行

`POST /api/workflow-v2/workflows/:id/run` 触发指定工作流的**已发布版本**运行；`:id` 是控制台里的工作流主键（在控制台的工作流列表页「更多 → 调用接口」里可以直接看到调用地址与示例）。

```bash
curl -X POST 'https://rcs.example.com/api/workflow-v2/workflows/9f1c2f9e-0d3a-4c6b-8f21-2a7b0f5c1d33/run' \
  -H 'Authorization: Bearer rcs_xxx' \
  -H 'Content-Type: application/json' \
  -d '{"parameters":{"input":"hello"},"isAsync":false}'
```

`isAsync: false`（默认）等待本次运行结束后返回输出；`isAsync: true` 立即返回 `executeId`，结果需要到上游调试页查看。

示例响应（同步）：

```json
{
  "executeId": "6900000000000000001",
  "data": "{\"output\":\"hello\"}",
  "token": 7,
  "cost": "0.01000",
  "debugUrl": "http://127.0.0.1:18080/work_flow?execute_id=6900000000000000001"
}
```

### 调用前置：工作流必须已发布到「API 渠道」

除了「先发布工作流」，上游还要求该工作流的**当前发布版本已登记到 API 渠道**（上游表 `connector_workflow_version` 里
有 `connector_id = 1024` 这一行）——上游的 OpenAPI 运行路径会在执行前校验它。平台把这件事自愈掉：

- 工作流**发布成功后**平台会立即同步登记（无需等到第一次调用）；若首次运行仍拿到上游的「版本未登记」回执，平台会在
  该请求内**自动补登记**（把租户应用发布到 API 渠道，版本号取自上游当前版本自增）并重试一次；成功后同一工作流的
  后续运行不再需要补登记；
- 补登记本身失败（上游不可达、冷却窗口内、租户应用不是可发布的应用实体）时，接口返回 `409`
  `WORKFLOW_NOT_REGISTERED_TO_API_CHANNEL`，**稍后重试**即可，不需要调用方改参数；
- 自动补登记会以上游当前草稿生成一个新版本（这是上游「发布到渠道」的语义），因此它会改变工作流的当前发布版本。

注意：

- 只能触发**已发布**的工作流，未发布返回 `409 WORKFLOW_NOT_PUBLISHED`
- 工作流不存在或不属于调用方所在组织返回 `404 WORKFLOW_NOT_FOUND`（两者同形，不区分）
- 参数不是合法 JSON 对象返回 `422 INVALID_PARAMETERS`
- 当前发布版本尚未登记到 API 渠道返回 `409 WORKFLOW_NOT_REGISTERED_TO_API_CHANNEL`（平台会自动补登记并重试一次，
  仍失败时按此码返回，可稍后重试）
- 调用方身份（API Key）所在组织必须与工作流所属组织一致
- 上游没有幂等键：**重试等于再运行一次**，请按业务语义自行去重
- 限流按调用方身份计数（默认每分钟 60 次），超限返回 `429` 与 `Retry-After`

## 更多接口

更多接口的使用方式，请直接参考：

- 交互式文档：`http://server/docs/openapi/external`
- Agent 管理与会话说明：`/developer/guide/external-agent-session-guide`
- 代码示例：`/docs/developer/api-demo`
