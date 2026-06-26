# 配置系统

> 对应文件：`src/services/config/` 目录（`provider.ts`、`model.ts`、`agent-config.ts`、`agent-config-skill.ts`、`agent-config-mcp.ts`、`agent-config-site-app.ts`、`mcp-server.ts`、`skill.ts`、`user-config.ts`、`types.ts`、`jsonb.ts`），路由文件：`src/routes/web/config/` 目录

## 这个模块干什么

配置系统管理用户的所有 AI 相关配置：用哪个服务商（Provider）、选哪个模型（Model）、Agent 怎么配（AgentConfig）、装了哪些 MCP 服务器、启用了哪些 Skill、用户个人偏好（UserConfig）。

所有配置存在 PostgreSQL 里，按组织隔离（多租户），支持**跨组织资源共享**。Agent 配置通过 `launch-spec-builder.ts` 在实例启动时自动注入。

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

所有路由文件位于 `src/routes/web/config/`，通过 `index.ts` 统一注册。

## 每个模块的细节

### Provider（`provider.ts`）

每个 Provider 代表一个 AI 服务商。核心字段：

- `name`：组织内唯一标识（如 `openai`）
- `displayName`：显示名称
- `protocol`：`"openai"` | `"anthropic"`
- `baseUrl`：API 地址
- `apiKey`：密钥（响应中只返回 `keyHint`，格式为 `***{realKey.slice(-4)}`——即尾 4 位明文前缀 3 个星号）
- `extraOptions`：JSONB 格式的扩展参数
- 一个 Provider 下面可以挂多个 Model

**API Key 掩码**：`toKeyHint(apiKey)` 函数（`config-utils.ts`）解析 apiKey 后返回 `***` + 尾 4 位。短于 4 位的 key 统一返回 `"*******"`。

**跨组织共享**：`publicReadable: true` 时，其他组织可通过 `{sourceOrganizationId}/{resourceUid}` 格式的 resourceKey 读取 Provider。

### Model（`model.ts`）

挂在 Provider 下面，记录具体模型的信息：

- `modelId`：模型 ID（如 `gpt-4o`）
- `displayName`：显示名
- `modalities`、`limitConfig`、`cost`、`options`：JSONB 字段，存储模型能力参数

**可用性缓存**（`routes/web/config/models.ts`）：按 `organizationId` 隔离的 5 分钟 TTL 内存缓存（`cachedAvailableByOrg`）。缓存构建需要遍历所有 readable provider 和它们的 model 列表。Provider 变更（创建/更新/删除）时由前端调用 `refresh` action 或 `invalidateAvailableCache()` 强制刷新。

### AgentConfig（`agent-config.ts`）

Agent 的配置。内置 Agent（`build`、`plan`、`general`、`explore`、`title`、`summary`、`compaction`、`meta`）不可删除，但可以修改配置。

核心字段（`AGENT_SETTABLE_FIELDS` 白名单）：
- `model` / `modelId`：使用的模型（modelId 是 model 表的 UUID）
- `prompt`：系统 prompt
- `description`：描述
- `extra`：JSONB 扩展字段（`AgentExtraConfig`）
- `machineId`：绑定的远程 machine（用于远程部署）
- `engineType`：引擎类型（`"opencode"` | `"ccb"` | `"claude-code"`，默认 `"opencode"`）
- `knowledge`：知识库绑定配置（`AgentKnowledgeConfig`）

**关联资源**（操作时自动同步）：
- **Skill 绑定**（`agent-config-skill.ts`）：通过 `agentConfigSkill` 关联表，`syncAgentSkills(agentConfigId, skillIds)` 全量覆盖
- **MCP 绑定**（`agent-config-mcp.ts`）：通过 `agentConfigMcp` 关联表，`syncAgentMcps(agentConfigId, mcpIds)` 全量覆盖
- **SiteApp 绑定**（`agent-config-site-app.ts`）：通过 `agentSiteApp` 关联表
- **知识库绑定**（`agent-knowledge.ts`）：通过 `agentKnowledgeBinding` 关联表

**Agent 模板**（`services/agent-templates.ts`）：

`.agents/agents/` 目录下的 Markdown + YAML frontmatter 文件提供预设模板：

```markdown
---
name: 模板名称
description: 模板描述
skills:
  - skill-name
---
正文内容作为 prompt...
```

- 文件名（去 `.md`）作为模板 id
- 结果通过 `GET /config/agents/templates` 暴露
- 进程级内存缓存，只读一次磁盘

**Hindsight 记忆 MCP**（`services/hindsight.ts`）：

创建/更新 Agent 配置时，若勾选 `enableMemory`，自动调用 `ensureHindsightMcpServer(ctx)`：
- 创建名为 `"hindsight"` 的 MCP server 记录（`streamable-http` 类型）
- 调用 `ensureBank()` 确保 Hindsight bank 存在（以 memberId 作为 bankId）

Agent 列表接口返回 `knowledgeBaseCount` 字段，显示关联的知识库数量。

### McpServer（`mcp-server.ts`）

MCP 工具服务器配置。4 种类型：

| 类型 | 说明 | 核心字段 |
|------|------|----------|
| `local` | 命令行启动（stdio transport） | `command`（数组）、`environment`、`timeout` |
| `remote` | URL 连接（SSE transport） | `url`、`headers`、`oauth`、`timeout` |
| `streamable-http` | Streamable HTTP 连接 | `url`、`headers`、`timeout` |
| `disabled` | 已禁用的服务器 | 仅 `enabled: false`，config 为空 |

**MCP Tool 缓存**（`mcpTool` 表）：
- `replaceToolsForServer()`：事务内原子替换（先删后插），缓存 `inspectedAt` 时间戳
- `listToolsByServer()` / `countToolsByServer()`：查询已缓存的 tool
- 用于 MCP `list_tools` 和 `inspect` 功能

**MCP 服务器管理路由**：`POST /config/mcp` + action（`list` / `get` / `set` / `delete` / `enable` / `disable`），还包括 `list_tools` 和 `test_url` 等操作 action，由路由层分发。

### Skill（`skill.ts`）

Skill 的**元数据**（name、description、metadata）存在 PostgreSQL `skill` 表中，**内容**（SKILL.md 文件）存在文件系统。

**存储路径**：`{SKILL_DIR}/{organizationId}/{name}/SKILL.md`（`SKILL_DIR` 默认 `./data/skills`）。

**关键约定**：必须通过 `setSkill()`（`skill.ts` 服务层）或 `importSkillDirectories()` 创建 Skill，它们同时写 DB + 文件系统。直接调用 `upsertSkill()` 只写 DB，会导致 Skill 不下发给 Agent。

**Skill 路由**（`routes/web/config/skills.ts`）：
- `GET /config/skills`：列出所有 Skill
- `GET /config/skills/:name`：获取单个 Skill 详情（含内容）
- `POST /config/skills`：创建新 Skill
- `PUT /config/skills/:name`：更新已有 Skill
- `DELETE /config/skills/:name`：删除 Skill
- `GET /config/skills/:name/download`：下载 Skill 为 zip 文件
- `POST /config/skills/upload`：批量上传 Skill 目录（multipart/form-data）

### UserConfig（`user-config.ts`）

用户偏好，按 `organizationId` 唯一键存储（每个组织每个用户最多一行）。通过 `onConflictDoUpdate` 实现 upsert：

- `defaultAgent`：默认 Agent 名称
- `currentModel`：当前使用的模型（provider/modelId 格式）
- `smallModel`：小型模型（用于标题生成、摘要等）
- `permission`：全局权限覆盖（JSONB，`PermissionConfig` 类型）

## 跨组织资源共享（ResourceAccess）

所有配置模块（Provider / Model / AgentConfig / McpServer / Skill）支持跨组织共享：

**ResourceAccess 结构**：
```typescript
interface ResourceAccess {
  ownership: "internal" | "external";     // 内部 vs 共享
  sourceOrganizationId: string;            // 来源组织
  sourceOrganizationName?: string;         // 来源组织名称
  resourceUid: string;                     // 资源 UUID
  resourceKey: string;                     // "{sourceOrganizationId}/{resourceUid}"
  manageable: boolean;                     // 是否可管理（内部资源）
  writable: boolean;                       // 是否可写（仅内部资源）
  publicReadable?: boolean;                // 是否公开可读
}
```

**权限检查**（`resource-permission.ts`）：
- `decorateResourceAccess(ctx, resourceType, rows)`：为 DB 行附加 access 元数据
- `assertInternalWritable(ctx, resourceType, id, orgId)`：内部资源可写检查
- `setPublicRead(ctx, resourceType, orgId, id, publicReadable)`：设置公开可读
- `listReadableResourceRefs(ctx, resourceType)`：列出可见的外部资源引用
- `canReadResource(ctx, resourceType, id, orgId)`：检查读取权限

外部资源通过 `{sourceOrganizationId}/{resourceUid}` 格式的 resourceKey 引用。路由层自动解析 resourceKey 识别跨组织引用。

## 和其他模块的关系

- → `db/schema.ts`：直接操作 provider / model / agentConfig / mcpServer / skill / userConfig / agentConfigSkill / agentConfigMcp / agentSiteApp / agentKnowledgeBinding 等表
- → `services/skill.ts`：Skill 内容文件的读写（`setSkill` / `getSkill` / `importSkillDirectories`）
- → `services/skill-fs.ts`：文件系统操作（`getGlobalSkillsDir` / `createSkillArchiveBuffer`）
- → `services/resource-permission.ts`：跨组织权限（`decorateResourceAccess` / `listReadableResourceRefs`）
- → `services/agent-knowledge.ts`：知识库绑定同步
- → `services/agent-templates.ts`：Agent 模板加载
- → `services/hindsight.ts`：Hindsight 记忆 MCP 自动创建
- → `services/config-utils.ts`：统一响应工具（`configSuccess` / `configError` / `toKeyHint`）
- ← `routes/web/config/`：路由层调用 config service 函数
- ← `services/launch-spec-builder.ts`：拼接 AgentConfig + Provider + Model + Skill + MCP 为 LaunchSpec
- ← 前端通过 RESTful / action-based API 访问
