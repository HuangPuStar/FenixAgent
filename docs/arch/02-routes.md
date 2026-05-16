# 路由层

> 对应目录：`src/routes/`

## 这个模块干什么

路由层是所有 HTTP 请求的入口。它负责：
- 把 URL 分发到对应的处理函数
- 校验请求参数（通过 `schemas/` 下的 schema）
- 检查权限（通过 `authGuardPlugin`）
- 调用 Service 层完成业务逻辑，返回结果

路由层**不包含业务逻辑**，只是"接请求、调服务、返结果"的中间人。

## 路由分组

每个子目录对应一组 URL 前缀，在 `index.ts` 中通过 `.use()` 挂载：

### `/web/*` —— 控制面板 API

前端 React 应用使用的所有接口。认证方式：`sessionAuth`（better-auth 的 cookie session）。

| 路由文件 | URL 前缀 | 功能 |
|---------|----------|------|
| `web/sessions.ts` | `/web/sessions` | 会话列表、详情、删除 |
| `web/environments.ts` | `/web/environments` | 环境列表、创建、更新、删除 |
| `web/instances.ts` | `/web/instances` | 实例 spawn、stop、列表 |
| `web/config/index.ts` | `/web/config/:module` | 统一配置 CRUD 入口（providers/models/agents/skills/mcp） |
| `web/tasks.ts` | `/web/tasks` | 定时任务 CRUD、手动触发、执行日志 |
| `web/api-keys.ts` | `/web/api-keys` | API Key 的创建、列表、删除、重命名 |
| `web/channels.ts` | `/web/channels` | Channel 绑定管理、Hermes 状态查询 |
| `web/knowledge-bases.ts` | `/web/knowledge-bases` | 知识库 CRUD、资源管理、Agent 绑定 |
| `web/files.ts` | `/web/sessions/:id/user/*` | 会话文件系统的读写上传 |
| `web/s3-files.ts` | `/web/s3/*` | S3 presigned URL 生成 |
| `web/control.ts` | `/web/control` | 会话控制（发消息、中断） |
| `web/auth.ts` | `/web/auth` | 当前用户信息 |
| `web/workflow-proxy.ts` | `/workflow/*` | 反向代理到 acpx-g 工作流引擎 |

### `/acp/*` —— ACP 协议

WebSocket 端点，处理 acp-link Agent 和前端的实时通信。

| 路由文件 | URL | 协议 | 说明 |
|---------|-----|------|------|
| `acp/index.ts` | `/acp/ws` | WebSocket (NDJSON) | acp-link 注册端点，详见 [04-acp-transport.md](./04-acp-transport.md) |
| `acp/index.ts` | `/acp/relay/:agentId` | WebSocket (JSON) | 前端与 Agent 的中继，详见 [04-acp-transport.md](./04-acp-transport.md) |

### `/v1/*` —— 兼容层

给 acp-link CLI 和旧版 bridge 客户端用的 REST 接口。

| 路由文件 | URL 前缀 | 说明 |
|---------|----------|------|
| `v1/environments.ts` | `/v1/environments` | 环境注册、注销、重连 |
| `v1/environments.work.ts` | `/v1/environments/:id` | Work 分发（长轮询） |
| `v1/sessions.ts` | `/v1/sessions` | 会话列表、详情 |
| `v1/session-ingress.ts` | `/v1/sessions/:id/ingress` | 事件推入（bridge 客户端上报事件） |

### `/v2/*` —— Worker 协议

v2 版本的 Worker 注册和事件流，通过 SSE 推送。

| 路由文件 | URL 前缀 | 说明 |
|---------|----------|------|
| `v2/code-sessions.ts` | `/v2/code-sessions` | 代码会话管理 |
| `v2/worker.ts` | `/v2/worker` | Worker 注册 |
| `v2/worker-events.ts` | `/v2/worker-events` | 事件提交 |
| `v2/worker-events-stream.ts` | `/v2/worker-events-stream` | SSE 事件流 |

### `/mcp/*` —— MCP 知识库

| 路由文件 | URL | 说明 |
|---------|-----|------|
| `mcp/knowledge.ts` | `/mcp/knowledge` | MCP 端点，供 Agent 运行时查询知识库 |

## 和其他模块的关系

- 调用 `services/*` 下的各种服务完成业务逻辑
- 通过 `plugins/auth` 的 macro 做权限校验
- 通过 `schemas/*` 做请求参数校验
- 通过 `plugins/repositories` 获取仓储实例
