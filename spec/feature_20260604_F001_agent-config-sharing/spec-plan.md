# agent-config-sharing 执行计划

**目标:** 为 `agent_config` 接入与 `provider` / `skill` / `mcp_server` 一致的跨 team 只读公开能力，并打通共享 Agent 的 Environment 绑定与运行时依赖解析链路。

**技术栈:** Bun + Elysia + Drizzle ORM + PostgreSQL + React 19 + TanStack Router + Bun test

**设计文档:** `spec/feature_20260604_F001_agent-config-sharing/spec-design.md`

## 改动总览

本次改动会同时落在数据库权限枚举、`src/services/config/agent-config.ts` 读写入口、`src/services/environment-web.ts` 的 Agent 可用性校验、`src/services/config/aggregate.ts` 与 `src/services/instance.ts` 的运行时聚合链路，以及 Agent 面板前端的只读共享交互。
经代码分析确认 `provider` / `skill` / `mcp_server` 已经通过 `resource-permission` service 形成统一模式，而 `agent_config` 仍然只按 `organizationId` 做内部查询；因此本次应扩展现有模式，而不是新增独立权限 API。
Task 1 建立 `agent_config` 的权限基础设施；Task 2 接入 Agent 配置 service 与 `/web/config/agents`；Task 3 改造 Environment 和 LaunchSpec 链路；Task 4 补齐 SDK / 前端只读共享行为；Task 5 做整体验收。
关键设计决策是把“共享 Agent 依赖穿透”限定在 `getAgentFullConfig()` 聚合链路内实现，不给调用方增加底层 `provider` / `skill` / `mcp_server` 的独立读取或管理权限。

---

### Task 0: 环境准备

**背景:**
本需求会同时改动后端 service、Drizzle schema、前端类型和 Agent 面板交互，开始前需要确认 Bun、前后端测试、前端构建都可用。
后续 Task 1 到 Task 4 都依赖这里确认的命令基线，避免在写计划时引用错误的验证入口。

**执行步骤:**
- [x] 验证 Bun 与后端测试工具链可用
  - 位置: 仓库根目录
  - 先执行 `bun --version`，再执行 `bun test src/__tests__/agent-config-validators.test.ts`
  - 原因: 后端所有 schema / service / route 测试都依赖 Bun runtime 与 preload mock 机制
- [x] 验证前端测试与构建工具链可用
  - 位置: 仓库根目录
  - 执行 `bun test web/src/__tests__/config-agents-page.test.ts` 和 `bun run build:web`
  - 原因: Task 4 需要修改 Agent 面板、SDK 类型和页面只读行为，必须确认 Vite 构建链路正常

**检查步骤:**
- [x] 检查 Bun 可执行
  - `bun --version`
  - 预期: 输出 Bun 版本号，无 command not found
- [x] 检查后端测试框架可执行
  - `bun test src/__tests__/agent-config-validators.test.ts`
  - 预期: 测试通过，无 preload 或模块解析错误
- [x] 检查前端构建可执行
  - `bun run build:web`
  - 预期: 构建完成，无 TypeScript 或 Vite error

---

### Task 1: 扩展 `agent_config` 资源权限基础设施

**背景:**
共享 Agent 的前提是 `agent_config` 能进入现有 `resource_permission` 模型；当前 `src/db/schema.ts` 与 `src/repositories/resource-permission.ts` 只支持 `provider` / `skill` / `mcp_server`，Agent 还没有权限枚举入口。
本 Task 输出数据库枚举、repository 类型、config 类型与测试基础，供 Task 2 的 service 和 route 直接复用。
Task 2 以后所有 `resourceAccess` 相关判断都依赖本 Task 的枚举和类型扩展。

**涉及文件:**
- 修改: `src/db/schema.ts`
- 新建: `drizzle/0004_agent_config_resource_permission.sql`
- 新建: `drizzle/meta/0004_snapshot.json`
- 修改: `drizzle/meta/_journal.json`
- 修改: `src/repositories/resource-permission.ts`
- 修改: `src/services/config/types.ts`
- 修改: `src/services/config/index.ts`
- 修改: `src/services/config-pg.ts`
- 修改: `src/test-utils/setup-mocks.ts`
- 修改: `src/test-utils/stubs/config-pg-stub.ts`
- 修改: `src/test-utils/helpers.ts`
- 新建: `src/__tests__/resource-permission-agent-config.test.ts`

**执行步骤:**
- [x] 在资源权限枚举中加入 `agent_config`
  - 位置: `src/db/schema.ts` 顶部 `resourcePermissionTypeEnum` 定义处（~L18）
  - 将枚举数组从 `["provider", "skill", "mcp_server"]` 改成 `["provider", "skill", "mcp_server", "agent_config"]`
  - 执行 `bunx drizzle-kit generate --name agent_config_resource_permission`，提交生成的 `drizzle/0004_agent_config_resource_permission.sql`、`drizzle/meta/0004_snapshot.json` 和更新后的 `drizzle/meta/_journal.json`
  - 原因: `resource_permission` 表的 `resource_type` 必须先接受 `agent_config`，后续 service 才能复用 `setPublicRead()` 与 `canReadResource()`
- [x] 扩展 `resource-permission` 仓储类型联合
  - 位置: `src/repositories/resource-permission.ts` 顶部 `ResourcePermissionType` 定义处（~L5）
  - 将联合类型改为 `"provider" | "skill" | "mcp_server" | "agent_config"`，其余仓储查询逻辑保持不变
  - 原因: 现有 SQL 查询按 `resourceType` 透传，只需扩展类型即可复用
- [x] 在 config 类型中补齐 Agent 共享返回结构
  - 位置: `src/services/config/types.ts` 的 Agent Config 区域（`AgentConfigUpsertData` 之后）
  - 新增 `AgentConfigRowWithAccess`、`AgentConfigDetailWithAccess` 两个类型，至少包含 `id`、`organizationId`、`name`、`model`、`prompt`、`mode`、`permission`、`knowledge`、`machineId`、`resourceAccess`
  - 在 `src/services/config/index.ts` 与 `src/services/config-pg.ts` 追加这些类型导出
  - 原因: Task 2 需要像 provider / skill / mcp 一样为 Agent 列表、详情和环境绑定返回统一的 `resourceAccess`
- [x] 在测试 mock 白名单中注册后续 Agent 权限入口
  - 位置: `src/test-utils/setup-mocks.ts` 的 `CONFIG_PG_KEYS` 数组与 `src/test-utils/stubs/config-pg-stub.ts`
  - 追加 `getAgentConfigByResourceKey`、`getReadableAgentConfigById`、`assertAgentConfigInternalWritable` 三个导出名，并在 stub 类型和 `helpers.ts` 中同步
  - 原因: Task 2 / Task 3 的 route 与 service 测试会通过 `config-pg` 桶文件访问这些新方法，必须先进入统一 stub 注册表
- [x] 为 `agent_config` 资源权限扩展编写单元测试
  - 测试文件: `src/__tests__/resource-permission-agent-config.test.ts`
  - 测试场景:
    - `src/db/schema.ts` 的 `resourcePermissionTypeEnum` 包含 `"agent_config"` → schema 已扩展
    - `drizzle/0004_agent_config_resource_permission.sql` 与 `drizzle/meta/0004_snapshot.json` 包含 `agent_config` enum 变更 → 迁移文件已生成
    - `src/repositories/resource-permission.ts` 的 `ResourcePermissionType` 联合包含 `"agent_config"` → service 可以无分支复用现有仓储
    - `src/test-utils/setup-mocks.ts` 与 `config-pg-stub.ts` 暴露新增 Agent 权限方法 → 后续测试基础齐全
  - 运行命令: `bun test src/__tests__/resource-permission-agent-config.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 schema 与仓储已支持 `agent_config`
  - `rg -n 'agent_config' src/db/schema.ts src/repositories/resource-permission.ts`
  - 预期: 同时命中 enum 定义与 `ResourcePermissionType`
- [x] 检查新的迁移文件已生成
  - `rg -n 'agent_config' drizzle/0004_agent_config_resource_permission.sql drizzle/meta/0004_snapshot.json drizzle/meta/_journal.json`
  - 预期: SQL、snapshot、journal 都包含 `agent_config` 变更记录
- [x] 运行权限扩展测试
  - `bun test src/__tests__/resource-permission-agent-config.test.ts`
  - 预期: 测试通过

---

### Task 2: 接入 Agent 配置 service 与 `/web/config/agents` 共享读写规则

**背景:**
当前 `src/services/config/agent-config.ts` 的 `listAgentConfigs`、`getAgentConfig`、`getAgentConfigById` 只查当前 organization，`src/routes/web/config/agents.ts` 也没有 `resourceAccess`、`publicReadable` 或外部只读限制。
本 Task 负责让 Agent 配置列表/详情与 provider / skill / mcp 共享行为对齐，同时保持写操作只允许 owner team 内部资源。
Task 3 的 Environment 绑定会依赖这里新增的“可读 Agent 解析入口”，Task 4 的前端只读显示也依赖这里新增的返回字段。

**涉及文件:**
- 修改: `src/services/config/agent-config.ts`
- 修改: `src/services/config/index.ts`
- 修改: `src/services/config-pg.ts`
- 修改: `src/routes/web/config/agents.ts`
- 修改: `src/__tests__/services/config-agent-config.test.ts`
- 新建: `src/__tests__/config-agent-resource-access.test.ts`
- 修改: `src/__tests__/config-integration.test.ts`

**执行步骤:**
- [x] 在 `agent-config` service 中补齐外部可读查询入口
  - 位置: `src/services/config/agent-config.ts` 的查询函数区域（`listAgentConfigs()`、`getAgentConfig()`、`getAgentConfigById()` 附近）
  - 参照 `src/services/config/provider.ts` / `skill.ts` / `mcp-server.ts` 的现有模式，新增并导出：
    - `listAgentConfigs(ctx)`：合并内部 Agent 与 `listReadableResourceRefs(ctx, "agent_config")` 对应的外部 Agent，再用 `decorateResourceAccess()` 补 `resourceAccess`
    - `getAgentConfig(ctx, nameOrResourceKey)`：优先内部同名，再支持 `resourceKey` 精确查询，最后在外部公开 Agent 中按同名回退
    - `getAgentConfigByResourceKey(ctx, resourceKey)`：解析 `sourceOrganizationId/resourceUid` 并通过 `canReadResource()` 校验
    - `getReadableAgentConfigById(ctx, id)`：按 id 查询真实 Agent，内部直接返回，外部通过 `canReadResource()` 校验后返回带 `resourceAccess` 的对象
    - `assertAgentConfigInternalWritable(ctx, nameOrResourceKey)`：复用读取入口并调用 `assertInternalWritable()`
  - 原因: Environment 绑定、配置页详情、后续共享启动都需要统一的 Agent 可见性解析入口
- [x] 把 Agent 的公开开关接入原 `set/create` 写链路
  - 位置: `src/services/config/agent-config.ts` 的 `createAgentConfig()` / `updateAgentConfig()`，以及 `src/routes/web/config/agents.ts` 的 `handleSet()` / `handleCreate()`
  - 调整 service 签名为 `createAgentConfig(ctx, name, data, options?)`、`updateAgentConfig(ctx, nameOrResourceKey, data, options?)`
  - 在内部写成功后调用 `setPublicRead(ctx, "agent_config", ctx.organizationId, row.id, options.publicReadable)`；route 层从 `data.publicReadable` 拆出布尔值，不写进 Agent JSON 字段白名单
  - 原因: 设计要求继续使用原 `/web/config/agents` 接口切换公开状态，不新增独立权限 API
- [x] 在 Agent route 中统一补充 `resourceAccess` 并限制外部只读
  - 位置: `src/routes/web/config/agents.ts` 的 `handleList()`、`handleGet()`、`handleSet()`、`handleCreate()`、`handleDelete()`、`handleSetDefault()`
  - 具体修改:
    - `handleList()` 返回每个 Agent 的 `id`、`skillIds`、`knowledgeBaseCount`、`resourceAccess`
    - `handleGet()` 返回 `resourceAccess`、`machineId`、`skillIds`、`knowledge`，并保留 `permission` 兼容逻辑
    - `handleSet()` 与 `handleDelete()` 在读取后统一走 `assertAgentConfigInternalWritable()`，外部 Agent 命中时直接返回 403
    - `handleSetDefault()` 改为调用 `getAgentConfig(ctx, name)` 后保存 `defaultAgent`，允许把外部公开 Agent 设为默认值
    - `handleSet()` 在执行 `syncAgentKnowledgeBindingsById()` 与 `syncAgentSkills()` 之前，依赖 writable 校验结果，确保外部 Agent 无法修改绑定关系
  - 原因: 共享 Agent 必须“可读/可用但不可改”，且详情页要能识别来源团队和公开状态
- [x] 为 Agent 共享 service 与 route 编写单元测试
  - 测试文件: `src/__tests__/config-agent-resource-access.test.ts`
  - 测试场景:
    - `listAgentConfigs(ctx)` 同时返回内部与外部公开 Agent，外部项 `resourceAccess.ownership === "external"`，内部项保留 `publicReadable`
    - `getAgentConfigByResourceKey(ctx, "org_source/agc_external")` 可读时返回详情，不可读时返回 `null`
    - `assertAgentConfigInternalWritable(ctx, "org_source/agc_external")` 对外部 Agent 抛 403
    - `createAgentConfig(..., { publicReadable: true })` / `updateAgentConfig(..., { publicReadable: false })` 会透传到 `setPublicRead()`
  - 运行命令: `bun test src/__tests__/config-agent-resource-access.test.ts`
  - 预期: 所有测试通过
- [x] 为 `/web/config/agents` 路由补齐共享行为测试
  - 测试文件: `src/__tests__/config-integration.test.ts`
  - 在现有 `stubConfigPg()` 基础上增加共享 Agent 场景，覆盖：
    - `action: "list"` 返回带 `resourceAccess` 的 Agent 列表
    - `action: "get"` 能读取外部公开 Agent 详情
    - `action: "set"` 对外部 Agent 返回 403 或 `FORBIDDEN`
  - 运行命令: `bun test src/__tests__/config-integration.test.ts`
  - 预期: 共享 Agent 的 list/get 行为通过，set 外部 Agent 被拒绝

**检查步骤:**
- [x] 检查 Agent config service 已导出共享入口
  - `rg -n 'getAgentConfigByResourceKey|getReadableAgentConfigById|assertAgentConfigInternalWritable' src/services/config/agent-config.ts src/services/config/index.ts src/services/config-pg.ts`
  - 预期: 三个导出在 service 和桶文件中都可见
- [x] 检查 Agent route 已返回 `resourceAccess`
  - `rg -n 'resourceAccess|publicReadable' src/routes/web/config/agents.ts`
  - 预期: list/get/set 流程都出现共享字段处理
- [x] 运行 Agent 共享测试
  - `bun test src/__tests__/config-agent-resource-access.test.ts src/__tests__/config-integration.test.ts`
  - 预期: 测试通过

---

### Task 3: 改造 Environment 绑定与 LaunchSpec 依赖解析链路

**背景:**
当前 `src/services/environment-web.ts` 在 create/update 时调用 `getAgentConfigById(params.agentConfigId, organizationId)`，只能绑定本组织 Agent；`src/services/config/aggregate.ts` 和 `src/services/instance.ts` 也仍然用 Environment 组织视角读取依赖，无法支撑“共享 Agent 绑定私有 provider/skill/mcp 仍能启动”。
本 Task 负责把 Agent 本体的权限判断与依赖穿透解析拆开：Agent 本体仍按 `agent_config` 权限校验，底层依赖只在 `getAgentFullConfig()` 聚合链路中按 Agent 所属组织直连读取。
Task 4 的前端只会消费这里产出的行为，Acceptance 任务也会重点验证这里的启动场景。

**涉及文件:**
- 修改: `src/services/environment-web.ts`
- 修改: `src/services/config/aggregate.ts`
- 修改: `src/services/instance.ts`
- 修改: `src/services/config-pg.ts`
- 修改: `src/services/config/index.ts`
- 新建: `src/__tests__/environment-shared-agent-access.test.ts`
- 新建: `src/__tests__/launch-spec-agent-sharing-access.test.ts`

**执行步骤:**
- [x] 让 Environment create/update 使用“当前调用方可读”的 Agent 校验
  - 位置: `src/services/environment-web.ts` 的 `createWebEnvironment()` 和 `updateWebEnvironment()`
  - 把 `configPg.getAgentConfigById(params.agentConfigId, organizationId)` 替换为 `configPg.getReadableAgentConfigById({ organizationId, userId, role: "owner" }, params.agentConfigId)`；拿到返回的真实 Agent 后继续读取 `machineId`
  - 在 `createWebEnvironment()` 中保持 `machineName` 仍按真实 Agent 的 `machineId` 查 `machine.agentName`
  - 原因: Environment 仍属于当前 team，但 `agentConfigId` 必须允许指向“当前 team 可读”的外部公开 Agent
- [x] 把 `getAgentFullConfig()` 改为按 Agent 所属组织直连聚合依赖
  - 位置: `src/services/config/aggregate.ts` 的 `getAgentFullConfig(ctx, agentConfigId)` 实现（~L21）
  - 先用 `getReadableAgentConfigById(ctx, agentConfigId)` 解析当前调用方可用的 Agent；命中后提取 `resolvedAgent.organizationId`
  - 对 `provider`、`mcp_server`、`skill` 的读取改为基于一个 `sourceCtx = { ...ctx, organizationId: resolvedAgent.organizationId, userId: resolvedAgent.userId }` 执行内部查询：
    - provider 直接读取 `sourceCtx` 组织下的全部 provider，再在 `buildLaunchSpec()` 里按 modelRef 解析
    - mcp 读取 `sourceCtx` 组织下 enabled 的 server
    - skill 通过 `agentConfigSkill` 绑定 id 读取真实 skill 行，不再按调用方 `listSkills(ctx)` 做二次权限过滤
  - 保持 `agentConfig: resolvedAgent` 返回给下游
  - 原因: 共享 Agent 的底层依赖不应要求调用方 team 对这些资源也具备独立读权限
- [x] 调整实例启动链路，显式区分“Agent 权限校验”和“依赖聚合”
  - 位置: `src/services/instance.ts` 的 `spawnInstanceFromEnvironment()`（~L96）
  - 把当前两次 `getAgentConfigById()` / `getAgentFullConfig()` 组合改为：
    - 先用 `getReadableAgentConfigById({ organizationId: env.organizationId ?? "", userId, role: "owner" }, env.agentConfigId)` 解析可用 Agent
    - 以该 Agent 的 `name`、`prompt`、`model`、`machineId` 填充运行时变量
    - 调用更新后的 `getAgentFullConfig()` 生成 `fullConfig`
    - 后续 `buildLaunchSpec()` 仍只消费 `fullConfig`，不在 route/service 其他位置分散依赖读取
  - 原因: 这样可以保证 Agent 本体权限仍按使用方校验，但底层 provider / skill / mcp 由共享 Agent 自己的组织上下文解析
- [x] 为共享 Agent 的 Environment 和 LaunchSpec 行为编写测试
  - 测试文件: `src/__tests__/environment-shared-agent-access.test.ts`
  - 测试场景:
    - `createWebEnvironment()` 允许绑定外部公开 Agent，返回记录保留当前组织的 `organizationId`
    - `updateWebEnvironment()` 拒绝绑定不可读 Agent，允许切换到可读外部 Agent
    - `machineName` 仍取自共享 Agent 的 `machineId`
  - 运行命令: `bun test src/__tests__/environment-shared-agent-access.test.ts`
  - 预期: 所有测试通过
- [x] 为共享 Agent 的依赖穿透解析编写测试
  - 测试文件: `src/__tests__/launch-spec-agent-sharing-access.test.ts`
  - 测试场景:
    - `getAgentFullConfig(ctx, externalAgentId)` 在当前组织无 provider/skill/mcp 读权限时，仍能返回外部 Agent 自身绑定的 provider、skill、enabled mcp
    - `buildLaunchSpec()` 使用上一步 `fullConfig` 能正常生成 model / mcp / skills 配置
    - knowledge 绑定不做权限穿透，测试中明确保持现状不扩展
  - 运行命令: `bun test src/__tests__/launch-spec-agent-sharing-access.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 Environment 已使用可读 Agent 校验
  - `rg -n 'getReadableAgentConfigById' src/services/environment-web.ts src/services/instance.ts`
  - 预期: `createWebEnvironment()`、`updateWebEnvironment()`、`spawnInstanceFromEnvironment()` 都改为使用该入口
- [x] 检查 `getAgentFullConfig()` 已不再按调用方 `listSkills(ctx)` 过滤绑定 skill
  - `rg -n 'listSkills\\(ctx\\)|sourceCtx|agentConfigSkill' src/services/config/aggregate.ts`
  - 预期: 代码中存在 `sourceCtx` 或等价的源组织聚合逻辑，且 skill 读取依赖绑定 id
- [x] 运行共享启动链路测试
  - `bun test src/__tests__/environment-shared-agent-access.test.ts src/__tests__/launch-spec-agent-sharing-access.test.ts`
  - 预期: 测试通过

---

### Task 4: 补齐 SDK / 前端 Agent 面板的共享只读交互

**背景:**
当前 SDK 和前端 `AgentInfo` / `AgentDetail` 类型还没有 `resourceAccess`、`publicReadable`、来源组织等字段；`AgentFormDialog.tsx`、`AgentSidebarTree.tsx` 也默认把 Agent 当作本团队可编辑资源使用。
本 Task 负责把共享 Agent 的来源信息、只读表单、公开开关和 Environment 选择能力落到界面层，同时继续遵守现有 i18n 规则。
它依赖 Task 2 的 route 返回结构和 Task 3 的共享 Environment 绑定能力。

**涉及文件:**
- 修改: `packages/sdk/src/types/schemas.ts`
- 修改: `web/src/types/config.ts`
- 修改: `packages/sdk/src/modules/config.ts`
- 修改: `web/src/lib/agent-utils.ts`
- 新建: `web/src/lib/agent-resource-access.ts`
- 修改: `web/src/pages/agent-panel/AgentFormDialog.tsx`
- 修改: `web/src/pages/agent-panel/AgentSidebarTree.tsx`
- 修改: `web/src/i18n/locales/en/agentPanel.json`
- 修改: `web/src/i18n/locales/zh/agentPanel.json`
- 修改: `web/src/i18n/locales/en/agents.json`
- 修改: `web/src/i18n/locales/zh/agents.json`
- 新建: `web/src/__tests__/agent-resource-access-flow.test.ts`
- 修改: `web/src/__tests__/config-types.test.ts`
- 修改: `web/src/__tests__/config-agents-page.test.ts`

**执行步骤:**
- [x] 扩展 SDK 与前端 Agent 类型
  - 位置: `packages/sdk/src/types/schemas.ts` 的 `AgentInfo` / `AgentDetail`，以及 `web/src/types/config.ts` 的同名接口
  - 为 `AgentInfo` 增加 `id`、`resourceAccess?: ResourceAccess`、`skillIds?: string[]`、`knowledgeBaseCount`；为 `AgentDetail` 增加 `resourceAccess?: ResourceAccess`、`skillIds?: string[]`、`machineId?: string | null`
  - 保持 `AgentApi.list()` / `get()` 的方法签名不变，只更新返回结构类型
  - 原因: 前端需要稳定区分内部 Agent 与外部共享 Agent，并在环境创建/编辑时保留真实 `id`
- [x] 新增 Agent 资源访问辅助函数
  - 位置: 新建 `web/src/lib/agent-resource-access.ts`
  - 参照 `skill-resource-access.ts` / `mcp-resource-access.ts` 实现：
    - `getAgentOptionValue(agent)`：优先 `resourceAccess.resourceKey`，回退 `id`
    - `getAgentDisplayName(agent)`：外部 Agent 显示 `sourceOrganizationName/name`
    - `isAgentWritable(agent)` / `canManageAgentSharing(agent)`：统一判断只读和公开开关能力
    - `getAgentAccessBadgeKey(agent)`：返回 `resource.external` / `resource.public` / `resource.private`
  - 原因: 共享 Agent 在侧边栏、表单、环境选择和公开开关上都需要一致的来源/权限文案
- [x] 让 Agent 表单和侧边栏识别外部只读 Agent
  - 位置: `web/src/pages/agent-panel/AgentFormDialog.tsx`
  - 具体修改:
    - 加载详情后读取 `resourceAccess`，对 `ownership === "external"` 的 Agent 进入只读态：禁用基本字段、skills、knowledge、permission、machine 选择和保存按钮
    - 对内部 Agent 显示公开开关，并在保存 payload 中继续通过 `publicReadable` 走原 `agentApi.set()` 请求
    - Agent 下拉与关联 Environment 匹配时使用 `id` 和 `resourceAccess.resourceKey` 组合，避免同名共享 Agent 冲突
  - 位置: `web/src/pages/agent-panel/AgentSidebarTree.tsx`
  - 在树节点上显示来源 team 文案，保留“进入 Agent”能力，但只对内部 Agent 暴露编辑入口
  - 原因: 外部共享 Agent 应该“可查看/可启动/不可编辑”，且 UI 不能误导为本团队私有资源
- [x] 补齐共享 Agent 的 i18n 文案与前端测试
  - 位置: `web/src/i18n/locales/en/agentPanel.json`、`web/src/i18n/locales/zh/agentPanel.json`、`web/src/i18n/locales/en/agents.json`、`web/src/i18n/locales/zh/agents.json`
  - 新增只读提示、来源组织标签、公开开关文案和共享来源标题；禁止在 JSX 内直接硬编码字符串
  - 测试文件: `web/src/__tests__/agent-resource-access-flow.test.ts`
  - 测试场景:
    - 同名内部/外部 Agent 的 option value 优先 `resourceAccess.resourceKey`
    - 外部 Agent 的显示名称带 `sourceOrganizationName`
    - `isAgentWritable()` / `canManageAgentSharing()` 对外部 Agent 返回 false
    - 公开开关 payload 仍通过 `agentApi.set(name, { publicReadable })` 发送
  - 运行命令: `bun test web/src/__tests__/agent-resource-access-flow.test.ts web/src/__tests__/config-types.test.ts web/src/__tests__/config-agents-page.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 Agent 类型已包含 `resourceAccess`
  - `rg -n 'resourceAccess\\?: ResourceAccess' packages/sdk/src/types/schemas.ts web/src/types/config.ts`
  - 预期: SDK 与前端类型文件都包含 Agent 访问元信息
- [x] 检查 Agent 面板已引入共享访问辅助函数
  - `rg -n 'agent-resource-access|resourceAccess|publicReadable' web/src/pages/agent-panel/AgentFormDialog.tsx web/src/pages/agent-panel/AgentSidebarTree.tsx`
  - 预期: 表单和侧边栏都处理外部只读与来源展示
- [x] 运行前端共享 Agent 测试
  - `bun test web/src/__tests__/agent-resource-access-flow.test.ts web/src/__tests__/config-types.test.ts web/src/__tests__/config-agents-page.test.ts`
  - 预期: 测试通过

---

### Task 5: agent-config-sharing 验收

**前置条件:**
- 启动命令: `bun run dev`（后端）与 `bun run dev:web`（前端），或使用现有开发环境
- 测试数据准备: 准备一个 source 组织的公开 Agent，其绑定私有 `provider` / `skill` / `mcp_server`；准备另一个 consumer 组织用于读取和启动
- 其他环境准备: 数据库可执行 `db:push` 或已有本地测试库；前端改动后已执行 `bun run build:web`

**端到端验证:**

1. 运行完整质量检查确保无回归
   - `bun run precheck`
   - 预期: format、import 排序、tsc、biome check 全部通过
   - 失败排查: 按 Task 1 到 Task 4 的测试入口分别回退排查

2. 验证 `agent_config` 已接入公开权限模型
   - `bun test src/__tests__/resource-permission-agent-config.test.ts src/__tests__/config-agent-resource-access.test.ts`
   - 预期: `agent_config` 枚举、service 读写和公开开关测试全部通过
   - 失败排查: 检查 Task 1 权限枚举和 Task 2 Agent service

3. 验证 `/web/config/agents` 可返回共享 Agent 且外部只读
   - `bun test src/__tests__/config-integration.test.ts`
   - 预期: list/get 能看到外部公开 Agent 且带 `resourceAccess`，set 外部 Agent 被拒绝
   - 失败排查: 检查 Task 2 route 的 `handleList()` / `handleGet()` / `handleSet()`

4. 验证 Environment 可绑定共享 Agent，且启动时能穿透读取私有 provider / skill / mcp
   - `bun test src/__tests__/environment-shared-agent-access.test.ts src/__tests__/launch-spec-agent-sharing-access.test.ts`
   - 预期: 共享 Agent 可被绑定并成功生成 LaunchSpec；未公开依赖仍能被本次运行使用
   - 失败排查: 检查 Task 3 的 `getReadableAgentConfigById()`、`getAgentFullConfig()` 与 `spawnInstanceFromEnvironment()`

5. 验证前端共享 Agent 只读交互与来源展示
   - `bun test web/src/__tests__/agent-resource-access-flow.test.ts web/src/__tests__/config-types.test.ts web/src/__tests__/config-agents-page.test.ts`
   - 预期: 同名共享 Agent 能稳定区分，外部 Agent 显示来源团队、不可编辑、公开开关仅内部可见
   - 失败排查: 检查 Task 4 的 `agent-resource-access.ts`、`AgentFormDialog.tsx`、`AgentSidebarTree.tsx`

6. 验证前端产物可构建
   - `bun run build:web`
   - 预期: 构建成功，无类型错误，生成更新后的 `web/dist`
   - 失败排查: 检查 Task 4 的 SDK / 前端类型同步和 i18n 文案补齐
