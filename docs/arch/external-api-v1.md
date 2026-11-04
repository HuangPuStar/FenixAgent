# External Agent API v1

## 协议与边界

外部资源 API 使用 `/api/v1/*`，普通响应为 `{ success: true, data }` 或 `{ success: false, error: { code, message } }`。创建资源返回 201，删除成功返回 `data: null`；集合统一 `data: { items, total, page, pageSize }`，分页默认 1 / 20，pageSize 最大 100。

`POST /api/v1/chat/completions` 严格使用 OpenAI 原生 JSON、SSE 和错误结构，不加平台包装。ACP relay 是独立 WebSocket 协议，保持 ACP，不提供 Yjs。

`/api/system`、`/api/auth` 保持独立契约，并继续从外部 OpenAPI 排除。协议 DTO、版本适配与领域能力分离：Web 和 v1 可复用领域授权、配置、持久化及运行能力，但不共享会随 Web 改变的请求默认值与响应视图。Web 或内部实现变化必须保留已发布 v1 的行为；无法保留时发布新版本。

外部调用使用用户 API Key 的 Bearer token。组织取凭据并重新校验当前成员身份，不能由请求覆盖；资源动作遵循当前授权结果。敏感凭据只写不回读，不返回内部文件路径、原始 ACP 会话 ID 或运行错误详情。

## 资源操作

下表省略 `/api/v1` 前缀；ID 为数据库资源 ID，不能使用名称代替。

| 资源 | 操作 |
| --- | --- |
| Agent | `GET/POST /agents`；`GET/PATCH/DELETE /agents/:id` |
| Provider | `GET/POST /providers`；`GET/PATCH/DELETE /providers/:providerId` |
| Model | `GET/POST /providers/:providerId/models`；`GET/PATCH/DELETE /providers/:providerId/models/:id` |
| Skill | `GET/POST /skills`；`GET/PATCH/DELETE /skills/:id` |
| MCP | `GET/POST /mcp-servers`；`GET/PATCH/DELETE /mcp-servers/:id` |
| KB | `GET /knowledge-bases` |
| Instance | `GET /agents/:id/instances`；`POST /agents/:id/instances/connect`；`GET /instances/:id`；`POST /instances/:id/stop`、`/restart` |
| 文件 | `GET/POST /environments/:environmentId/workspace/files`；`GET /environments/:environmentId/workspace/files/download?path=...` |
| 对话 | `POST /chat/completions` |
| Workflow v2 | `POST /workflow-v2/workflows/:id/run` |

公开文档合计 36 项。请求与响应字段以 `/docs/openapi/external/json` 为准。

## 配置规则

1. PATCH 省略字段保留原值；显式 null 或空数组按 schema 清空。未知字段、空 PATCH 和重复绑定 ID 拒绝。Agent 的配置、记忆开关与指定关联在同一事务中保存，并串行化同一 Agent 更新。
2. Provider 返回 `kind: direct | gateway`。网关 Provider 及其模型只读；模型 ID 必须属于路径中的 Provider。普通 Provider 的 apiKey 只写不读，返回 hasApiKey。
3. Skill 创建是单目录 multipart 导入，manifest 与 files 一一对应且保留二进制。默认同名 409，授权覆盖保留资源 ID 与受众，返回 200；新建 201。PATCH 的 metadata 整体替换。文件、归档和数据库失败时执行既有补偿。
4. MCP 创建为 `{ name, config, publicReadable? }`；PATCH 为完整 config 替换、单独 enabled 或单独 publicReadable，不能混用。配置替换须重新提供必要字段和凭据。响应只暴露 headerNames、environmentNames、hasClientSecret 等凭据状态。历史无连接配置的行不能直接启用。
5. KB 只列当前组织已有资源，不提供创建或上传文档。remoteExists 为 true / false / null，分别表示远端存在 / HTTP 404 / 未知；列表检查不回写配置或远端元数据。
6. 配置更新不会隐式重启已有 runtime；调用方需要时显式 restart。共享 Environment 内的文件不承诺会话隔离。

## 实例与 ACP

自动调用仅选择当前组织、当前用户、当前 Agent 的 `api/api` 持久实例；默认环境按 createdAt、id 稳定选取，首次准备通过数据库事务锁防重。显式 instanceId 必须是当前用户在当前组织拥有且绑定该 Agent 的 api / user 实例，不能使用 workflow 实例。

Relay 在异步认证前建立有界入站队列，认证与归属校验完成后才转发；原始与包裹 JSON-RPC 在边界处归一化为 ACP 请求。

Relay 在异步认证前建立有界入站队列，认证与归属校验完成后才转发；原始与包裹 JSON-RPC 在边界处归一化为 ACP 请求。

connect 返回 agentConfigId、environmentId、instanceId、status、runtimeGeneration 和 relay.wsUrl。WebSocket 升级后重新校验环境、实例与 Agent use 权限；session/new、load、list、resume 的 cwd 由服务端按认证 Environment 注入，客户端不能改变。

stop / restart 只影响指定实例，失效其对话句柄；请求结束或取消只释放自己的 relay / turn，不停止共享 runtime。

## OpenAI SDK 与续聊

标准请求只支持 `model`（Agent 配置 UUID）、纯文本 `messages`、`stream`、`n: 1`。支持 system / developer 前缀和有序 user / assistant 历史，最后一条必须是非空 user。历史经 ACP 内容编码，不等价于模型原生多角色输入；Agent 自身系统约束仍生效。不支持 tools、多模态、采样参数、伪造 usage 或额外 OpenAI 字段。

响应只包含公开回答文本，不输出思考、计划、工具 XML。end_turn / refusal 映射 stop，长度限制映射 length。SSE 首块声明 assistant，确认成功终态后才发送 finish_reason 与 `[DONE]`；中断或失败不伪造成功。

扩展全部使用 HTTP headers：

| Header | 用途 |
| --- | --- |
| 请求 `X-Instance-Id` | 选择已授权已有实例；省略时使用默认 api/api |
| 请求 `X-Session-Id` | 服务端签发的续聊句柄；此时 messages 必须恰好一条 user |
| 响应 `X-Instance-Id` | 实际运行实例 |
| 响应 `X-Session-Id` | 随机不透明句柄，不含原始 ACP ID |
| 响应 `X-Session-Expires-At` | 句柄过期时间提示 |
| 响应 `X-Request-Id` | 请求诊断关联标识 |

句柄绑定组织、用户、Agent、Environment、Instance 和 runtime generation。同一会话重入返回 409；不同会话可以并发。句柄仅保存在当前服务进程；取消、失败、实例停止 / 重启或进程重启后失效。多副本部署需将续聊固定到同一进程，否则返回 SESSION_UNAVAILABLE，不能静默创建替代会话。

注册表限制为每组织 / 用户 256、进程 10000；只淘汰闲置句柄，不淘汰活动请求，活动占满时返回 429。请求总时限 300 秒，流式背压预算 64 KiB，非流式累计事件预算 16 MiB；终止独立于客户端继续读取，确保释放当前请求资源。

## 文件与 Workflow

工作区上传省略 path 时默认 user；显式空字符串或 . 表示工作区根目录，其他相对目录也可写入。所有上传路径均相对服务端解析的当前 Environment 工作区；拒绝绝对路径（含 Windows / UNC 格式）、.. 段和控制字符。整批先校验文件名、relativePaths 数量、路径和重复目标，再读取并调用统一文件服务；本地与远程均拒绝覆盖已有文件。单文件 92 MiB，远程批次总量 92 MiB；整请求预算 108 MiB，包括无 Content-Length 的流式上传。除词法与 realpath 检查外，本地与远程写入逐级使用不跟随 symlink 的目录描述符并排他创建最终文件，防止父目录在校验后被替换。远程断开不回退本地。审计使用当前用户和 api 来源。

Workflow v2 执行端点保留业务参数、领域状态码、异步和限流行为，使用 v1 路径与包装。同步结果或异步执行信息在外层 data 内；框架参数错误仍为 422。上游业务 data 字段仍属于嵌套结果，不与平台包装混淆。执行重试可能产生新运行，调用方按业务自行去重。
