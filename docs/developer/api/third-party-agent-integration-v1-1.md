# 第三方系统 Agent 接入指南 v1.1

本文是 [Agent 接入指南 v1](third-party-agent-integration-v1.md) 的扩展，请配合 v1 阅读。认证、基础响应格式、OpenAI/ACP 对话协议、文件上传下载和资源配置沿用 v1，本文仅说明新增能力与行为变化。

文档版本为 v1.1，接口路径仍统一使用 `/api/v1`，不使用 `/api/v1.1`。在线参考为当前平台地址下的 `/docs/openapi/external`，OpenAPI JSON 位于 `/docs/openapi/external/json`。示例使用 v1 中的 `BASE_URL`、`API_KEY`、`AGENT_ID` 环境变量，以及 Bash、curl、jq。

**已有接入方需注意：实例停止接口改为返回 `202 Accepted`，普通实例和临时实例都受此变更影响。停止完成需要查询实例状态，详见第 6 节；此处覆盖 v1 的同步停止约定。**

## 1. 为什么需要临时环境，应该如何选择

常规访问适合持续使用同一个用户工作区：不指定实例时，平台复用当前组织、当前用户、当前 Agent 的普通默认 API 实例。可以建立多个独立对话，但这些对话仍共享工作区文件。

例如，接入方后端使用同一个平台用户的 API Key，为访客 A、B 分别上传合同。如果两人使用同一普通工作区，即使对话 ID 不同，文件也会进入同一个目录，可能出现同名冲突、业务数据混用等问题。**更换对话 ID 只能区分对话上下文，不能分开文件工作区。**

临时环境用来为一次业务任务或一段访客交互分配独立工作区和实例，并设置明确的使用期限。接入方无需为每位访客创建平台账号，可复用同一用户凭据，但必须维护自己的“业务交互 → 环境 → 实例”映射。到期停止执行，有助于收回无人继续使用的运行资源；到期不会自动删除文件。

### 1.1 访问方式对比

| 对比项 | 常规访问 | 临时环境访问 |
| --- | --- | --- |
| 主要用途 | 持续使用同一个工作区，保留并复用文件 | 不同访客、任务或订单各用独立工作区 |
| 入口 | 直接聊天，或 connect 普通默认实例 | 先创建临时环境，再指定返回的实例聊天或 connect |
| 默认资源选择 | 按组织、用户、Agent 复用普通默认实例 | 创建新环境与新实例；后续必须选择该实例 |
| 多轮对话 | 使用 HTTP 续聊句柄或 ACP 会话 | 同样使用 HTTP 续聊句柄或 ACP 会话，另维护环境期限 |
| 文件关系 | 同一环境中的不同对话共享文件 | 不同环境的工作区分开；同一临时环境内仍共享文件 |
| 生命周期 | 无临时环境 TTL；仍可能被原有空闲策略停止 | 有 `expiresAt`，继续使用需显式 renew；空闲策略也可能提前停止实例 |
| 平台长期记忆 | 按 Agent 配置生效 | 关闭平台长期记忆 |
| 停止后的文件 | 保留，停止不等于删除 | 同样保留，到期也不等于删除 |
| 并发额度 | 受用户的平台并发额度约束 | 使用同一用户的并发额度，环境数量不会增加额度 |
| 接入方维护成本 | 保存实例与各对话标识 | 另保存业务映射、环境 ID、实例 ID 和到期时间，安排续期 |

### 1.2 典型场景选型

| 业务场景 | 推荐方式 | 原因与做法 |
| --- | --- | --- |
| 内部助手持续处理同一项目，后续要复用已有文件 | 常规访问 | 工作区和文件需要长期复用，无需为每段对话新建环境 |
| 纯文本问答，不上传文件，也不要求每次交互独立工作区 | 常规访问 | 用不同对话区分上下文即可；并发聊天本身不要求临时环境 |
| 网站多个访客各自上传文档并进行多轮分析 | 临时环境 | 按一段访客业务交互创建环境，避免不同访客的文件进入同一工作区 |
| 每个订单、报告生成任务都有自己的输入和产物 | 临时环境 | 按任务创建独立工作区，便于产物归属与到期停止 |
| 同一个 Agent 同时分析多份互不相关的材料，可能出现同名文件 | 临时环境 | 每份独立任务使用不同环境，减少文件冲突与交叉读取 |
| 短期演示、试用，希望使用结束后有到期停止机制 | 临时环境 | 设置合理 TTL，使用中续期，结束后主动停止或等待到期 |
| 要求不可信代码之间的进程级隔离，或彻底隔离工具外部数据 | 需另行确认执行与工具隔离方案 | 临时工作区不提供独立安全沙盒，不能仅凭临时环境满足这些要求 |

按“文件与任务需要独立的业务单元”创建环境，而不是每条消息或每次 HTTP 请求都创建。一个任务的多轮对话复用同一临时环境；需要长期持续使用且共享文件时，通常选择常规访问。

临时环境只分开工作区，并关闭平台长期记忆。Agent 引擎的全局状态、工具服务与外部数据仍受对应引擎和工具的权限配置约束。它也不会提供额外用户身份或额外并发额度。

## 2. 本版本新增与调整

| 类型 | 接口或行为 | 说明 |
| --- | --- | --- |
| 新增 | `POST /api/v1/agents/{agentId}/environments` | 创建独立临时环境和实例，返回期限，不启动 Agent |
| 新增 | `POST /api/v1/environments/{environmentId}/renew` | 续期并确保原实例运行 |
| 新增 | `GET/PUT/DELETE /api/v1/agents/{agentId}/environment-policy` | 查询或管理 Agent 的临时环境 TTL 策略 |
| 扩展 | `GET /api/v1/agents/{agentId}/instances` | 增加 `environmentType=regular|temporary|all` 筛选 |
| 调整 | `POST /api/v1/instances/{instanceId}/stop` | 普通与临时实例都改为 `202` 受理后后台停止 |
| 复用 | v1 的 connect、聊天、ACP relay、文件与实例详情接口 | 选择临时环境返回的实例或工作区，无需使用新的聊天和文件协议 |

v1 的通用认证与权限规则继续生效。创建、续期与执行均校验当前用户的资源归属和 Agent 权限；临时环境不允许调用方绕过组织或用户边界。

## 3. 临时环境最小接入流程

1. 创建环境，保存 `environmentId`、`instanceId`、`expiresAt`，并绑定接入方自己的业务交互 ID。
2. 只做文本聊天可直接指定实例调用 v1 对话接口；需要先操作文件或使用 ACP 时，先 connect 该实例。
3. 使用返回的环境操作文件，使用返回的实例进行多轮对话。
4. 使用中按期限安排显式续期；业务结束时下载所需产物并停止实例，或等待到期停止。

### 3.1 创建临时环境

`POST /api/v1/agents/{agentId}/environments`

请求体必须为 `{"temporary":true}`。TTL 取 Agent 当前策略，不能在创建请求中指定。

```bash
CREATED=$(curl --fail-with-body -sS \
  -X POST "$BASE_URL/api/v1/agents/$AGENT_ID/environments" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' -d '{"temporary":true}')
ENVIRONMENT_ID=$(jq -er '.data.environmentId' <<< "$CREATED")
INSTANCE_ID=$(jq -er '.data.instanceId' <<< "$CREATED")
EXPIRES_AT=$(jq -er '.data.expiresAt' <<< "$CREATED")
export ENVIRONMENT_ID INSTANCE_ID EXPIRES_AT
```

成功返回 `201`：

```json
{
  "success": true,
  "data": {
    "environmentId": "temp-00000000-0000-4000-8000-000000000002",
    "instanceId": "inst_example",
    "expiresAt": "2026-11-16T10:00:00.000Z"
  }
}
```

创建只登记资源，不保证 Agent 已运行、执行节点在线或文件服务就绪。每次成功创建都会产生新环境，没有按业务 ID 去重的幂等承诺。响应丢失时应先检查临时实例列表，再由业务决定是否新建；平台列表不能替代接入方自己的访客或任务映射。

### 3.2 连接指定实例

connect 请求和响应结构沿用 v1 第 3 节，但请求体必须指定创建返回的 `instanceId`：

```bash
CONNECT=$(curl --fail-with-body -sS \
  -X POST "$BASE_URL/api/v1/agents/$AGENT_ID/instances/connect" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg id "$INSTANCE_ID" '{instanceId:$id}')")
RELAY_PATH=$(jq -er '.data.relay.wsUrl' <<< "$CONNECT")
export RELAY_PATH
```

成功返回 `200`，`data.status` 为 `running`；`data.environmentId`、`data.instanceId` 应对应本次任务保存的资源。connect 会等待实例准备，可能涉及启动 Agent。

请求体为 `{}` 会准备普通默认实例，**不会自动选择之前创建的临时环境**。读取实例列表或详情也不会启动实例。

### 3.3 沿用 v1 的对话与文件接口

| 能力 | 复用 v1 的内容 | 临时环境需要补充的选择 |
| --- | --- | --- |
| OpenAI 兼容对话 | v1 第 4 节，包括两轮 SDK 示例、SSE 和续聊规则 | 设置创建返回的 `INSTANCE_ID`，每轮明确携带 `X-Instance-Id`；`model` 仍为 Agent ID |
| HTTP 续聊 | 使用响应 `X-Session-Id`，后续只提交一条新 `user` | 对话句柄与实例匹配；`X-Session-Expires-At` 是对话期限，不是环境期限 |
| ACP | v1 第 5 节的连接认证和 JSON-RPC 顺序 | 使用该临时实例 connect 返回的完整 `relay.wsUrl`，保留实例 query |
| 上传、文件树、下载 | v1 第 6 节的路径、格式、大小限制与错误处理 | 使用创建返回的 `ENVIRONMENT_ID`；先 connect 或成功启动聊天，保证文件服务已准备 |

OpenAI 请求 header 示例：

```javascript
const headers = { 'X-Instance-Id': process.env.INSTANCE_ID };
// 续聊时再加入对应的 X-Session-Id；请求体仍采用 v1 的对话格式。
```

两个任务需要并发且文件分开时，各自创建临时环境，各自维护实例与对话句柄。同一临时环境可以有多个对话，但仍共享文件；同一 HTTP 句柄或 ACP 会话应串行发送消息。

## 4. 续期与生命周期

### 4.1 显式续期并恢复原实例

`POST /api/v1/environments/{environmentId}/renew`，JSON body 为 `{}`。

```bash
curl --fail-with-body -sS \
  -X POST "$BASE_URL/api/v1/environments/$ENVIRONMENT_ID/renew" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' -d '{}'
```

成功返回 `200`：

```json
{
  "success": true,
  "data": {
    "environmentId": "temp-00000000-0000-4000-8000-000000000002",
    "instanceId": "inst_example",
    "expiresAt": "2026-11-16T11:00:00.000Z",
    "status": "running"
  }
}
```

1. 未到期或已到期的本人临时环境均可续期。新期限为“续期处理时的当前时间 + 当前有效 TTL”，不是在旧期限上累加；采用响应中的新期限。
2. 续期会确保原实例运行，可能等待启动或此前停止结束。环境与实例 ID 不变，原工作区文件保留。
3. **先保存期限，再尝试启动。** 并发不足、节点不可用等错误响应不代表期限未更新。可以重试同一环境续期，成功后保存新返回的 `expiresAt`。
4. 续期不延长 HTTP 句柄的 30 分钟空闲有效期。实例曾停止或旧句柄已失效时，按 v1 的恢复方式新建对话，必要时携带完整文本历史，并继续指定原实例。

### 4.2 TTL 与到期行为

| 情况 | 行为 |
| --- | --- |
| 未设置 Agent 覆盖 | 默认 TTL 为 3600 秒，并受平台上限约束；策略接口可查询实际有效值 |
| 聊天、文件访问、心跳 | 不自动续期 |
| 到期仍在执行 | 限制新执行，取消在途执行并尝试停止实例；长对话不会豁免到期 |
| 到期后聊天、connect 或 restart | 环境校验返回 `410 / ENVIRONMENT_EXPIRED`；旧 HTTP 句柄也可能先返回会话不可用 |
| 到期或主动停止 | 保留环境、实例与文件，不等于删除 |
| 期限内空闲被提前停止 | 不修改期限；可再次 connect 或聊天启动原实例 |
| 平台服务重启 | 保留期限，不自动续期；HTTP 句柄和 ACP 会话不保证恢复 |

平台对失败的到期停止继续补偿处理，不承诺进程在 `expiresAt` 瞬间退出。文件接口不单独检查环境期限；停止后的远端文件可能无法访问，对已到期环境可先 renew 恢复实例，再读取原文件。

接入方应在仍需使用时提前续期，为网络、并发等待和启动耗时预留余量。业务结束后停止实例，不要继续发送聊天或 connect，以免期限内再次启动；到期不提供文件删除承诺。

### 4.3 Agent TTL 策略

普通调用方可直接使用既定策略。读取需 Agent 读取权限，修改或删除覆盖需 Agent 更新权限。

| 接口 | 请求与行为 |
| --- | --- |
| `GET /api/v1/agents/{agentId}/environment-policy` | 查询有效 TTL 与平台上限 |
| `PUT /api/v1/agents/{agentId}/environment-policy` | JSON `{"ttlSeconds":3600}`，替换 Agent 覆盖值 |
| `DELETE /api/v1/agents/{agentId}/environment-policy` | 删除覆盖，返回 `200` 与 `data:null` |

GET 未设置覆盖时的 `200` 响应示例：

```json
{"success":true,"data":{"source":"default","ttlSeconds":null,"effectiveTtlSeconds":3600,"maxTtlSeconds":86400}}
```

| 字段 | 含义 |
| --- | --- |
| `source` | `default` 为默认策略，`agent` 为 Agent 覆盖 |
| `ttlSeconds` | 覆盖秒数，未设置为 null |
| `effectiveTtlSeconds` | 当前实际生效秒数 |
| `maxTtlSeconds` | 当前平台上限；上例数值不是所有部署的固定保证 |

PUT 只接受不超过上限的正整数，成功返回相同结构，`source` 为 `agent`。修改或删除策略不改变已有环境的 `expiresAt`，只影响后续创建与续期；需要延长已有环境时仍需逐个 renew。

## 5. 实例列表增加环境类型筛选

`GET /api/v1/agents/{agentId}/instances` 增加 `environmentType`，v1 的分页和响应格式不变。

| 参数值 | 返回范围 |
| --- | --- |
| `regular` | 仅普通实例，默认值 |
| `temporary` | 仅临时实例 |
| `all` | 两类实例 |

```bash
curl --fail-with-body -sS \
  "$BASE_URL/api/v1/agents/$AGENT_ID/instances?environmentType=temporary&page=1&pageSize=20" \
  -H "Authorization: Bearer $API_KEY"
```

筛选同时作用于 `items` 和 `total`，仍只返回当前用户可访问的该 Agent 的 API、用户实例，不包含工作流实例。默认列表不会返回临时实例；需要找回其 ID 时应显式筛选。列表和实例详情不提供 `expiresAt`，接入方应保存创建及续期响应中的期限。

## 6. 停止接口改为异步受理（两类实例均适用）

本节覆盖 v1 第 7 节的停止约定。重启及实例详情结构仍沿用 v1；临时环境已到期时，应先 renew 再恢复执行。

`POST /api/v1/instances/{instanceId}/stop`

```bash
curl --fail-with-body -sS -i -X POST \
  "$BASE_URL/api/v1/instances/$INSTANCE_ID/stop" \
  -H "Authorization: Bearer $API_KEY"
```

成功返回 **`202 Accepted`** 和 `{"success":true,"data":null}`。此时只表示受理，后台继续停止；通过 `GET /api/v1/instances/{instanceId}` 等待 `status` 为 `stopped`。

以下示例最多查询 60 次，查询间隔 1 秒，单次 HTTP 超时 10 秒；实际等待预算应按业务设置：

```bash
STATUS=''
for attempt in {1..60}; do
  DETAIL=$(curl --fail-with-body -sS --max-time 10 \
    "$BASE_URL/api/v1/instances/$INSTANCE_ID" \
    -H "Authorization: Bearer $API_KEY")
  STATUS=$(jq -er '.data.status' <<< "$DETAIL")
  printf 'instance status: %s\n' "$STATUS"
  if [[ "$STATUS" == 'stopped' || "$STATUS" == 'unknown' ]]; then break; fi
  sleep 1
done
[[ "$STATUS" == 'stopped' ]] || { printf '停止未确认，请联系平台排查\n' >&2; exit 1; }
```

`unknown` 表示停止未确认，应联系平台排查。状态是当前观察值；平台服务重启后的 `stopped` 也不能独立证明旧进程已退出。主动 stop 不提供跨平台服务重启的任务执行承诺，环境到期停止另有补偿机制。

重复请求可复用在途停止；删除中的实例可能返回 `409 / INSTANCE_DELETING`，停止无法受理时可能返回 `503 / INSTANCE_STOP_UNAVAILABLE`。停止影响该实例的全部会话，使旧续聊句柄失效，但不删除文件、不修改环境期限。

## 7. 在 v1 基础上补充的错误处理

通用错误结构、请求超时及重试原则沿用 v1 第 8 节。以下为使用临时环境或新停止约定时需要额外处理的情况：

| 状态 / 错误码 | 处理方式 |
| --- | --- |
| `410 / ENVIRONMENT_EXPIRED` | renew 原环境，成功后用原实例继续；旧对话可能需要重建 |
| `409 / SESSION_UNAVAILABLE` | 按 v1 恢复对话，另检查环境期限；不要省略实例 ID 而误用普通环境 |
| renew 返回 `429 / 503` 等错误 | 期限可能已保存；恢复并发或节点条件后重试同一环境，采用成功响应的新期限 |
| stop 返回 `202` | 只表示受理，查询实例直至确认停止 |
| `409 / INSTANCE_DELETING` | 实例正在删除，停止请求未受理，不要继续对其启动新执行 |
| `503 / INSTANCE_STOP_UNAVAILABLE` | 停止未受理，保留诊断信息并联系平台或有限重试 |

创建环境没有按业务 ID 去重的承诺，续期也不是“错误即回滚”。应保存业务资源映射与成功响应，避免网络异常时重复创建环境或误判状态。日志仍按 v1 记录请求标识、状态和资源 ID，不记录 API Key。
