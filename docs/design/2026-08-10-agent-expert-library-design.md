# 设计：专家库（agent_expert）与多模型运行时切换

> 来源：需求评审（2026-08-10，多 agent / 多模型支持） | 日期：2026-08-10 | 状态：draft（设计已冻结，待实现）

## Problem Statement

平台需要支持"多 agent 与多模型"能力，需求拆解为三块：

1. **多 agent（subagent）**：主 agent 可引用多个 subagent。subagent 的定义需要结构化存储——即 `.agents/agents/*.md` 模板文件的 JSON 化存储，而不是散落文件；AgentConfig 通过引用关系挂载 subagent。
2. **多模型**：系统已支持多 provider / 多模型配置；新增需求是 **运行时切换模型**（同一会话内用户可切换模型，后续轮次生效）与 **agent 锁定默认模型**（模板声明默认模型，创建后用户可改）。
3. **构建下发**：machine 构建时，DB 中的 subagent 定义需渲染为 md 文件下发到工作区，供引擎消费。

## 现状盘点

| 能力 | 现状 | 差距 |
|---|---|---|
| Agent 模板 | `.agents/agents/*.md` 全局静态目录，`loadAgentTemplates()` 进程级缓存读取，仅服务端消费（前端创建 agent 起点）；frontmatter 支持 name/description/skills | 无 model 字段；无结构化存储 |
| 多模型配置 | `provider` + `model` 两张表完备（协议/baseUrl/key/模态/限流/成本），按组织隔离 | 无运行时切换通道的权限注入 |
| agent 锁定模型 | `agent_config.modelId` 外键已有，`resolveModelConfig` 运行时解析，未配置 fallback 组织首个可用模型 | 仅单模型，无预选列表 |
| subagent 语义 | `agent_config` 有 mode/steps/temperature/permission 字段（仅校验，无运行时逻辑） | 无引用关系存储 |
| 构建下发 | `AgentLaunchSpec`（agent/model/skills/mcpServers）→ engine 插件 `prepareWorkspace` 落盘 CLAUDE.md / skills / .mcp.json | 无 subagent 渲染 |
| 运行时切换模型 | **通道已完备**：`set_session_model`（proxy）→ `session/setModel`（ACP）→ `setSessionConfigOption({configId:"model"})` → 引擎；`model_changed` 回传；chat-channel 将 modelState 投影进 Y.Doc，前端已读 `availableModels/currentModelId` 展示 | 缺切换 UI、服务端校验、预选列表注入 |

## 领域术语

| 术语 | 定义 |
|---|---|
| **专家（agent_expert）** | agent.md 的 JSON 化存储。一条记录 = 一个 `.agents/agents/*.md` 文件的等价物（frontmatter 字段 + 正文），是 subagent 定义的唯一真相 |
| **专家库** | `agent_expert` 表的集合：系统内置专家 + 组织自建专家 |
| **内置专家** | 由 `.agents/agents/*.md` 启动同步而来，`organizationId="system"`，所有组织只读 |
| **主 Agent** | AgentConfig，用户直接对话的 agent；通过中间表引用专家为 subagent |
| **默认模型** | expert 上配置的业务标识模型（`providerName/modelId`），渲染进 subagent 的 frontmatter |

## 目标设计

### 1. 数据模型

#### 1.1 `agent_expert` 表（专家库）

```ts
export const agentExpert = pgTable("agent_expert", {
  id: uuid("id").primaryKey().defaultRandom(),
  // 组织隔离；系统内置专家使用保留值 "system"（决策 D1）
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }), // 创建者，内置为 null
  name: varchar("name").notNull(),          // 与 md 文件名对应，(organizationId, name) 唯一
  description: text("description"),
  prompt: text("prompt").notNull(),         // md 正文
  skills: jsonb("skills"),                  // string[]，skill 名称（与 frontmatter skills 同构）
  model: varchar("model"),                  // 业务标识 providerName/modelId（默认模型，可选）
  mode: varchar("mode").notNull().default("subagent"), // primary | subagent | all
  temperature: doublePrecision("temperature"),
  steps: integer("steps"),
  permission: jsonb("permission"),          // ask/allow/deny 规则（预留）
  builtin: boolean("builtin").notNull().default(false), // 是否系统内置
  disabled: boolean("disabled").notNull().default(false), // 软删除（仅内置专家使用，决策 D3）
  extra: jsonb("extra"),                    // 预留可变扩展
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgNameIdx: uniqueIndex("idx_agent_expert_org_name").on(table.organizationId, table.name),
}));
```

- 字段集合与 `.agents/agents/*.md` frontmatter 一一对应（name/description/skills/model/mode/temperature/steps/permission），JSON 化存储即模板文件的数据化。
- `skills` 存名称而非 skill 表外键：与 md frontmatter 同构（引擎消费名称），构建时再按组织解析为 SkillConfig。

#### 1.2 `agent_config_expert` 中间表（引用关系）

```ts
export const agentConfigExpert = pgTable("agent_config_expert", {
  agentConfigId: uuid("agent_config_id").notNull().references(() => agentConfig.id, { onDelete: "cascade" }),
  expertId: uuid("expert_id").notNull().references(() => agentExpert.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: uniqueIndex("idx_agent_config_expert_pk").on(table.agentConfigId, table.expertId),
  agentConfigIdx: index("idx_agent_config_expert_agent_config").on(table.agentConfigId),
  expertIdx: index("idx_agent_config_expert_expert").on(table.expertId),
}));
```

- 与 `agentConfigSkill` / `agentConfigMcp` / `agentConfigSiteApp` 中间表模式一致：一个主 Agent 引用多个专家；一个专家可被多个主 Agent 引用（共享）；级联删除双向生效。
- 选用中间表而非 `agent_config.expert_ids uuid[]` 数组字段的原因：PG 不支持数组列上的外键约束（`REFERENCES` 仅接受标量列），数组方案将失去 DB 级引用完整性（无级联删除、删除专家需应用层扫表清理、并发整表覆盖有丢失更新风险）。中间表由 DB 兜底完整性，且与既有三种绑定模式一致。数组方案作为备选记录于此，暂不采用。

#### 1.3 与既有字段的关系

- `agent_config.mode` / `steps` / `temperature` / `permission` 是 subagent 语义的旧承载字段：**保留兼容存量数据，不迁移**（决策 D5），新能力一律走专家库；这些字段在 AgentConfig 上降级为"历史兼容，不再承载 subagent 语义"，代码注释标注。
- `agent_config.modelIds`（预选模型，见第 5 节）为后续新增字段，主 agent 运行时切换使用。

### 2. 内置模板 ↔ 专家库同步

`.agents/agents/*.md` 作为内置专家的**种子数据源**，仅启动时同步（决策 D2）+ `refresh` action 手动触发，不做热监听：

```
文件存在且行不存在      → insert（builtin=true, organizationId="system", enabled）
文件存在且行存在        → upsert 内容 + disabled 置回 false（幂等）
文件不存在且行 enabled  → 标记 disabled（软删除，不物理删除，决策 D3）
文件不存在且行 disabled → 不动
```

- 同步幂等，失败仅告警不影响服务启动。
- **恢复路径**：源文件重新出现后同步自动置回 enabled；文件未恢复但用户想继续使用 → 前端提供"复制到本组织"动作，转为组织自建专家（可编辑），与内置行解耦。
- 内置专家（system 行）对所有组织只读：列表查询恒为 `IN ('system', ?org)`，默认隐藏 disabled；写接口对 system 行拒绝。

### 3. API 设计

沿用 `POST /web/config/:module` action 风格（与 config.schema 一致）：

```
POST /web/config/agent-expert
  action: list            → 内置 + 本组织专家列表（默认排除 disabled，支持含 disabled 查询）
  action: create          → 创建专家（name/description/prompt/skills/model/mode/temperature/steps）
  action: update          → 更新专家（system 行拒绝）
  action: delete          → 软删除专家（内置专家标记 disabled；组织自建物理删除）
  action: refresh         → 手动触发内置模板同步
  action: duplicate       → 复制专家到本组织（内置专家恢复路径）

POST /web/config/agents（既有接口扩展）
  create/update body 增加 expertIds: string[]   → 引用专家为 subagent
  agent 详情响应增加 subagents: 专家摘要列表
```

- 引用校验：expert 必须可见（内置或本组织）且未 disabled。

### 4. 构建下发（渲染 md）

```
buildLaunchSpec
  ├─ 主 agent = AgentConfig（现有逻辑不动：model 解析、CLAUDE.md 照旧）
  └─ 新增：查 agent_config_expert → agent_expert 行
       ├─ 校验可见性（内置/本组织）、跳过 disabled
       ├─ skills 名称 → 组织内解析为 SkillConfig[] 合并下发安装
       └─ 渲染 AgentFileSpec[]（name/description/prompt/skills/model/mode/temperature/steps）
           → AgentLaunchSpec.subagents
engine prepareWorkspace
  ├─ opencode      → .agents/agents/{name}.md
  ├─ ccb/claude-code → .claude/agents/{name}.md
  └─ 主 agent 不渲染（维持 CLAUDE.md，无变化）
```

- `AgentFileSpec` 与内置模板解析器共用字段契约（`agent_expert ↔ AgentFileSpec`），防止格式漂移。
- 对缺失/不可见/disabled 的专家引用直接失败（与现有 `throwInvalidConfig` 风格一致），不做半成品静默。

### 5. 运行时切换模型（同会话）

链路已存在（`set_session_model` → `session/setModel` → `setSessionConfigOption(configId:"model")` → 引擎；`model_changed` 回传 → chat-channel 投影 modelState → Y.Doc → 前端），补齐三块：

1. **预选模型注入（服务端权威）**：`agent_config` 新增 `model_ids uuid[]` 预选列表，规则：
   - `modelIds` 非空时默认 `modelId` 必须 ∈ `modelIds`；设置 `modelIds` 时默认模型不在其中 → 报错（不隐式改默认）；空数组 = 单模型 agent。
   - session/new、load、resume 时用 DB 预选列表**覆盖引擎自报的 availableModels**（value=引擎标识 `model.modelId`，name=displayName），currentModelId=默认模型 → 引擎与前端天然只见预选范围。
2. **切换拦截校验**：relay/chat-channel 拦截 `set_session_model`，引擎标识解析回 UUID 校验 ∈ 预选列表，否则拒绝并回错误事件（保守拒绝）。
3. **前端**：ChatPanel 模型下拉（读 Y.Doc modelState，发 `set_session_model`，监听 model_changed 回显）；AgentFormDialog 预选模型多选 + 默认单选（默认必须 ∈ 预选）。

### 6. 多租户 / 并发 / 失败路径

- 内置专家（system）全局只读；组织自建专家按 organizationId 隔离；跨组织共享本期不做，将来复用 `resourcePermission` 机制（resourceType 枚举扩展 `"agent_expert"`），不提前建表（决策 D4）。
- 模型被删除后 `model_ids` 残留引用：launch 时过滤失效项 + 告警日志（不阻塞启动）。
- 切换模型并发：多标签页共享 relay handle，`set_session_model` 按 acpSessionId 路由（现有机制已隔离）。
- 内置模板 model 业务标识解析失败：创建 agent 时明确报错，不静默 fallback。

### 7. 验证

1. 迁移：`agent_expert` 表 + `agent_config_expert` 中间表 + `agent_config.model_ids` 列（`db:generate` → 审查 → `db:migrate`）。
2. 后端测试：
   - 内置同步幂等（含文件删除 → disabled、恢复 → enabled）
   - 专家 CRUD 与 system 行只读拒绝
   - 引用 CRUD、级联删除、跨组织/disabled 引用拒绝
   - 构建下发渲染 golden 对比（opencode 与 ccb 两路径）
   - `set_session_model` 拦截校验（预选外拒绝）
3. 前端：`build:web` + 关键交互测试（模型切换、专家绑定）。
4. 全量 `bun run precheck`。

## 决策记录

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D1 | 内置专家归属 | `organizationId="system"` 保留字，查询恒为 `IN ('system', ?org)` | 无 nullable、无特殊分支；system 行只读，索引查询简单 |
| D2 | 内置同步时机 | 仅启动时幂等同步 + `refresh` action | 模板文件低频变更；失败仅告警不影响启动 |
| D3 | 模板文件删除 | 软删除：标记 disabled，不物理删除；源文件恢复后自动 enabled；"复制到本组织"为恢复路径 | 避免误删文件连带专家消失；保留审计与恢复能力 |
| D4 | 跨组织专家共享 | 本期不做；`resourcePermission` 机制预留 | 避免提前建表；需求未出现 |
| D5 | 存量 mode=subagent 的 AgentConfig | 保留兼容不迁移 | 该字段无运行时语义，迁移有 skills/mcp 映射数据损失风险 |

## 实现拆分（垂直切片）

| 阶段 | 内容 | 验证 |
|---|---|---|
| 1. 数据层 | 迁移（agent_expert + agent_config_expert + model_ids 列）、repository CRUD、同步编排 | db:generate/migrate + 单元测试 |
| 2. 专家 API | action 风格 CRUD、refresh/duplicate、system 行保护 | 后端测试 |
| 3. 构建下发 | AgentFileSpec、buildLaunchSpec 加载 subagents、md 渲染器、两引擎落盘 | golden 测试 |
| 4. 模型切换 | model_ids 校验、预选列表注入、切换拦截校验、chat-channel 接线 | 后端测试 |
| 5. 前端 | AgentFormDialog 专家绑定 + 模型多选、ChatPanel 模型下拉、i18n | build:web + 交互测试 |

每阶段独立可测、可回滚。

## 开放项

- 跨组织专家共享（D4 预留，resourcePermission 扩展）。
- `agent_config.mode` 等历史字段的最终移除时机（当前无消费方，等专家库路径稳定后评估）。
