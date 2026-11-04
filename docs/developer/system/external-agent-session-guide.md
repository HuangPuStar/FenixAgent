# 外部系统配置与运行 Agent

稳定协议见 [External Agent API v1](../../arch/external-api-v1.md)，字段见 `/docs/openapi/external`。下面的 API_KEY、各资源 ID 和执行节点需使用当前环境实际值。

## 脚本联调

在仓库根目录执行，需已安装 Bun，并启动平台服务及可用的 Agent 执行节点。

1. 首次使用时复制配置模板；已有本地配置则直接编辑，避免覆盖：

   ```bash
   cp scripts/test-external-api-v1.config.example.ts scripts/test-external-api-v1.config.local.ts
   ```

2. 编辑本地配置中的 `AGENT_CONFIG`：填写 `baseUrl`、平台 `apiKey`、上游 Provider / Model、已有知识库 ID、可访问的 MCP 服务及执行节点。地址改为实际服务地址，例如 `http://127.0.0.1:3000`。本地配置已被 Git 忽略，不提交密钥。
3. 运行 Agent 全流程测试，控制台会打印每个接口的输入、输出和检查结果：

   ```bash
   # 默认连续执行，不等待输入
   bun scripts/test-agent-api-v1.ts

   # 逐接口、逐轮对话等待回车，便于观察页面数据
   bun scripts/test-agent-api-v1.ts -t

   # 只列出覆盖的接口，不读取配置、不发请求
   bun scripts/test-agent-api-v1.ts --list
   ```

脚本覆盖 Agent、Provider / Model、Skill、MCP、知识库查询、实例和文件上传，以及 OpenAI / ACP 各三轮对话。成功结束时清理本轮创建的配置资源，上传文件保留；失败或中断时停止执行并打印资源线索，便于排查及手动清理。测试会真实调用模型。

Workflow v2 使用独立脚本，读取同一个本地配置文件中的 `WORKFLOW_V2_CONFIG`，也支持 `-t` 和 `--list`：

```bash
bun scripts/test-workflow-v2-api-v1.ts
```

工作流需事先发布，在配置中填写 `workflowId` 和输入参数；脚本只执行已有工作流并保留运行记录。

## 最小流程

1. 查询或创建 Provider、Model；网关配置和模型只读。
2. 按需查询 Skill、MCP 和当前组织已有 KB。
3. 创建 Agent，绑定 modelId、skillIds、mcpIds、knowledge.knowledgeBaseIds 及可用执行节点。
4. connect 取得 Environment 与 Instance，按需上传文件。
5. 选择 OpenAI SDK 对话或 ACP relay。需要应用配置变化时显式 restart，不再使用时 stop。

AgentConfig 是配置；Environment 是用户工作区；Instance 是持久运行身份；Chat 会话是该实例上的独立 ACP session。并发多个不同会话不需要启动多个实例。

## 查询与配置

```bash
export BASE_URL='http://localhost:3000'
# API_KEY 通过当前终端的安全方式注入，不写入源码。
curl -s "$BASE_URL/api/v1/providers" -H "Authorization: Bearer $API_KEY" | jq '.data.items'
curl -s "$BASE_URL/api/v1/providers/$PROVIDER_ID/models" -H "Authorization: Bearer $API_KEY" | jq '.data.items'
curl -s "$BASE_URL/api/v1/knowledge-bases" -H "Authorization: Bearer $API_KEY" | jq '.data.items'
```

创建 Agent 示例；modelId 为模型数据库 ID，执行节点须可用，也可使用平台已配置的默认节点：

```bash
curl -s -X POST "$BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"external-demo","modelId":"MODEL_DATABASE_ID","prompt":"回答用户问题","skillIds":[],"mcpIds":[],"enableMemory":false}' | jq '.data'
```

PATCH 只提交需要改的字段；省略保留原值，数组整体替换。使用已有 KB 时提交 `knowledge: { knowledgeBaseIds: ["KB_ID"] }`；清空用 null。配置错误或不可绑定资源会在写入前被拒，指定配置与关联一起提交。

## connect、上传与生命周期

```bash
curl -s -X POST "$BASE_URL/api/v1/agents/$AGENT_ID/instances/connect" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' -d '{}' | jq '.data'
```

省略 instanceId 会准备 api/api；传 `{ "instanceId": "inst_..." }` 可选择本人已有的 api / user 实例。结果含 environmentId、instanceId、status、runtimeGeneration、relay.wsUrl。列表和详情不会自动启动实例：

```bash
curl -s "$BASE_URL/api/v1/agents/$AGENT_ID/instances" -H "Authorization: Bearer $API_KEY" | jq '.data'
curl -s "$BASE_URL/api/v1/instances/$INSTANCE_ID" -H "Authorization: Bearer $API_KEY" | jq '.data'
curl -s -X POST "$BASE_URL/api/v1/instances/$INSTANCE_ID/restart" -H "Authorization: Bearer $API_KEY" | jq '.data'
```

上传到刚取得的 Environment：

```bash
curl -s -X POST "$BASE_URL/api/v1/environments/$ENVIRONMENT_ID/workspace/files" \
  -H "Authorization: Bearer $API_KEY" -F 'path=user/docs' -F 'files=@./example.txt' | jq '.data'
```

文件将位于 user/docs/example.txt。省略 path 默认写入 user/；传 `-F 'path='` 或 `-F 'path=.'` 写入工作区根目录，传 `-F 'path=docs'` 写入 docs/。所有路径必须位于当前 Environment 工作区内，绝对路径、.. 段、控制字符和软链接逃逸均被拒绝。relativePaths 如需传递，使用与 files 顺序、数量一致的 JSON 数组。同名文件返回 409，不覆盖。远程文件服务未连接会明确失败。

## OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.API_KEY,
  baseURL: `${process.env.BASE_URL}/api/v1`,
  maxRetries: 0,
});
const { data, response } = await client.chat.completions.create({
  model: process.env.AGENT_ID!,
  messages: [{ role: "user", content: "阅读 user/docs/example.txt 并总结" }],
}).withResponse();
console.log(data.choices[0].message.content);
const handle = response.headers.get("x-session-id");
const instanceId = response.headers.get("x-instance-id");

const next = await client.chat.completions.create({
  model: process.env.AGENT_ID!,
  messages: [{ role: "user", content: "再用一句话概括" }],
  stream: true,
}, { headers: { "X-Session-Id": handle!, "X-Instance-Id": instanceId! } });
for await (const chunk of next) process.stdout.write(chunk.choices[0]?.delta.content ?? "");
```

每次不带 X-Session-Id 的请求创建独立会话，可以提交完整有序文本历史；续聊只传一条新 user。不要同时向同一续聊句柄发送两个请求；不同句柄可并发。同一实例共享 Environment 文件。SDK 默认自动重试可能重复运行，示例将其关闭。

句柄在当前进程维护，失败、取消、stop / restart 后失效。409 SESSION_UNAVAILABLE 时，客户端明确决定是否以完整历史开启新会话，不能把失败请求自动当成已成功运行。

## ACP relay

将 connect 返回的 relay.wsUrl 拼到当前服务 WebSocket 地址，并用同一凭据认证。通过既有 ACP JSON-RPC 执行 session/new、session/prompt、session/load 等动作；服务端强制注入认证 Environment 的 cwd，客户端不指定本地或任意绝对目录。

relay 支持原始 JSON-RPC 和现有 acp-link 包裹格式，保留 Agent status / capabilities；不使用 Yjs。客户端管理各 ACP session ID 并按消息关联分发，不把它们当作 Environment 或 Instance 标识。断开 relay 只关闭连接，不停止共享 runtime。

先发送 `session/new`，收到成功响应的 sessionId 后再发送 prompt；现有 ACP relay 使用 `content` 字段：

```json
{"jsonrpc":"2.0","id":1,"method":"session/new","params":{}}
{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"SESSION_ID_FROM_REPLY","content":[{"type":"text","text":"你好"}]}}
```

## 停止与诊断

```bash
curl -s -X POST "$BASE_URL/api/v1/instances/$INSTANCE_ID/stop" -H "Authorization: Bearer $API_KEY"
```

普通错误读取 error.code / error.message；SDK 错误读取原生 OpenAI error。排查时记录 X-Request-Id 与 Instance，避免记录密钥、原始 ACP ID 和完整对话。实例 A 停止不会停止实例 B；当前请求结束不会停止同实例其他会话。
