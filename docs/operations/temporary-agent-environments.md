# 临时环境接入

外部后端使用现有用户 API Key，组织上下文和权限沿原规则恢复。每个需要独立文件的访客交互保存自己的 `environmentId` 与 `instanceId`。

## 最小调用顺序

1. `POST /api/v1/agents/{agentId}/environments`，JSON 为 `{ "temporary": true }`。
2. 直接聊天会自动启动实例。需要先操作文件时，先调用原 `POST /api/v1/agents/{agentId}/instances/connect`，传 `{ "instanceId": "返回的实例 ID" }`，确保原实例完成准备；然后通过原 `/api/v1/environments/{environmentId}/workspace/files` 接口上传、列出或下载文件。
3. 使用标准 OpenAI SDK，baseURL 指向 `/api/v1`，在 `X-Instance-Id` 中传入返回的实例 ID。
4. 需要继续占用环境时调用 `POST /api/v1/environments/{environmentId}/renew`，JSON 为 `{}`。调用方根据返回的 `expiresAt` 安排下一次续期。
5. 不再续期时，原有空闲回收或到期停止释放 Runtime；也可调用原实例停止接口主动释放。失败待办保存在 Environment 的 `expiryReclaimedAt` 确认字段中，启动及每 10 分钟补扫一次。

外部列表 `GET /api/v1/agents/{agentId}/instances` 默认只返回普通实例。添加 `?environmentType=temporary` 查询临时实例，`?environmentType=all` 查询两类；`page`、`pageSize` 与 `total` 使用相同筛选条件，组织、用户及 Agent 权限不变。列表可以找回资源 ID，访客与环境的业务映射仍需接入方保存。

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.FENIX_USER_API_KEY,
  baseURL: `${process.env.FENIX_BASE_URL}/api/v1`,
});
const response = await client.chat.completions.create(
  { model: agentId, messages: [{ role: "user", content: "处理已上传的文件" }] },
  { headers: { "X-Instance-Id": instanceId } },
);
```

多轮调用可复用原 `X-Session-Id` HTTP 续聊句柄；续期环境不延长该句柄的 30 分钟空闲期限。句柄失效后重新发送 messages 历史，环境文件仍保留。

## TTL 与失败处理

1. 默认 TTL 为 3600 秒；`RCS_TEMP_ENV_MAX_TTL_SECONDS` 默认 86400 秒，需要重启才能修改部署上限。
2. Agent 管理者可用 `GET/PUT/DELETE /api/v1/agents/{agentId}/environment-policy` 配置 TTL。PUT body 为 `{ "ttlSeconds": 3600 }`；不修改已有环境期限。
3. 到期聊天/启动返回 410，显式 renew 后可继续。renew 可能因额度不足返回 429，或因机器不可用返回 503；已保存期限保留，可重试原环境。
4. 文件接口没有到期检查或额外的取消机制。文件可用时机沿旧逻辑：远端实例未准备或已停止时可能无法访问；通过 renew 恢复原实例后，继续访问原目录。
5. 自动回收保留环境、实例和工作区。当前不做目录删除，磁盘容量需要由后续运维清理流程管理。
6. 重启保留原 `expiresAt`，恢复剩余期限调度并补扫已过期、未确认回收的环境。尚未到期可通过原聊天或 connect 恢复实例，无需因重启先 renew；已到期仍需 renew。旧对话不保证跨重启恢复，节点恢复沿原 Runtime 规则处理。无法确认旧进程退出的历史项保留待办并记录 `ENVIRONMENT_RUNTIME_UNCONFIRMED` 诊断，不能把空内存当作成功；本地异常重启的孤儿进程定位仍需原运行环境的排障流程。

创建只写数据库，不要求执行节点在线。工作区、引擎配置和节点侧实例状态均在原启动流程中准备，执行节点不可用时由聊天、connect 或 renew 报告启动失败；不新增节点指令，也不增加 acp-link 升级要求。

共享进程与引擎全局状态保持原行为，仅工作区按 environmentId 区分。平台 Hindsight 记忆关闭；不为 SDK 或引擎增加私有 HOME 等隔离配置。Claude 执行链问题[单独记录](../design/claude-code-execution-chain-follow-up.md)。

完整契约见[临时 Environment](../arch/temporary-agent-environments.md)，并发管理见[动态并发策略](../arch/agent-concurrency-policy.md)。
