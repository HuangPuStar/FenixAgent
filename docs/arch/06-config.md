# 配置系统

> 对应文件：`src/services/config-pg.ts`、`src/routes/web/config/index.ts`、`src/schemas/config.schema.ts`

## 这个模块干什么

配置系统管理用户的所有 AI 相关配置：用哪个服务商（Provider）、选哪个模型（Model）、Agent 怎么配（AgentConfig）、装了哪些 MCP 服务器、启用了哪些 Skill。

所有配置存在 PostgreSQL 里，通过一个统一的 REST API (`POST /web/config/:module`) 访问，按用户隔离（多租户）。

## 六大配置模块

```
Provider（服务商）     比如 OpenAI、Anthropic、本地 Ollama
   │
   ├── Model（模型）   GPT-4o、Claude Sonnet、llama3 等，挂在 Provider 下面
   │
AgentConfig（Agent）   build、plan、general 等内置 Agent，也可自定义
   │
McpServer（MCP）       MCP 工具服务器配置（local 命令行 或 remote URL）
   │
Skill（技能）          SKILL.md 文件的元数据，内容在文件系统
   │
UserConfig（偏好）     用户的默认 Agent、默认模型等个人设置
```

## 统一 API 设计

所有配置模块共用一个入口：

```text
POST /web/config/:module

module = providers | models | agents | skills | mcp

请求体：
{
  "action": "list" | "get" | "set" | "create" | "delete" | "enable" | "disable",
  ...按 action 不同有不同字段
}

响应：
{ "success": true, "data": { ... } }
或
{ "success": false, "error": { "code": "NOT_FOUND", "message": "..." } }
```

`config-pg.ts` 是这个 API 的 Service 层实现。路由层接收请求，解析 action，调用 config-pg 对应的函数。

## 每个模块的细节

### Provider

每个 Provider 代表一个 AI 服务商。核心字段：

- `name`：唯一标识（如 `openai`）
- `baseUrl`：API 地址
- `apiKey`：密钥（响应中只返回 `keyHint`，尾 4 位）
- `npm`：对应的 npm 包名
- 一个 Provider 下面可以挂多个 Model

### Model

挂在 Provider 下面，记录具体模型的信息：

- `modelId`：模型 ID（如 `gpt-4o`）
- `displayName`：显示名
- `modalities`、`limitConfig`、`cost`、`options`：JSONB 字段，存储模型能力参数

### AgentConfig

Agent 的配置。内置 Agent（build、plan、general 等）不可删除，但可以修改配置。核心字段：

- `name`：Agent 名称
- `model`：使用的模型
- `prompt`：系统 prompt
- `permission`：权限配置（JSONB，三态 ask/allow/deny）
- `knowledge`：知识库绑定（JSONB）
- `steps`、`temperature`、`topP` 等：运行参数

### McpServer

MCP 工具服务器。两种类型：

- `local`：通过命令行启动（如 `npx -y @modelcontextprotocol/server-github`）
- `remote`：通过 URL 连接（SSE 端点）

### Skill

Skill 的**元数据**存在 DB 里，**内容**（SKILL.md 文件）存在文件系统 `~/.agents/skills/<name>/SKILL.md`。

支持两种 scope：
- 全局 Skill（`environmentId` 为 null）
- Workspace Skill（绑定到特定环境）

### UserConfig

用户的个人偏好，每个用户一行记录：
- `defaultAgent`、`currentModel`、`smallModel`
- `permission`：全局权限覆盖

## 和其他模块的关系

- → `db/schema.ts`：直接操作 6 张配置表
- → `services/skill.ts`：Skill 内容文件的读写
- ← `routes/web/config/index.ts`：路由层调用 config-pg 的函数
- ← 前端通过 `POST /web/config/:module` API 访问
- Agent 运行时通过 `services/instance.ts` 的 workspace 配置注入获得 AgentConfig 和 McpServer 信息
