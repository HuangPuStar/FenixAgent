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
聚合入口：`src/routes/web/index.ts`（prefix: `/web`）。

| 路由文件 | URL 前缀 | 功能 |
|---------|----------|------|
| `web/sessions.ts` | `/web/sessions` | 会话列表、详情、删除、历史查询 |
| `web/environments.ts` | `/web/environments` | 环境列表、创建、更新、删除、进入 |
| `web/instances.ts` | `/web/instances` | 实例 spawn、stop、列表 |
| `web/config/index.ts` | `/web/config/:module` | 统一配置 CRUD 入口（providers/models/agents/skills/mcp） |
| `web/tasks.ts` | `/web/tasks` | 定时任务 CRUD、手动触发、执行日志 |
| `web/organizations.ts` | `/web/organizations` | 组织 CRUD、成员邀请、角色管理、API Key 管理（含创建/列表/删除/重命名） |
| `web/channels.ts` | `/web/channels` | Channel 绑定管理、Hermes 状态查询 |
| `web/knowledge-bases.ts` | `/web/knowledge-bases` | 知识库 CRUD、资源管理、Agent 绑定 |
| `web/files.ts` | `/web/environments/:id/user/*` | 环境工作区文件系统的读写上传 |
| `web/user-file.ts` | `/web/environments/:id/user/*` | 用户文件工作区（目录浏览、文件读写、批量删除） |
| `web/control.ts` | `/web/control` | 会话控制（发消息、中断） |
| `web/auth.ts` | `/web/auth` | 当前用户信息、会话归属绑定 |
| `web/branding.ts` | `/web/branding` | 品牌展示配置（名称、Logo） |
| `web/skills.ts` | `/web/skills` | Skill 管理（列表、详情、启用/禁用） |
| `web/registry.ts` | `/web/registry` | 机器注册表管理（机器列表、详情、事件历史） |
| `web/meta-agent.ts` | `/web/meta-agent` | Meta Agent 自举与运行环境确保 |
| `web/hindsight.ts` | `/web/hindsight` | Hindsight 记忆服务状态查询 |
| `web/agent-generation.ts` | `/web/agent-generation` | Agent 智能生成（根据描述自动创建 Agent 配置） |
| `web/agent-sites.ts` | `/web/agent-sites` | Agent Sites 业务前端管理 |
| `web/workflow-defs.ts` | `/web/workflow-defs` | 工作流定义 CRUD、版本管理、触发器管理 |
| `web/workflow-engine.ts` | `/web/workflow-engine` | DAG 工作流执行引擎（run / dryRun / cancel / approve 等 action） |
| `web/workflow-runs.ts` | `/web/workflow-runs` | 工作流运行记录列表 |
| `web/workflow-sse.ts` | `/web/workflow-sse` | 工作流 SSE 事件流推送 |
| `web/workflow-custom-tools.ts` | `/web/workflow-custom-tools` | 自定义工作流节点工具注册表查询 |

### `/acp/*` —— ACP 协议

WebSocket 端点，处理 acp-link Agent 和前端的实时通信。
聚合入口：`src/routes/acp/index.ts`（prefix: `/acp`）。

| URL | 协议 | 说明 |
|-----|------|------|
| `GET /acp/agents` | HTTP | 获取当前组织下所有 ACP Agent 列表及在线状态 |
| `WS /acp/ws` | WebSocket (NDJSON) | acp-link 注册端点，通过 `secret` query 参数认证，详见 [04-acp-transport.md](./04-acp-transport.md) |
| `WS /acp/file-ws` | WebSocket | 远程文件操作端点，通过 `secret` query 参数认证 |
| `WS /acp/relay/:agentId` | WebSocket (JSON) | 前端与指定 Agent 的中继，需 session 认证，详见 [04-acp-transport.md](./04-acp-transport.md) |

### `/v1/code/sessions/*` —— Code Session / Worker API

源码位于 `src/routes/v2/` 目录，但实际挂载前缀为 `/v1/code/sessions`（向后兼容 TUI / bridge 客户端）。

| 路由文件 | URL | 协议 | 说明 |
|---------|-----|------|------|
| `v2/code-sessions.ts` | `POST /v1/code/sessions` | HTTP | 创建 Code Session（TUI 兼容包装响应） |
| `v2/code-sessions.ts` | `POST /v1/code/sessions/:id/bridge` | HTTP | 获取 Session Bridge 连接信息 + Worker JWT |
| `v2/worker.ts` | `/v1/code/sessions/:id/worker` | HTTP | Worker 注册、状态更新、心跳 |
| `v2/worker-events.ts` | `/v1/code/sessions/:id/worker/events` | HTTP | Worker 事件提交 |
| `v2/worker-events-stream.ts` | `GET /v1/code/sessions/:id/worker/events-stream` | SSE | Worker 事件 SSE 流（支持 Last-Event-ID 断线重连） |

### `/v2/session_ingress/*` —— Session Bridge Ingress

源码：`src/routes/v2/session-ingress.ts`（prefix: `/v2/session_ingress`）。

| URL | 协议 | 说明 |
|-----|------|------|
| `POST /v2/session_ingress/:sessionId/events` | HTTP | Bridge 客户端事件推入（JWT + API Key 双认证） |
| `WS /v2/session_ingress/ws/:sessionId` | WebSocket | Bridge 客户端 WebSocket 事件推入（JWT 认证） |

### `/api/*` —— 面向外部系统的 API

面向外部系统和第三方服务的 REST API。认证方式：`apiKeyAuth`（API Key header）。

| 路由文件 | URL 前缀 | 功能 |
|---------|----------|------|
| `api/agents.ts` | `/api/agents` | Agent 配置管理（列表、详情、创建、更新、删除） |
| `api/models.ts` | `/api/models` | Model 管理（列表、详情、创建、更新、删除、连接测试） |
| `api/skills.ts` | `/api/skills` | Skill 管理（列表、详情、创建、上传、删除） |
| `api/mcp.ts` | `/api/mcp` | MCP Server 管理（列表、详情、创建、更新、删除、连接测试） |
| `api/instances.ts` | `/api/instances` | Agent 实例连接（spawn、查询） |
| `api/knowledge-bases.ts` | `/api/knowledge-bases` | 知识库只读查询 |
| `api/workspaces.ts` | `/api/workspaces` | Environment Workspace 文件上传与管理 |
| `api/system.ts` | `/api/system` | 系统级管理接口（用户管理、组织管理、API Key 签发），使用 `RCS_SYSTEM_API_KEYS` 认证 |

### `/hooks/*` —— Webhook 触发

| 路由文件 | URL | 说明 |
|---------|-----|------|
| `hooks.ts` | `POST /hooks/:publicHash` | 外部 webhook 端点（无需认证），通过 hash 标识 trigger 异步触发 workflow |

### `/mcp/*` —— MCP 知识库

| 路由文件 | URL | 说明 |
|---------|-----|------|
| `mcp/knowledge.ts` | `ALL /mcp/knowledge` | MCP 端点，供 Agent 运行时通过 Bearer token 查询知识库内容 |

### `/workflow-ui/*` —— 工作流引擎反向代理

| 路由文件 | URL 前缀 | 说明 |
|---------|----------|------|
| `web/workflow-proxy.ts` | `/workflow-ui` | 反向代理到 acpx-g 工作流引擎（静态资源 + API） |

### `/{appId}/*` —— Agent Sites 业务前端代理

| 路由文件 | URL | 说明 |
|---------|-----|------|
| `agent-sites-proxy.ts` | `/{appId}/*` | 反向代理到 Agent Sites 业务前端（`/app-{uuid}/*` 格式），根据可见性级别决定认证要求 |

### `/api/auth/*` —— better-auth 认证端点

源码：`src/plugins/auth.ts`（prefix: `/api/auth`）。

| URL | 说明 |
|-----|------|
| `GET /api/auth/encryption-key` | 获取加密密钥 |
| `GET /api/auth/signup-status` | 查询注册是否开放 |
| `ALL /api/auth/*` | better-auth 标准端点（登录/注册/登出/session 管理等） |

### `/ctrl/*` —— 前端控制台静态文件

源码：`src/plugins/static.ts`（prefix: `/ctrl`）。

托管 `web/dist/` 目录下的前端构建产物。

### `/health`、`/` —— 全局端点

| URL | 说明 |
|-----|------|
| `GET /health` | 健康检查，返回 `{ status: "ok", version }` |
| `GET /` | 302 跳转到 `/ctrl/` 控制台首页 |

## 和其他模块的关系

- 调用 `services/*` 下的各种服务完成业务逻辑
- 通过 `plugins/auth` 的 macro 做权限校验
- 通过 `schemas/*` 做请求参数校验
- 通过 `repositories/*` 获取仓储实例
