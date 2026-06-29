# 配置系统

## 这个模块干什么

配置系统管理用户的所有 AI 相关配置：用哪个服务商（Provider）、选哪个模型（Model）、Agent 怎么配（AgentConfig）、装了哪些 MCP 服务器、启用了哪些 Skill、用户个人偏好（UserConfig）。

所有配置存在 PostgreSQL 里，按组织隔离（多租户），支持**跨组织资源共享**。Agent 配置在实例启动时自动注入。

## 六大配置模块

```
Provider（服务商）     比如 OpenAI、Anthropic、本地 Ollama
   │
   ├── Model（模型）   GPT-4o、Claude Sonnet、llama3 等，挂在 Provider 下面
   │
AgentConfig（Agent）   build、plan、general 等内置 Agent，也可自定义
   │
   ├── Skill 绑定       Agent 关联的 skill 列表（agentConfigSkill 表）
   ├── MCP 绑定         Agent 关联的 MCP server 列表（agentConfigMcp 表）
   └── SiteApp 绑定     Agent 关联的站点应用（agentSiteApp 表）
   │
McpServer（MCP）       MCP 工具服务器配置（4 种类型）
   │
Skill（技能）          SKILL.md 文件的元数据，内容在文件系统
   │
UserConfig（偏好）     用户的默认 Agent、默认模型等偏好
```

## 路由架构

配置模块的路由已从统一的 `POST /web/config/:module` + `action` 模式改为**混合模式**：

| 模块 | 路由风格 | 端点 |
|------|----------|------|
| **Providers** | `POST /config/providers` + action | `list` / `get` / `set` / `delete` / `deleteById` / `updateById` |
| **Models** | `POST /config/models` + action | `get` / `set` / `refresh` |
| **Agents** | **RESTful** | `GET /config/agents` / `POST /config/agents` / `PUT /config/agents` / `DELETE /config/agents` |
| **Agents 模板** | **RESTful** | `GET /config/agents/templates` |
| **Agents 默认** | `POST /config/agents/default` | 设置当前用户的默认 Agent |
| **Skills** | **RESTful** | `GET /config/skills` / `POST /config/skills` / `PUT /config/skills/:name` / `DELETE /config/skills/:name` |
| **MCP** | `POST /config/mcp` + action | `list` / `get` / `set` / `delete` / `enable` / `disable` |

## 每个模块的细节

### Provider

每个 Provider 代表一个 AI 服务商。核心字段：

- `name`：组织内唯一标识（如 `openai`）
- `displayName`：显示名称
- `protocol`：`"openai"` | `"anthropic"`
- `baseUrl`：API 地址
- `apiKey`：密钥（响应中只返回掩码提示，格式为 `***` + 尾 4 位明文）
- `extraOptions`：JSONB 格式的扩展参数
- 一个 Provider 下面可以挂多个 Model

**设计决策：API Key 掩码**。响应中不返回完整密钥，仅返回尾部 4 位的掩码形式。短于 4 位的 key 统一返回全星号掩码。这是防止密钥在 API 响应中泄露的安全措施。

**跨组织共享**：通过 `publicReadable` 标记公开可读，其他组织可通过复合标识（来源组织 ID + 资源 UUID）引用 Provider。

### Model

挂在 Provider 下面，记录具体模型的信息：

- `modelId`：模型 ID（如 `gpt-4o`）
- `displayName`：显示名
- `modalities`、`limitConfig`、`cost`、`options`：JSONB 字段，存储模型能力参数

**设计决策：可用性缓存**。按组织隔离的 5 分钟 TTL 内存缓存，避免每次请求都遍历所有 provider 和 model 列表。Provider 变更时强制刷新缓存，保证一致性。

### AgentConfig

Agent 的配置。内置 Agent（`build`、`plan`、`general`、`explore`、`title`、`summary`、`compaction`、`meta`）不可删除，但可以修改配置。

核心字段（白名单控制可设置字段）：
- `model` / `modelId`：使用的模型（关联 model 表的 UUID）
- `prompt`：系统 prompt
- `description`：描述
- `extra`：JSONB 扩展字段
- `machineId`：绑定的远程 machine（用于远程部署）
- `engineType`：引擎类型（`"opencode"` | `"ccb"` | `"claude-code"`，默认 `"opencode"`）
- `knowledge`：知识库绑定配置

**关联资源同步**（操作 AgentConfig 时自动联动）：
- **Skill 绑定**：通过 `agentConfigSkill` 关联表，全量覆盖式同步
- **MCP 绑定**：通过 `agentConfigMcp` 关联表，全量覆盖式同步
- **SiteApp 绑定**：通过 `agentSiteApp` 关联表
- **知识库绑定**：通过 `agentKnowledgeBinding` 关联表

这些关联资源在 AgentConfig 更新时自动同步，保证 Agent 启动时拿到完整的配置集合。

**Agent 模板**：磁盘目录下的 Markdown + YAML frontmatter 文件提供预设模板。YAML frontmatter 含 `name`、`description`、`skills` 字段，正文作为 prompt。文件名（去 `.md`）作为模板 id。进程级内存缓存，启动时一次性加载。

**Hindsight 记忆 MCP**：创建/更新 Agent 配置时，若启用记忆功能，自动创建名为 `"hindsight"` 的 `streamable-http` 类型 MCP server 记录，并确保 Hindsight bank 存在。这是配置系统和记忆系统的自动化集成点。

### McpServer

MCP 工具服务器配置。4 种类型：

| 类型 | 说明 | 核心字段 |
|------|------|----------|
| `local` | 命令行启动（stdio transport） | `command`（数组）、`environment`、`timeout` |
| `remote` | URL 连接（SSE transport） | `url`、`headers`、`oauth`、`timeout` |
| `streamable-http` | Streamable HTTP 连接 | `url`、`headers`、`timeout` |
| `disabled` | 已禁用的服务器 | 仅 `enabled: false`，config 为空 |

**设计决策：MCP Tool 缓存**。缓存表 `mcpTool` 存储每个 MCP server 提供的工具列表。事务内原子替换（先删后插），避免并发读写不一致。缓存包含检查时间戳，支持后续按需刷新。

### Skill

Skill 采用 **DB + 文件系统双存储** 架构：

- **元数据**（name、description、metadata）存在 PostgreSQL `skill` 表中
- **内容**（SKILL.md 文件）存在文件系统，按组织隔离的目录结构中

**关键约束：双写一致性**。创建或更新 Skill 时，必须同时写入 DB 和文件系统。如果只写 DB 不写文件系统，Skill 内容不会下发给 Agent，导致运行时缺失。这是模块的核心契约。

Skill 路由提供完整的 RESTful CRUD，外加下载为 zip 和批量上传目录功能。

### UserConfig

用户偏好，按组织唯一键存储（每个组织每个用户最多一行）。通过 upsert 模式操作，字段包括默认 Agent、当前模型、小型模型偏好、全局权限覆盖。

## 跨组织资源共享（ResourceAccess）

所有配置模块（Provider / Model / AgentConfig / McpServer / Skill）支持跨组织共享。

**核心概念**：
- **ownership**：区分"内部资源"和"共享的外部资源"
- **resourceKey**：复合标识 `"{来源组织ID}/{资源UUID}"`，跨组织引用的标准格式
- **manageable / writable**：区分是否可管理和可写——仅内部资源可写，外部资源只读
- **publicReadable**：是否公开可读（其他组织可见）

**权限操作**：为查询结果附加访问元数据、内部资源可写校验、公开可读开关、外部资源引用列表、读取权限检查。路由层自动解析 resourceKey 识别跨组织引用，业务方无需手动处理。

## 和其他模块的关系

- → **数据库层**：直接操作 6 张配置表 + 3 张关联表 + 1 张知识库绑定表
- → **Skill 内容服务**：Skill 内容文件的读写与目录管理
- → **跨组织权限服务**：资源访问权限的装饰和引用查询
- → **知识库绑定服务**：Agent 与知识库的绑定关系同步
- → **Agent 模板服务**：模板文件的加载与缓存
- → **Hindsight 记忆服务**：自动创建记忆 MCP server
- → **配置工具服务**：统一响应格式与密钥掩码处理
- ← **路由层**：调用配置服务函数处理前端请求
- ← **LaunchSpec 构建器**：在实例启动时将 Provider + Model + Skill + MCP 拼接为运行时规范
