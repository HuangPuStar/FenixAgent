# Feature: 20260513_F002 - fs-to-pg-storage

## 需求背景

当前项目的配置数据（providers、models、agents、mcp、skills 等）全部存储在 `~/.config/opencode/opencode.json` 文件中，通过 `config.ts` 的 `getSection`/`modifySection` 泛型接口读写。这种设计有以下问题：

- **无用户隔离**：所有用户共享同一份配置文件，无法支持多租户
- **并发风险**：虽然实现了文件互斥锁，但分布式场景下无法保证一致性
- **查询能力弱**：无法对配置数据进行结构化查询
- **Skills 重复存储**：opencode.json 中的 skills 部分与 `~/.agents/skills/` 目录是同一套数据的两种存储形式

项目已完成 SQLite → PostgreSQL 迁移（F001），现在需要将文件系统存储的配置数据也迁移到 PG。

## 目标

- 将 opencode.json 中的 providers、models、agents、mcp 配置建模为 PG 关系表，支持每用户独立配置
- Skills 元数据入 PG（内容保留文件系统），统一 opencode.json skills 部分和文件系统技能目录为一张 `skill` 表
- 完全切换到 PG，移除 `config.ts` 的文件 I/O 代码（workspace 配置注入除外）
- API 接口保持不变，前端无需改动

## 方案设计

### 数据模型

新增 6 张表，全部带 `user_id` 外键实现多租户隔离。

#### provider — AI 服务商

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK auto | |
| user_id | TEXT FK→user NOT NULL | |
| name | VARCHAR NOT NULL | 标识符如 "openai"、"anthropic" |
| display_name | VARCHAR | 显示名 |
| npm | VARCHAR | SDK 包名，默认 `@ai-sdk/openai-compatible` |
| base_url | TEXT | API 地址 |
| api_key | TEXT | 密钥（保留 `{env:XXX}` 引用模式） |
| extra_options | JSONB | options 中除 apiKey/baseURL 外的字段 |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

UNIQUE(`user_id`, `name`)

#### model — AI 模型（原 provider.models 子对象）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK auto | |
| provider_id | UUID FK→provider NOT NULL | 所属服务商 |
| model_id | VARCHAR NOT NULL | 模型标识如 "gpt-4o" |
| display_name | VARCHAR | 显示名 |
| modalities | JSONB | 模态配置 |
| limit_config | JSONB | `{context, output}` |
| cost | JSONB | 费用配置 |
| options | JSONB | 模型级额外选项 |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

UNIQUE(`provider_id`, `model_id`)，级联删除跟随 provider。

#### agent_config — Agent 配置

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK auto | |
| user_id | TEXT FK→user NOT NULL | |
| name | VARCHAR NOT NULL | "general"、"build" 等 |
| model | VARCHAR | 引用格式 "provider/model_id" |
| prompt | TEXT | Agent 提示词 |
| steps | INTEGER | 最大步数 |
| mode | VARCHAR(20) | primary / subagent / all |
| permission | JSONB | 权限配置（ask/allow/deny + 通配符规则） |
| variant | VARCHAR | |
| temperature | NUMERIC | |
| top_p | NUMERIC | |
| disable | BOOLEAN DEFAULT FALSE | |
| hidden | BOOLEAN DEFAULT FALSE | |
| color | VARCHAR | |
| description | TEXT | |
| knowledge | JSONB | `{knowledgeBaseIds, policy}` |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

UNIQUE(`user_id`, `name`)

内置 Agent（build、plan、general、explore、title、summary、compaction）通过代码逻辑保护，数据库层不做特殊处理。

#### mcp_server — MCP 服务器

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK auto | |
| user_id | TEXT FK→user NOT NULL | |
| name | VARCHAR NOT NULL | |
| type | VARCHAR(10) NOT NULL | "local" / "remote" |
| config | JSONB NOT NULL | 完整配置（command/url/headers/environment 等） |
| enabled | BOOLEAN DEFAULT TRUE | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

UNIQUE(`user_id`, `name`)

#### skill — 技能元数据

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID PK auto | |
| user_id | TEXT FK→user NOT NULL | |
| environment_id | UUID FK→environment | NULL=全局技能，有值=工作区技能 |
| name | VARCHAR NOT NULL | |
| description | TEXT | |
| content_path | TEXT | SKILL.md 文件路径（内容保留在文件系统） |
| metadata | JSONB | frontmatter 自定义字段 |
| enabled | BOOLEAN DEFAULT TRUE | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

唯一约束通过两个 partial unique index 实现：
- `CREATE UNIQUE INDEX idx_skill_global ON skill(user_id, name) WHERE environment_id IS NULL;`
- `CREATE UNIQUE INDEX idx_skill_workspace ON skill(user_id, environment_id, name) WHERE environment_id IS NOT NULL;`

Skills 的 Markdown 内容继续存文件系统（`content_path` 指向 SKILL.md），元数据通过 PG 管理。旧的文件系统技能目录不自动扫描入 PG，仅新创建的技能通过 PG 接口管理。

#### user_config — 用户偏好（单行）

| 字段 | 类型 | 说明 |
|------|------|------|
| user_id | TEXT PK FK→user | |
| default_agent | VARCHAR | 默认 Agent 名 |
| current_model | VARCHAR | 当前选中的模型 |
| small_model | VARCHAR | 小模型选择 |
| permission | JSONB | 全局权限覆盖 |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

### 服务层改造

#### 新增 `src/services/config-pg.ts`

替代 `config.ts` 的文件 I/O，提供结构化的 PG CRUD 函数：

**Provider 操作**
- `listProviders(userId)` — 列出用户所有 provider，含 modelCount 聚合
- `getProvider(userId, name)` — 获取单个 provider 及其 models
- `upsertProvider(userId, name, data)` — 创建或更新 provider
- `deleteProvider(userId, name)` — 删除 provider 及关联 models（CASCADE）

**Model 操作**（嵌套在 provider 下）
- `addModel(providerId, data)` — 在 provider 下添加 model
- `updateModel(providerId, modelId, data)` — 更新 model
- `removeModel(providerId, modelId)` — 删除 model

**Agent 操作**
- `listAgentConfigs(userId)` — 列出用户所有 agent
- `getAgentConfig(userId, name)` — 获取单个 agent
- `createAgentConfig(userId, name, data)` — 创建 agent
- `updateAgentConfig(userId, name, data)` — 更新 agent（仅写入白名单字段）
- `deleteAgentConfig(userId, name)` — 删除 agent（内置 agent 代码层拦截）

**MCP 操作**
- `listMcpServers(userId)` — 列出用户所有 MCP 服务器
- `getMcpServer(userId, name)` — 获取单个
- `createMcpServer(userId, name, config)` — 创建
- `updateMcpServer(userId, name, config)` — 更新
- `deleteMcpServer(userId, name)` — 删除
- `setMcpServerEnabled(userId, name, enabled)` — 启用/禁用

**Skill 操作**
- `listSkills(userId)` — 列出全局技能
- `listWorkspaceSkills(userId, environmentId)` — 列出工作区技能
- `getSkill(userId, name, environmentId?)` — 获取技能元数据
- `upsertSkill(userId, name, data)` — 创建或更新（同时写 SKILL.md 到 content_path）
- `deleteSkill(userId, name, environmentId?)` — 删除元数据和文件
- `enableSkill(userId, name)` / `disableSkill(userId, name)` — 切换状态

**UserConfig 操作**
- `getUserConfig(userId)` — 获取用户偏好（不存在则返回默认值）
- `setUserConfig(userId, patch)` — 更新偏好字段

#### 改造 `src/services/skill.ts`

- 元数据读写从文件系统切换到 PG（通过 `config-pg.ts`）
- Markdown 内容仍读写文件系统（`content_path` 指向的 SKILL.md）
- 启用/禁用改为更新 `enabled` 字段，不再移动文件目录

#### 保留 `src/services/config.ts`

仅保留 workspace 配置注入功能（`{workspace}/.opencode/config.json`），这是给 opencode 进程读取的运行时配置，不适合入 PG。移除所有全局 `getSection`/`modifySection`/`setTopLevelField`/`getConfig` 的文件 I/O 代码。

### 路由层改造

每个配置路由（`providers.ts`、`models.ts`、`agents.ts`、`mcp.ts`、`skills.ts`）将 `getSection`/`modifySection` 调用替换为 `config-pg.ts` 的结构化函数。所有操作传入 `userId`（从 `store.user.id` 获取）。API 接口（action-based POST）保持不变，前端无需改动。

### Drizzle Schema

在 `src/db/schema.ts` 中新增 6 张表的 drizzle 定义，并在 `initDb()` 中添加对应的 `CREATE TABLE IF NOT EXISTS` 语句。

## 实现要点

- **无数据迁移**：旧 `opencode.json` 不导入 PG，从空库开始。旧文件保留但不读取
- **Skills 不自动扫描**：旧的 `~/.agents/skills/` 目录中的技能不自动导入 PG。仅通过 PG 接口新创建的技能入库
- **API Key 安全**：继续使用 `{env:XXX}` 引用模式，PG 中存储的是引用而非明文
- **模型引用格式**：Agent 的 `model` 字段保持 "provider/model_id" 字符串格式，不改为 FK（保持灵活性）
- **MCP config JSONB**：MCP 服务器因 local/remote 结构差异大，使用 JSONB 存储完整配置
- **内置 Agent 保护**：在服务层代码中检查，不允许删除 build/plan/general 等内置 agent
- **workspace 配置注入**：保留文件写入逻辑（`{workspace}/.opencode/config.json`），运行时由 opencode 进程读取
- **并发安全**：PG 的行级锁天然替代了文件互斥锁

## 验收标准

- [ ] 6 张新表在 `schema.ts` 中定义，`initDb()` 可正确创建
- [ ] `config-pg.ts` 提供完整的 CRUD 函数，覆盖 provider/model/agent_config/mcp_server/skill/user_config
- [ ] 5 个配置路由全部改用 PG 服务，不再调用 `getSection`/`modifySection`
- [ ] Skills 创建/读取/更新/删除通过 PG 管理元数据，Markdown 内容读写文件系统
- [ ] `bun test src/__tests__/` 全部通过
- [ ] `bun run typecheck` 零错误
- [ ] 服务器启动后，前端配置页面（providers/models/agents/mcp/skills）可正常使用
