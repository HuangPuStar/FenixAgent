# Feature 20260513_F002 - fs-to-pg-storage: 实施计划

> 基于 `spec-design.md` 设计文档，本文档定义将文件系统配置存储迁移到 PostgreSQL 的逐步实施计划。
> 无历史数据迁移，从空库开始。旧 opencode.json 保留但不读取。

---

## 阶段总览

| 阶段 | 内容 | 预估工作量 | 依赖 |
|------|------|-----------|------|
| Task 1 | Drizzle Schema 新增 6 张表 (`src/db/schema.ts`) | 中 | 无 |
| Task 2 | initDb() 新增 6 张表的 CREATE TABLE 语句 (`src/db/index.ts`) | 中 | Task 1 |
| Task 3 | 新建 config-pg.ts 服务层 (`src/services/config-pg.ts`) | 大 | Task 1 |
| Task 4 | 改造 skill.ts 元数据管理 (`src/services/skill.ts`) | 中 | Task 3 |
| Task 5 | 改造 providers 路由 (`src/routes/web/config/providers.ts`) | 中 | Task 3 |
| Task 6 | 改造 models 路由 (`src/routes/web/config/models.ts`) | 中 | Task 3 |
| Task 7 | 改造 agents 路由 (`src/routes/web/config/agents.ts`) | 大 | Task 3 |
| Task 8 | 改造 mcp 路由 (`src/routes/web/config/mcp.ts`) | 中 | Task 3 |
| Task 9 | 改造 skills 路由 (`src/routes/web/config/skills.ts`) | 中 | Task 4 |
| Task 10 | 改造 environments 路由中 agent 验证 (`src/routes/web/environments.ts`) | 小 | Task 3 |
| Task 11 | 清理 config.ts 文件 I/O 代码 (`src/services/config.ts`) | 小 | Task 5-9 |
| Task 12 | 测试适配 (`src/__tests__/`) | 大 | Task 1-11 |
| Task 13 | 集成验证与 typecheck | 中 | Task 12 |

---

## Task 1: Drizzle Schema 新增 6 张表

### 目标
在 `src/db/schema.ts` 中新增 `provider`、`model`、`agent_config`、`mcp_server`、`skill`、`user_config` 共 6 张表的 Drizzle ORM 定义。

### 涉及文件
- 修改: `src/db/schema.ts`

### 执行步骤

#### 1.1 新增 provider 表
- 在 `schema.ts` 底部追加 `provider` 表定义
- `id`: `uuid().primaryKey().defaultRandom()`
- `userId`: `text("user_id").notNull().references(() => user.id, { onDelete: "cascade" })`
- `name`: `varchar("name").notNull()`
- `displayName`: `varchar("display_name")`
- `npm`: `varchar("npm")`
- `baseUrl`: `text("base_url")`
- `apiKey`: `text("api_key")`
- `extraOptions`: `jsonb("extra_options")`
- `createdAt`/`updatedAt`: `timestamp(..., { withTimezone: true }).notNull().defaultNow()`
- 唯一索引: `uniqueIndex("idx_provider_user_name").on(table.userId, table.name)`

#### 1.2 新增 model 表
- `id`: `uuid().primaryKey().defaultRandom()`
- `providerId`: `uuid("provider_id").notNull().references(() => provider.id, { onDelete: "cascade" })`
- `modelId`: `varchar("model_id").notNull()`
- `displayName`, `modalities`, `limitConfig`, `cost`, `options`: 按设计文档定义
- 唯一索引: `uniqueIndex("idx_model_provider_model").on(table.providerId, table.modelId)`

#### 1.3 新增 agent_config 表
- `id`: `uuid().primaryKey().defaultRandom()`
- `userId`: `text("user_id").notNull().references(() => user.id, { onDelete: "cascade" })`
- `name`: `varchar("name").notNull()`
- `model`, `prompt`, `steps`, `mode`, `permission`, `variant`, `temperature`, `top_p`, `disable`, `hidden`, `color`, `description`, `knowledge`: 按设计文档定义
- 唯一索引: `uniqueIndex("idx_agent_config_user_name").on(table.userId, table.name)`

#### 1.4 新增 mcp_server 表
- `id`: `uuid().primaryKey().defaultRandom()`
- `userId`: `text("user_id").notNull().references(() => user.id, { onDelete: "cascade" })`
- `name`: `varchar("name").notNull()`
- `type`: `varchar("type", { length: 10 }).notNull()`
- `config`: `jsonb("config").notNull()`
- `enabled`: `boolean("enabled").notNull().default(true)`
- 唯一索引: `uniqueIndex("idx_mcp_server_user_name").on(table.userId, table.name)`

#### 1.5 新增 skill 表
- `id`: `uuid().primaryKey().defaultRandom()`
- `userId`: `text("user_id").notNull().references(() => user.id, { onDelete: "cascade" })`
- `environmentId`: `uuid("environment_id").references(() => environment.id, { onDelete: "cascade" })`
- `name`, `description`, `contentPath`, `metadata`, `enabled`: 按设计文档定义
- 两个 partial unique index (通过 `index` 回调中的 `where` 条件实现)

#### 1.6 新增 user_config 表
- `userId`: `text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" })`
- `defaultAgent`, `currentModel`, `smallModel`, `permission`, `updatedAt`: 按设计文档定义

### 验收
- `bun run typecheck` 无错误
- 6 张新表在 schema.ts 中定义且导出
- 所有外键关系正确引用已存在的表 (user, environment, provider)

---

## Task 2: initDb() 新增 CREATE TABLE 语句

### 目标
在 `src/db/index.ts` 的 `initDb()` 函数末尾追加 6 张表的 `CREATE TABLE IF NOT EXISTS` SQL 语句及索引。

### 涉及文件
- 修改: `src/db/index.ts`

### 执行步骤

#### 2.1 在 initDb() 末尾追加 provider 表 DDL
- 依赖顺序: provider 必须在 model 之前创建
- 包含 UNIQUE 约束和索引

#### 2.2 追加 model 表 DDL
- 外键 `provider_id REFERENCES provider(id) ON DELETE CASCADE`
- UNIQUE(provider_id, model_id)

#### 2.3 追加 agent_config 表 DDL
- 外键 `user_id REFERENCES "user"(id) ON DELETE CASCADE`
- UNIQUE(user_id, name)

#### 2.4 追加 mcp_server 表 DDL
- 外键 `user_id REFERENCES "user"(id) ON DELETE CASCADE`
- UNIQUE(user_id, name)

#### 2.5 追加 skill 表 DDL
- 外键 `user_id REFERENCES "user"(id) ON DELETE CASCADE`
- 外键 `environment_id REFERENCES environment(id) ON DELETE CASCADE`
- 两个 partial unique index:
  - `CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_global ON skill(user_id, name) WHERE environment_id IS NULL;`
  - `CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_workspace ON skill(user_id, environment_id, name) WHERE environment_id IS NOT NULL;`

#### 2.6 追加 user_config 表 DDL
- 主键为 `user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE`

### 验收
- 启动服务器后 `initDb()` 无报错
- `psql` 中 `\dt` 显示 6 张新表
- 索引通过 `\di` 可见

---

## Task 3: 新建 config-pg.ts 服务层

### 目标
创建 `src/services/config-pg.ts`，提供 6 个模块的结构化 PG CRUD 函数，替代 `config.ts` 的 `getSection`/`modifySection` 文件 I/O。

### 涉及文件
- 新建: `src/services/config-pg.ts`

### 执行步骤

#### 3.1 Provider 操作函数
- `listProviders(userId)`: 查询 `provider` 表，LEFT JOIN `model` 表聚合 `modelCount`
- `getProvider(userId, name)`: 单行查询 + 关联 models
- `upsertProvider(userId, name, data)`: INSERT ON CONFLICT UPDATE
  - 将 `data.options.apiKey` 写入 `apiKey` 字段
  - 将 `data.options.baseURL` 写入 `baseUrl` 字段
  - 将 `data.options` 中剩余字段写入 `extraOptions` JSONB
- `deleteProvider(userId, name)`: DELETE CASCADE 自动删除关联 models

#### 3.2 Model 操作函数
- `addModel(providerId, data)`: INSERT INTO model
- `updateModel(providerId, modelId, data)`: UPDATE model WHERE provider_id AND model_id
- `removeModel(providerId, modelId)`: DELETE FROM model

#### 3.3 Agent Config 操作函数
- `listAgentConfigs(userId)`: 查询 `agent_config` 表所有行
- `getAgentConfig(userId, name)`: 单行查询
- `createAgentConfig(userId, name, data)`: INSERT，白名单字段过滤
- `updateAgentConfig(userId, name, data)`: UPDATE，白名单字段过滤（与当前 `AGENT_SETTABLE_FIELDS` 一致）
- `deleteAgentConfig(userId, name)`: DELETE，内置 agent 在路由层拦截而非此层

#### 3.4 MCP Server 操作函数
- `listMcpServers(userId)`: 查询 `mcp_server` 表
- `getMcpServer(userId, name)`: 单行查询
- `createMcpServer(userId, name, type, config)`: INSERT
- `updateMcpServer(userId, name, config)`: UPDATE
- `deleteMcpServer(userId, name)`: DELETE（同时清理 mcp_tool 缓存）
- `setMcpServerEnabled(userId, name, enabled)`: UPDATE enabled 字段

#### 3.5 Skill 操作函数
- `listSkills(userId)`: WHERE environment_id IS NULL (全局技能)
- `listWorkspaceSkills(userId, environmentId)`: WHERE environment_id = ?
- `getSkill(userId, name, environmentId?)`: 单行查询
- `upsertSkill(userId, name, data)`: INSERT ON CONFLICT UPDATE，同时写 SKILL.md 到 `content_path`
- `deleteSkill(userId, name, environmentId?)`: DELETE + 删除文件
- `enableSkill(userId, name)` / `disableSkill(userId, name)`: UPDATE enabled 字段

#### 3.6 UserConfig 操作函数
- `getUserConfig(userId)`: 查询 `user_config` 表，不存在返回默认值
- `setUserConfig(userId, patch)`: INSERT ON CONFLICT UPDATE，支持 `defaultAgent`/`currentModel`/`smallModel`/`permission` 字段

### 设计要点
- 所有函数第一个参数为 `userId`（string），确保多租户隔离
- Provider 的 `apiKey` 字段保留 `{env:XXX}` 引用模式，不做解密
- MCP 的 `config` 使用 JSONB 存储完整配置（local/remote 结构差异大）
- 内置 Agent（build/plan/general 等）保护在路由层实现，服务层不做特殊处理
- 使用 Drizzle ORM 的 query builder（`db.select()`/`db.insert()`/`db.update()`/`db.delete()`）

### 验收
- `bun run typecheck` 无错误
- 所有函数导出且类型签名正确

---

## Task 4: 改造 skill.ts 元数据管理

### 目标
将 `src/services/skill.ts` 中元数据读写从文件系统切换到 PG（通过 config-pg.ts），Markdown 内容仍读写文件系统。

### 涉及文件
- 修改: `src/services/skill.ts`

### 执行步骤

#### 4.1 改造 listSkills / getSkill
- `listSkills()`: 改为调用 `configPg.listSkills(userId)` 获取元数据，返回 `SkillInfo[]`
- 签名变更: `listSkills()` -> `listSkills(userId: string)`，需要 userId 参数
- `getSkill(name)`: 改为调用 `configPg.getSkill(userId, name)` 获取元数据，然后从 `contentPath` 读取 Markdown 内容

#### 4.2 改造 setSkill / deleteSkill
- `setSkill(name, data)`: 先写 SKILL.md 到文件系统（`~/.agents/skills/name/SKILL.md`），再调用 `configPg.upsertSkill(userId, name, { description, contentPath, metadata })`
- `deleteSkill(name)`: 先删除文件目录，再调用 `configPg.deleteSkill(userId, name)`

#### 4.3 改造 enableSkill / disableSkill
- 不再移动文件夹（skills/ -> _disabled/），改为调用 `configPg.enableSkill(userId, name)` / `configPg.disableSkill(userId, name)` 更新 enabled 字段

#### 4.4 改造 importSkillDirectories
- 导入时：写文件到 skills 目录 + 调用 `configPg.upsertSkill()` 入库
- 冲突检测改为查询 PG 而非检查文件系统

#### 4.5 Workspace Skill 函数
- `listWorkspaceSkills(workspacePath)` -> `listWorkspaceSkills(userId, environmentId)`
- `getWorkspaceSkill` / `setWorkspaceSkill` / `deleteWorkspaceSkill` 同理增加 userId 参数
- `listSkillSources(userId)`: 全局技能从 PG 读取，workspace 技能也从 PG 读取

#### 4.6 保留不动的功能
- `parseFrontmatter()` / `buildSkillMd()`: 纯工具函数，不变
- `migrateSkillsDir()`: 旧迁移逻辑保留（不影响 PG）

### 验收
- `bun run typecheck` 无错误
- Skill 的创建/读取/更新/删除通过 PG 管理元数据，Markdown 内容读写文件系统

---

## Task 5: 改造 providers 路由

### 目标
将 `src/routes/web/config/providers.ts` 中的 `getSection`/`modifySection` 调用替换为 `config-pg.ts` 的结构化函数。

### 涉及文件
- 修改: `src/routes/web/config/providers.ts`

### 执行步骤

#### 5.1 替换 import
- 移除: `import { getSection, modifySection } from "../../../services/config";`
- 新增: `import * as configPg from "../../../services/config-pg";`

#### 5.2 改造 handleList
- 当前: `getSection<Record<string, ProviderConfig>>("provider")` -> 遍历 Object.entries
- 新增: `configPg.listProviders(userId)` -> 直接返回列表
- `userId` 从 `store.user.id` 获取（在路由 handler 解构 `{ store }` 中已有）

#### 5.3 改造 handleGet
- 当前: `getSection` + 查找 `provider[name]` + 遍历 models
- 新增: `configPg.getProvider(userId, name)` -> 返回 provider 及其 models

#### 5.4 改造 handleSet
- 当前: `modifySection` 合并 JSON 对象
- 新增: `configPg.upsertProvider(userId, name, data)` -> 分解 apiKey/baseURL/extraOptions

#### 5.5 改造 handleDelete
- 当前: `modifySection` 删除 key
- 新增: `configPg.deleteProvider(userId, name)`

#### 5.6 改造 handleAddModel / handleUpdateModel / handleRemoveModel
- 当前: 嵌套在 `modifySection("provider")` 中操作 `cfg.models` 子对象
- 新增:
  - `handleAddModel`: 先 `getProvider` 获取 providerId，再 `configPg.addModel(providerId, data)`
  - `handleUpdateModel`: `configPg.updateModel(providerId, modelId, data)`
  - `handleRemoveModel`: `configPg.removeModel(providerId, modelId)`

#### 5.7 handleTest 不变
- Test 逻辑直接使用 provider 配置数据调用外部 API，不涉及存储层
- 需要改为从 PG 读取 provider 配置（通过 `configPg.getProvider`）

### API 兼容性
- 所有 action（list/get/set/test/delete/add_model/update_model/remove_model）的入参和出参格式保持不变
- 前端无需改动

### 验收
- `bun run typecheck` 无错误
- `grep "getSection\|modifySection" src/routes/web/config/providers.ts` 无输出

---

## Task 6: 改造 models 路由

### 目标
将 `src/routes/web/config/models.ts` 中的 `getConfig`/`setTopLevelField` 调用替换为 `config-pg.ts` 的 `getUserConfig`/`setUserConfig` + `listProviders`。

### 涉及文件
- 修改: `src/routes/web/config/models.ts`

### 执行步骤

#### 6.1 替换 import
- 移除: `import { getConfig, setTopLevelField } from "../../../services/config";`
- 新增: `import * as configPg from "../../../services/config-pg";`

#### 6.2 改造 buildAvailableList
- 当前: `getConfig()` 读取整个 JSON，遍历 `config.provider` 下所有 provider 的 models
- 新增: `configPg.listProviders(userId)` 获取所有 providers，每个 provider 关联 models
- `userId` 参数从路由 handler 传入

#### 6.3 改造 handleGet
- 当前: `getConfig()` 读取 `config.model`/`config.small_model`/`config.permission`
- 新增: `configPg.getUserConfig(userId)` 返回 `currentModel`/`smallModel`/`permission`
- 字段映射: `model` -> `currentModel`, `small_model` -> `smallModel`

#### 6.4 改造 handleSet
- 当前: 三次 `setTopLevelField` 分别写入 `model`/`small_model`/`permission`
- 新增: `configPg.setUserConfig(userId, { currentModel, smallModel, permission })` 一次调用
- 字段映射: `data.model` -> `currentModel`, `data.small_model` -> `smallModel`

#### 6.5 保留缓存机制
- `cachedAvailable` 缓存继续保留，TTL 5 分钟
- `invalidateAvailableCache()` 继续在 provider/model 变更时调用

### API 兼容性
- `get` action 返回格式保持 `{ current: { model, small_model, permission }, available: [...] }`
- `set` action 入参 `{ model, small_model, permission }` 保持不变

### 验收
- `bun run typecheck` 无错误
- `grep "getConfig\|setTopLevelField" src/routes/web/config/models.ts` 无输出

---

## Task 7: 改造 agents 路由

### 目标
将 `src/routes/web/config/agents.ts` 中的 `getSection`/`modifySection`/`getConfig`/`setTopLevelField` 调用替换为 `config-pg.ts` 的结构化函数。

### 涉及文件
- 修改: `src/routes/web/config/agents.ts`

### 执行步骤

#### 7.1 替换 import
- 移除: `import { getSection, setTopLevelField, getConfig, modifySection } from "../../../services/config";`
- 新增: `import * as configPg from "../../../services/config-pg";`

#### 7.2 改造 handleList
- 当前: `getSection("agent")` + `getConfig()` 读取 default_agent
- 新增: `configPg.listAgentConfigs(userId)` + `configPg.getUserConfig(userId)` 获取 default_agent
- 知识库绑定查询 `listAgentKnowledgeBindings` 不变

#### 7.3 改造 handleGet
- 当前: `getSection("agent")` 查找 `agents[name]`
- 新增: `configPg.getAgentConfig(userId, name)`
- `tools -> permission` 兼容转换逻辑保留在路由层

#### 7.4 改造 handleSet
- 当前: `modifySection("agent")` 合并字段
- 新增: `configPg.updateAgentConfig(userId, name, filtered)`
- 白名单过滤 (`AGENT_SETTABLE_FIELDS`) 保留在路由层

#### 7.5 改造 handleCreate
- 当前: `modifySection("agent")` 添加新 key
- 新增: `configPg.createAgentConfig(userId, name, filtered)`

#### 7.6 改造 handleDelete
- 当前: `modifySection("agent")` 删除 key
- 新增: `configPg.deleteAgentConfig(userId, name)`
- 内置 Agent 保护（`BUILT_IN_AGENTS` 检查）保留在路由层

#### 7.7 改造 handleSetDefault
- 当前: `setTopLevelField("default_agent", name)`
- 新增: `configPg.setUserConfig(userId, { defaultAgent: name })`

#### 7.8 知识库绑定
- `syncAgentKnowledgeBindings(userId, name, knowledge)` 不变（已经是 PG 操作）
- 调用时机不变（在 create/set agent 后同步）

### API 兼容性
- 所有 action 的入参和出参格式保持不变
- `default_agent` 在 list/set_default 中保持原名

### 验收
- `bun run typecheck` 无错误
- `grep "getSection\|modifySection\|getConfig\|setTopLevelField" src/routes/web/config/agents.ts` 无输出

---

## Task 8: 改造 mcp 路由

### 目标
将 `src/routes/web/config/mcp.ts` 中的 `getSection`/`modifySection` 调用替换为 `config-pg.ts` 的 MCP 函数。

### 涉及文件
- 修改: `src/routes/web/config/mcp.ts`

### 执行步骤

#### 8.1 替换 import
- 移除: `import { getSection, modifySection } from "../../../services/config";`
- 新增: `import * as configPg from "../../../services/config-pg";`

#### 8.2 改造 handleList
- 当前: `getSection<McpRecord>("mcp")` 遍历 Object.entries
- 新增: `configPg.listMcpServers(userId)` 返回列表
- `toolsCount` 聚合保持从 `mcpTool` 表查询

#### 8.3 改造 handleGet
- 当前: `getSection<McpRecord>("mcp")` 查找 `mcp[name]`
- 新增: `configPg.getMcpServer(userId, name)` 返回 `{ name, type, config }`

#### 8.4 改造 handleCreate / handleUpdate
- 当前: `modifySection("mcp")` 添加/替换 key
- 新增:
  - `handleCreate`: `configPg.createMcpServer(userId, name, type, config)`
  - `handleUpdate`: `configPg.updateMcpServer(userId, name, config)`

#### 8.5 改造 handleDelete
- 当前: `modifySection("mcp")` 删除 key + 清理 mcp_tool 缓存
- 新增: `configPg.deleteMcpServer(userId, name)` + 清理 mcp_tool 缓存（保留现有 db.delete 逻辑）

#### 8.6 改造 handleEnable / handleDisable
- 当前: `modifySection("mcp")` 修改 `enabled` 字段
- 新增: `configPg.setMcpServerEnabled(userId, name, true/false)`

#### 8.7 handleTest / handleTestUrl / handleInspect / handleListTools
- 这些函数主要操作外部 API 或 mcpTool 表，不涉及 opencode.json
- `handleTest` / `handleInspect` 中的 `getSection` 改为 `configPg.getMcpServer(userId, name)`
- `handleTestUrl` / `handleListTools` 不变

### API 兼容性
- 所有 action 的入参和出参格式保持不变
- MCP `config` JSONB 存储完整配置，前端提交的 `{ type, command/url, ... }` 直接存入

### 验收
- `bun run typecheck` 无错误
- `grep "getSection\|modifySection" src/routes/web/config/mcp.ts` 无输出

---

## Task 9: 改造 skills 路由

### 目标
将 `src/routes/web/config/skills.ts` 中的 skill service 调用适配新的 `config-pg.ts` 接口。

### 涉及文件
- 修改: `src/routes/web/config/skills.ts`

### 执行步骤

#### 9.1 传入 userId 参数
- skill service 函数现在需要 `userId` 参数
- 从 `{ store }` 中解构 `user.id` 传入

#### 9.2 改造 handleList / handleWorkspaceList
- `handleList`: `listSkills(userId)`（全局技能）
- `handleWorkspaceList`: `listSkillSources(userId)`（所有来源）

#### 9.3 改造 handleGet / handleSet / handleDelete
- 增加 `userId` 参数传递
- workspace 技能操作增加 `environmentId` 参数

#### 9.4 改造 handleEnable / handleDisable
- 调用 `enableSkill(userId, name)` / `disableSkill(userId, name)`（PG 更新，不再移动文件夹）

#### 9.5 改造 handleUpload
- `importSkillDirectories(userId, files, strategy)`: 传入 userId
- workspace 上传同理

### API 兼容性
- 所有 action 的入参和出参格式保持不变
- `enable`/`disable` 不再返回 404 "not found in disabled/enabled directory"，而是 "not found"

### 验收
- `bun run typecheck` 无错误
- 所有 skill action 正常工作

---

## Task 10: 改造 environments 路由中 agent 验证

### 目标
将 `src/routes/web/environments.ts` 中两处 `getSection("agent")` 调用替换为 PG 查询。

### 涉及文件
- 修改: `src/routes/web/environments.ts`

### 执行步骤

#### 10.1 替换 import
- 移除: `import { getSection } from "../../services/config";`
- 新增: `import * as configPg from "../../services/config-pg";`

#### 10.2 改造 agent 验证（创建环境时）
- 当前: `(await getSection<Record<string, unknown>>("agent")) ?? {}; if (!(agentName in agents))`
- 新增: `const agent = await configPg.getAgentConfig(userId, agentName); if (!agent)`

#### 10.3 改造 agent 验证（更新环境时）
- 同上逻辑

### 验收
- `grep "getSection" src/routes/web/environments.ts` 无输出
- 创建/更新环境时 agent 名称验证正常工作

---

## Task 11: 清理 config.ts 文件 I/O 代码

### 目标
保留 workspace 配置注入功能（instance.ts 中写 `.opencode/config.json`），移除 `config.ts` 中不再使用的全局 `getSection`/`modifySection`/`setTopLevelField`/`getConfig` 代码。

### 涉及文件
- 修改: `src/services/config.ts`

### 执行步骤

#### 11.1 确认 workspace 注入不受影响
- `instance.ts` 和 `agent-task-runner.ts` 直接写 workspace 目录下的 `.opencode/config.json`，不通过 `config.ts` 的全局配置接口

#### 11.2 清理全局配置函数
- 移除 `getConfig()`, `getSection()`, `setSection()`, `replaceSection()`, `modifySection()`, `deleteSection()`, `setTopLevelField()` 函数
- 移除 `CONFIG_PATH` 常量和 `writeLock` 互斥锁
- 保留文件为空壳或完全删除（取决于是否有其他引用）

#### 11.3 确认无引用
- `grep -rn "from.*services/config" src/ --include="*.ts" | grep -v __tests__` 无输出

### 验收
- `grep -rn "from.*services/config" src/ --include="*.ts" | grep -v __tests__` 无输出
- `bun run typecheck` 无错误

---

## Task 12: 测试适配

### 目标
更新所有引用了 `services/config` 的测试文件，改为使用 `config-pg` 的 mock。

### 涉及文件
- 修改: `src/__tests__/` 下所有包含 `services/config` mock 的测试文件

### 执行步骤

#### 12.1 查找所有需要修改的测试文件
- `grep -rn "from.*services/config\|mock.*services/config" src/__tests__/` 列出所有引用

#### 12.2 更新 mock 策略
- 当前测试 mock `services/config` 为内存对象
- 新测试 mock `services/config-pg` 为内存 Map 实现

#### 12.3 逐文件适配
- 将 `mock.module("../services/config", ...)` 替换为 `mock.module("../services/config-pg", ...)`
- mock 实现从返回 JSON section 改为调用具体的 CRUD 函数

### 验收
- `bun test src/__tests__/` 全部通过
- 无残留的 `mock.module("../services/config", ...)` 调用

---

## Task 13: 集成验证与 typecheck

### 目标
端到端验证所有改造完成后的系统状态。

### 执行步骤

#### 13.1 TypeScript 类型检查
- `bun run typecheck` 零错误

#### 13.2 全量测试
- `bun test src/__tests__/` 全部通过

#### 13.3 残留检查
- `grep -rn "getSection\|modifySection\|setTopLevelField\|getConfig" src/ --include="*.ts" | grep -v __tests__`
  - 预期: 无输出

#### 13.4 功能验证
- 服务器启动后，前端配置页面（providers/models/agents/mcp/skills）可正常使用
- Provider CRUD 正常
- Model CRUD 正常（在 provider 下）
- Agent CRUD 正常（含知识库绑定）
- MCP Server CRUD 正常（含 inspect/tools）
- Skill CRUD 正常（含 upload）
- Model 选择/切换正常
- 环境创建时 agent 验证正常

### 验收
- 全部通过 `spec-design.md` 中的验收标准

---

## 关键设计决策

### 为什么不在 config.ts 保留全局文件 I/O
旧 `opencode.json` 是所有用户共享的单一文件。PG 迁移后，每个用户有独立的数据行。config.ts 的文件互斥锁不再需要，PG 的行级锁天然保证并发安全。

### 为什么 skill.content_path 保留文件系统
Skill 的 Markdown 内容可能包含大段文本、代码示例、多文件附件。将这些存入 JSONB 会增加 PG 存储压力且不利于文件系统的 SKILL.md 编辑工作流。元数据（名称、描述、启用状态、自定义字段）入库即可满足查询和管理需求。

### 为什么 MCP config 使用 JSONB 而非关系表
local 和 remote 两种 MCP 服务器结构差异大（command 数组 vs url 字符串，environment vs headers）。强行拆分为关系表会增加 JOIN 复杂度且无查询收益。JSONB 兼顾灵活性和查询能力。

### 为什么不迁移旧数据
旧 `opencode.json` 中的数据是单用户全局配置。迁移到 PG 后需要 user_id 关联，而旧数据没有用户概念。强制导入会产生歧义。从空库开始是最干净的方案。

---

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 前端依赖 opencode.json 的特定 JSON 结构 | API 返回格式不匹配 | 每个 route handler 保持响应格式不变，仅替换数据源 |
| skill.ts 签名变更影响其他调用方 | 编译错误 | `listSkills()` 增加 userId 参数后，追踪所有调用点更新 |
| 并发写入 PG 时死锁 | 写入失败 | Drizzle ORM 使用参数化查询 + PG 行级锁，风险极低 |
| 测试 mock 链条过长 | 测试脆弱 | 考虑对 config-pg.ts 使用集成测试（真实 PG）而非纯 mock |
