# 第三方系统 Agent 接入指南 v1

文档版本：v1。本文覆盖使用已有 Agent 进行对话、上传下载文件和管理实例，另附配置类接口目录。示例中的域名、密钥和资源 ID 均为占位值。

文档版本用于区分接入契约，接口路径统一使用 `/api/v1`。

## 1. 接入信息与认证

接入前由平台管理员提供以下信息：

| 信息 | 说明 |
| --- | --- |
| `BASE_URL` | 平台服务根地址，不包含 `/api/v1`，例如 `https://agent-api.example.com` |
| `API_KEY` | 具有目标 Agent 使用权限的用户 API Key |
| `AGENT_ID` | Agent 配置的 UUID；对话请求中的 `model` 填此值，不填底层模型名称 |

在线接口参考：在 `BASE_URL` 后追加 `/docs/openapi/external` 查看接口页面，或追加 `/docs/openapi/external/json` 获取 OpenAPI JSON。请使用与本文版本匹配的部署环境。

HTTP 请求统一携带：

```http
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

文件上传使用 multipart，不手动设置 `Content-Type`。下载成功返回文件流。

API Key 代表一个平台用户及其组织上下文，权限随平台当前授权生效；不能通过传入用户或组织 ID 切换身份。接入方应在自己的服务端保存密钥，由后端调用平台，避免将密钥下发到访客浏览器。

以下 Shell 示例使用 Bash、curl 和 jq：

```bash
set -euo pipefail
export BASE_URL='https://agent-api.example.com'
export API_KEY='<平台管理员提供的用户 API Key>'
export AGENT_ID='<平台管理员提供的 Agent UUID>'
```

## 2. 先区分四种标识

| 标识 | 含义 | 使用位置 |
| --- | --- | --- |
| `AGENT_ID` | Agent 的配置与能力 | 路径中的 Agent ID、对话 `model` |
| `environmentId` | 工作区；其中的文件可被同工作区内的对话使用 | 文件接口 |
| `instanceId` | Agent 的持久实例身份 | 连接、停止、重启、`X-Instance-Id` |
| 对话标识 | 一段对话的上下文 | HTTP 使用 `X-Session-Id`；ACP 使用 `sessionId` |

所有 ID 均应作为不透明字符串保存，不自行拼接或互相替代。HTTP 续聊句柄与 ACP `sessionId` 不能互换。

不指定实例时，平台按当前用户、组织和 Agent 准备或复用默认 API 实例。不同对话可以共享这个实例，也共享其工作区文件。新建对话只创建新的对话上下文，不创建独立工作区。

本版本没有面向接入方的“按访客创建临时工作区”接口。同一 API Key 下的不同访客若使用默认实例，不能仅靠不同会话 ID 获得文件隔离。接入方需自行维护访客与对话标识的映射，并在平台侧已具备独立资源配置时使用对应资源。

## 3. 最小调用流程

1. 已有 Agent、仅做文本聊天：可以直接调用对话接口，由平台准备默认实例。
2. 需要上传文件或使用 ACP：先调用 connect，保存 `environmentId`、`instanceId` 和 `relay.wsUrl`。
3. 上传文件后，在对话里使用工作区相对路径描述文件。
4. 同一对话按顺序续聊，不同对话可以并发。
5. 不再使用整个实例时调用 stop；该实例上的所有会话都会受影响。

### 3.1 准备实例

`POST /api/v1/agents/{agentId}/instances/connect`

请求体 `{}` 表示准备默认 API 实例；`{"instanceId":"inst_..."}` 表示准备当前用户拥有、且属于该 Agent 的已有 API 或用户实例。不能选择其他用户的实例或工作流实例。

```bash
CONNECT=$(curl --fail-with-body -sS \
  -X POST "$BASE_URL/api/v1/agents/$AGENT_ID/instances/connect" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' -d '{}')
ENVIRONMENT_ID=$(jq -er '.data.environmentId' <<< "$CONNECT")
INSTANCE_ID=$(jq -er '.data.instanceId' <<< "$CONNECT")
RELAY_PATH=$(jq -er '.data.relay.wsUrl' <<< "$CONNECT")
export ENVIRONMENT_ID INSTANCE_ID RELAY_PATH
```

成功返回 `200`：

```json
{
  "success": true,
  "data": {
    "agentConfigId": "00000000-0000-4000-8000-000000000001",
    "environmentId": "ENVIRONMENT_ID",
    "instanceId": "inst_example",
    "status": "running",
    "runtimeGeneration": 1,
    "relay": { "wsUrl": "/acp/relay/ENVIRONMENT_ID?instanceId=inst_example" }
  }
}
```

connect 会等待实例准备完成，可能涉及启动 Agent。读取实例列表或详情不会自动启动实例。已有实例停止后，可再次用同一 `instanceId` connect；不要假定旧对话也能恢复。

## 4. OpenAI 兼容对话

`POST /api/v1/chat/completions`

| 请求字段 | 规则 |
| --- | --- |
| `model` | 必填，Agent 配置 UUID |
| `messages` | 必填，纯文本消息数组；最后一条必须是非空 `user` |
| `stream` | 可选，默认 `false`；`true` 返回 SSE |
| `n` | 可选，只支持 `1` |

支持 `user`、`assistant` 历史，`system`、`developer` 只能放在历史之前。历史作为 Agent 的对话输入传递，Agent 自身的系统约束仍有效。不支持 `tools`、图片、音频、采样参数或其他额外 OpenAI 请求字段；响应不提供 token usage。

| Header | 说明 |
| --- | --- |
| 请求 `X-Instance-Id` | 选择已有实例；省略时使用默认 API 实例 |
| 请求 `X-Session-Id` | 平台签发的 HTTP 续聊句柄；此时 `messages` 必须恰好是一条新 `user` 消息 |
| 响应 `X-Instance-Id` | 实际使用的实例 |
| 响应 `X-Session-Id` | 后续续聊需要保存的句柄 |
| 响应 `X-Session-Expires-At` | 句柄过期时间提示 |
| 响应 `X-Request-Id` | 问题排查使用的请求标识 |

### 4.1 两轮 SDK 示例

在接入方自己的 Node.js 项目中安装 `openai`，将下列代码保存为 `chat.mjs` 后执行 `node chat.mjs`。沿用前面导出的环境变量。

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: `${process.env.BASE_URL}/api/v1`,
  maxRetries: 0,
  timeout: 310_000,
});
const headers = process.env.INSTANCE_ID
  ? { 'X-Instance-Id': process.env.INSTANCE_ID }
  : {};
const { data, response } = await client.chat.completions.create({
  model: process.env.AGENT_ID,
  messages: [{ role: 'user', content: '请记住本次项目代号是海星，并简短确认。' }],
}, { headers }).withResponse();
console.log(data.choices[0].message.content);

const sessionId = response.headers.get('x-session-id');
const instanceId = response.headers.get('x-instance-id');
if (!sessionId || !instanceId) throw new Error('缺少续聊响应头');

const stream = await client.chat.completions.create({
  model: process.env.AGENT_ID,
  messages: [{ role: 'user', content: '刚才的项目代号是什么？' }],
  stream: true,
}, {
  headers: { 'X-Instance-Id': instanceId, 'X-Session-Id': sessionId },
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta.content ?? '');
}
process.stdout.write('\n');
```

对话成功返回 OpenAI 原生 JSON，例如：

```json
{
  "id": "chatcmpl_example",
  "object": "chat.completion",
  "created": 1800000000,
  "model": "00000000-0000-4000-8000-000000000001",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "已记住。" }, "finish_reason": "stop" }]
}
```

SSE 的每个事件为 `data: <JSON>`，正常完成最后发送 `data: [DONE]`。首块可能只有 `role`；只读取 `delta.content` 中的回答文本。`finish_reason` 为 `stop` 或 `length`，分别表示停止或达到长度限制。错误或断流不代表正常完成，即使 HTTP 已返回 `200` 也要处理流中的错误及读取异常。

### 4.2 续聊、并发与恢复

1. 不带 `X-Session-Id`：开启独立会话，可携带完整、有序的文本历史。
2. 带 `X-Session-Id`：在原会话继续，只发送一条新 `user`，同时保留原 Agent 和实例选择。
3. 同一句柄串行使用；上一轮结束后再发下一轮。同一句柄并发返回 `409 / AGENT_SESSION_BUSY`。不同句柄可并发，但共享实例文件，并受平台并发额度约束。
4. 句柄空闲有效期为 30 分钟；失败、取消、实例停止或重启、平台服务重启后可能失效。多副本部署需要平台保证续聊路由到原服务进程。
5. `409 / SESSION_UNAVAILABLE` 时，由业务明确决定是否不带旧句柄、携带完整历史开启新会话；恢复文本历史不会回滚已发生的工具操作。
6. 平台对单次 HTTP 对话设置 300 秒总时限。接入方网关及客户端应设置相匹配的超时；网络超时不证明 Agent 未执行，不要自动重试可能有副作用的请求。

## 5. ACP WebSocket 对话

需要管理 ACP 会话或接收 Agent 原生事件时，使用 connect 返回的 `relay.wsUrl`。将其与 `BASE_URL` 组合，再把 `https` 改为 `wss`、`http` 改为 `ws`；保留完整路径和 query。WebSocket 握手使用相同的 Bearer 认证。

Node.js `ws` 连接示例（先安装 `ws`）：

```javascript
import WebSocket from 'ws';
const url = new URL(process.env.RELAY_PATH, process.env.BASE_URL);
url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(url, {
  headers: { Authorization: `Bearer ${process.env.API_KEY}` },
});
socket.on('error', console.error);
socket.on('close', (code, reason) => console.log('连接关闭', code, reason.toString()));
socket.on('message', raw => console.log(JSON.parse(raw.toString())));
```

浏览器原生 WebSocket 不能自定义 Bearer header；接入方应使用自己的后端中转，不将 API Key 放进连接 URL。

协议顺序：

1. 等待服务端 Agent `status` 消息，确认 `payload.connected` 为 `true`，再发送会话请求；能力以 `payload.capabilities` 为准。
2. 发送 `session/new`，按 JSON-RPC `id` 关联响应，保存 `result.sessionId`。
3. 发送第一轮 `session/prompt`；接收 `session/update` 并聚合文本，直到对应 prompt 的 JSON-RPC 成功响应。
4. 使用同一 `sessionId` 发送第二轮，复用对话上下文。同一会话不要并发 prompt。

以下为按上述时序发送的三条帧，`SESSION_ID_FROM_REPLY` 要替换为实际响应值：

```json
{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}
{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"SESSION_ID_FROM_REPLY","content":[{"type":"text","text":"请记住项目代号是海星。"}]}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"SESSION_ID_FROM_REPLY","content":[{"type":"text","text":"项目代号是什么？"}]}}
```

收到的 JSON-RPC 可能直接在根对象，也可能包在 `{ "type": "...", "payload": { "jsonrpc": "2.0", ... } }` 中，客户端应兼容两种格式。回答文本通知形如：

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"SESSION_ID_FROM_REPLY","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"海星"}}}}
```

只聚合当前会话的 `agent_message_chunk`。prompt 响应中的 `result.stopReason` 表示本轮结束原因；`end_turn` 为正常结束，JSON-RPC `error` 为失败。出现工具授权或人工输入请求时，客户端需要按 Agent 实际协议处理，不应无条件自动放行。

工作目录由平台按当前工作区确定，调用方不传入本机目录。断开 WebSocket 只关闭这条连接，不等于停止实例；连接丢失后不保证原 ACP 会话可恢复，应重新 connect 并按 Agent 能力处理会话恢复。

## 6. 工作区文件

先 connect 成功，再使用其 `environmentId` 操作文件。文件路径均相对于工作区根目录。

### 6.1 上传

`POST /api/v1/environments/{environmentId}/workspace/files`

```bash
curl --fail-with-body -sS \
  -X POST "$BASE_URL/api/v1/environments/$ENVIRONMENT_ID/workspace/files" \
  -H "Authorization: Bearer $API_KEY" \
  -F 'path=user/docs' -F 'files=@./example.txt'
```

成功返回 `200`，`data` 为：

```json
{"environmentId":"ENVIRONMENT_ID","files":[{"name":"example.txt","path":"user/docs/example.txt","size":128}]}
```

| multipart 字段 | 规则 |
| --- | --- |
| `files` | 至少一个文件；多个文件重复传同名字段 |
| `path` | 上传目标目录；省略默认 `user`；空字符串或 `.` 表示根目录 |
| `relativePaths` | 可选，JSON 字符串数组，与 `files` 顺序和数量一致，用于指定文件的相对路径 |

示例文件最终位于 `user/docs/example.txt`。同名目标返回 `409`，不会覆盖。拒绝绝对路径、`..` 路径段、控制字符和软链接越界。单文件上限为 92 MiB，远端上传整批上限为 92 MiB，整请求上限为 108 MiB，包含 multipart 开销；网关可能另设更小限制。

上传成功后，可向 Agent 发送“请阅读 `user/docs/example.txt` 并总结”。不要将调用方本机路径作为工作区路径传给 Agent。

### 6.2 查询文件树

`GET /api/v1/environments/{environmentId}/workspace/files`

```bash
curl --fail-with-body -sS \
  "$BASE_URL/api/v1/environments/$ENVIRONMENT_ID/workspace/files" \
  -H "Authorization: Bearer $API_KEY"
```

返回 `data.environmentId`、`data.paths`，可能附带 `mtimes` 和 `errors`。目录以 `/` 结尾；`errors` 非空说明文件树不完整，不能据此断言某个文件不存在。

### 6.3 下载

`GET /api/v1/environments/{environmentId}/workspace/files/download?path=...`

```bash
curl --fail-with-body -sS -G \
  "$BASE_URL/api/v1/environments/$ENVIRONMENT_ID/workspace/files/download" \
  -H "Authorization: Bearer $API_KEY" \
  --data-urlencode 'path=user/docs/example.txt' -o ./downloaded-example.txt
```

成功为原始文件流；失败为 JSON 错误，应检查 HTTP 状态，避免把错误 JSON 当作文件。远端文件服务不可用时会报错；实例停止后，文件保留，但文件接口可能需要先 connect 恢复实例才能使用。

## 7. 实例查询、停止与重启

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/agents/{agentId}/instances?page=1&pageSize=20` | 当前用户可访问的该 Agent 的 API、用户实例；不包含工作流实例 |
| `GET /api/v1/instances/{instanceId}` | 单个实例详情，不启动实例 |
| `POST /api/v1/instances/{instanceId}/stop` | 同步等待停止完成，成功返回 `200` |
| `POST /api/v1/instances/{instanceId}/restart` | 显式重启，成功返回 `200` 和实例详情 |

列表返回 `data: { items, total, page, pageSize }`，默认页码 1、每页 20，`pageSize` 最大 100。实例详情包含 `instanceId`、`agentConfigId`、`environmentId`、`name`、`creationSource`、`isDefault`、`status`、`runtimeGeneration`、`createdAt` 和 `updatedAt`。

`status` 为 `stopped`、`starting`、`running`、`stopping` 或 `unknown`。状态是平台当前观察值；遇到 `unknown` 应联系平台排查，不能把它当作已停止。平台服务重启后的状态也不构成旧进程退出的证明。

```bash
curl --fail-with-body -sS -X POST \
  "$BASE_URL/api/v1/instances/$INSTANCE_ID/stop" \
  -H "Authorization: Bearer $API_KEY"
```

本版本停止接口会等待停止处理完成，耗时取决于 Agent 和执行节点，可能达到数秒至十余秒；成功返回 `{"success":true,"data":null}`。HTTP 超时不能直接视为停止失败，可先查询实例详情再决定是否重试。

停止或重启会影响该实例上的全部会话，使旧 HTTP 续聊句柄失效；停止实例不会删除工作区。一次聊天请求结束或关闭某条 ACP 连接，不会主动停止整个共享实例。配置更新后如需让运行中的实例应用新配置，应显式 restart。

## 8. 响应与错误处理

普通资源接口使用统一包装：

```json
{"success":true,"data":{}}
```

```json
{"success":false,"error":{"code":"NOT_FOUND","message":"Resource not found"}}
```

对话接口使用 OpenAI 原生格式，不带 `success/data` 包装：

```json
{"error":{"message":"Session unavailable","type":"invalid_request_error","code":"SESSION_UNAVAILABLE"}}
```

| HTTP 状态 | 建议处理 |
| --- | --- |
| `400 / 422` | 请求字段或参数不符合接口定义，修改后再调用 |
| `401` | 检查密钥及有效期 |
| `403 / 404` | 检查资源 ID、用户归属与当前权限；不可访问资源也可能返回 404 |
| `409` | 按 `error.code` 区分会话忙、句柄失效、资源冲突；不统一盲重试 |
| `413` | 缩小文件或请求体 |
| `429` | 并发、频率或会话容量受限，降低并发后有限重试 |
| `500 / 502 / 503 / 504` | 检查服务或执行节点状态；有副作用的操作先确认结果，再决定是否重试 |

日志保留 HTTP 状态、`error.code`、请求时间、资源 ID 和可取得的 `X-Request-Id`，便于平台排查；不记录 API Key。创建、执行、重启等请求没有通用幂等键承诺；断网或超时后不要假定“完全未执行”。

## 9. 可选配置类接口

已有平台管理员提供的 Agent 时，可跳过本节。需要接入方自行配置资源时，先取得相应管理权限，并在在线 OpenAPI 中查看完整字段、必填项及响应。

| 资源 | 接口 |
| --- | --- |
| Agent | `GET/POST /api/v1/agents`；`GET/PATCH/DELETE /api/v1/agents/{id}` |
| Provider | `GET/POST /api/v1/providers`；`GET/PATCH/DELETE /api/v1/providers/{providerId}` |
| Model | `GET/POST /api/v1/providers/{providerId}/models`；`GET/PATCH/DELETE /api/v1/providers/{providerId}/models/{id}` |
| Skill | `GET/POST /api/v1/skills`；`GET/PATCH/DELETE /api/v1/skills/{id}` |
| MCP | `GET/POST /api/v1/mcp-servers`；`GET/PATCH/DELETE /api/v1/mcp-servers/{id}` |
| 知识库 | `GET /api/v1/knowledge-bases`，列出当前组织已有知识库 |
| Workflow v2 | `POST /api/v1/workflow-v2/workflows/{id}/run`，参数及执行模式见在线定义 |

创建 Agent 的最小示例：

```http
POST /api/v1/agents
Authorization: Bearer <API_KEY>
Content-Type: application/json

{"name":"partner-assistant","modelId":"<Model 资源 UUID>","prompt":"回答用户问题","skillIds":[],"mcpIds":[],"enableMemory":false}
```

成功返回 `201`，从 `data.id` 获取新 Agent ID。这里的 `modelId` 是模型资源 ID；对话接口的 `model` 则是 Agent ID，两者不同。执行节点需由平台准备，或按在线 schema 指定可用节点。

需要绑定已有知识库时，在创建或 PATCH Agent 时提交 `knowledge: { knowledgeBaseIds: ["KB_ID"] }`；清空知识库配置用 `knowledge: null`。Agent 配置、记忆开关和指定关联整体保存，资源不可访问或绑定无效时拒绝该次更新。

PATCH 只更新提交字段，省略字段保留原值，数组整体替换；显式 null 按在线 schema 清空。未知字段、无效绑定和空 PATCH 会被拒绝。配置更新不会自动重启已有实例。网关型 Provider 及其模型只读；凭据不回读。Skill 导入使用 multipart；MCP 替换配置时应重新提供必要凭据。知识库接口不提供创建知识库或上传知识文档的能力。
