# Feature: 20260604_F001 - agent-config-sharing

## 需求背景

当前系统已经支持 `provider`、`skill`、`mcp_server` 三类资源的跨 team 公开只读，其他 team 可以查看并引用这些资源，但不能修改。相比之下，`agent_config` 仍然只能在所属 team 内可见，导致一个已经配置完成的智能体模板无法被其他 team 直接复用。

用户希望新增 `agent_config` 的公开能力，并保持与现有资源公开模型一致：

- owner team 可以创建、编辑、删除和切换公开状态
- 其他 team 只能查看和使用公开的 Agent 配置，不能修改
- 其他 team 可以直接用公开 Agent 来启动实例

本需求还有一个关键约束：公开的 Agent 可能依赖未公开的 `provider`、`skill`、`mcp_server`。为了避免 owner 必须把底层依赖一起公开，系统需要支持“只公开 Agent，本次运行仍可成功启动”。同时，为了让运行时规则更统一，所有基于 `agent_config` 启动的 Agent 都应采用同一套依赖解析方式，而不是区分内部 Agent 与共享 Agent 分别处理。

## 目标

- 为 `agent_config` 增加与 `provider` / `skill` / `mcp_server` 一致的跨 team 只读公开能力
- 公开 Agent 后，其他 team 可以在列表中看到、查看详情，并把它绑定到 Environment 用于启动
- 外部 team 对公开 Agent 只有 `read/use` 权限，没有 `write/manage` 权限
- 所有基于 `agent_config` 启动的 Agent，都允许在运行时使用其已绑定但未公开的 `provider` / `skill` / `mcp_server` 依赖
- 不因为运行时可使用这些依赖，而把它们自动暴露为可编辑或可管理

## 方案设计

### 1. 核心决策

本方案沿用现有 `resource_permission` 模型，把 `agent_config` 作为第四类可公开资源接入，继续采用“内部资源天然可见 + 跨 team 显式授权”的双层模式。

第一版的关键决策如下：

- `agent_config` 仅新增只读公开，不新增独立权限 API
- 公开状态继续通过原 `/web/config/agents` 接口上的 `set` 请求携带 `publicReadable` 字段完成
- 外部 team 读取到的 Agent 详情需要带 `resourceAccess`
- 外部 team 不能编辑、删除、改公开状态、改 skill 绑定、改 knowledge 绑定、改默认值
- Environment 允许绑定“当前 team 可读”的 Agent，而不再强制要求它属于当前 team
- 所有基于 `agent_config` 启动的 Agent，其依赖的 `provider` / `skill` / `mcp_server` 都不再按调用方 team 的资源权限重新校验，而是统一在 LaunchSpec 构建链路中按 Agent 绑定关系直连源资源解析

这里不采用“共享 Agent 让使用方直接获得依赖资源权限”的表述。更准确的做法是：

- Agent 本体仍然必须先通过可用性校验
- 只有在 LaunchSpec 构建这条运行时链路中，才允许按 Agent 绑定关系直接解析其依赖
- 这种直连解析不向使用方开放这些依赖资源本身的读取、编辑或管理权限

### 2. 资源权限模型扩展

现有 `resource_permission` 已支持 `provider`、`skill`、`mcp_server` 三类资源。新增 `agent_config` 后，沿用相同规则：

- 内部 team：天然可读可写
- 外部 team：只有命中 `all:read` 或 `organization:<id>:read` 时可读
- 外部 team：永远不可写

需要改动的基础层：

- `src/db/schema.ts`
  - 扩展 `resourcePermissionTypeEnum`，新增 `"agent_config"`
- `src/repositories/resource-permission.ts`
  - `ResourcePermissionType` 增加 `"agent_config"`
- `src/services/resource-permission.ts`
  - 无需新增独立接口，复用现有 `listReadableResourceRefs`、`decorateResourceAccess`、`canReadResource`、`assertInternalWritable`、`setPublicRead`

这样可以确保 Agent 公开能力与前三类资源的行为完全一致，避免再引入一套单独权限系统。

### 3. Agent Config 读取与写入规则

`agent_config` 的 service 需要补齐和 `skill` / `provider` 类似的可见性入口。

建议新增或改造以下能力：

- `listAgentConfigs(ctx)`
  - 返回当前 team 内部 Agent + 当前 team 可读的外部公开 Agent
  - 每项补充 `resourceAccess`
- `getAgentConfig(ctx, nameOrResourceKey)`
  - 先查内部同名 Agent
  - 未命中时再查外部可读 Agent
  - 支持通过稳定 `resourceKey` 精确读取
- `getAgentConfigByResourceKey(ctx, resourceKey)`
  - 用于 Environment 绑定和外部详情读取
- `assertAgentConfigInternalWritable(ctx, nameOrResourceKey)`
  - 所有 set/delete/sync 绑定写操作统一走这里
- `createAgentConfig` / `updateAgentConfig`
  - 仅允许写当前 team 资源
  - `publicReadable` 通过 `setPublicRead(ctx, "agent_config", ...)` 映射为公开授权

路由层规则：

- `/web/config/agents` 的 `list/get` 允许返回外部公开 Agent
- `set/delete` 仅允许内部 Agent
- 外部 Agent 的 `skillIds`、`knowledge`、`permission` 等字段可读，但仅作展示和运行时使用
- 列表与详情返回统一补充 `resourceAccess`

### 4. Environment 绑定共享 Agent

当前 `createWebEnvironment()` 和 `updateWebEnvironment()` 在校验 `agentConfigId` 时，要求该 Agent 必须属于当前 `organizationId`。这会阻止其他 team 使用共享 Agent，因此需要改造。

调整后规则：

- Environment 仍然只属于当前 team
- 但 `agentConfigId` 允许指向“当前 team 可读”的外部 Agent
- 校验逻辑从“按 `organizationId` 精确查找”改为“按当前调用方可读范围查找”

建议做法：

- 保留 `getAgentConfigById(id, orgId?)` 作为内部基础方法
- 新增一个“带权限判断的 Agent 解析入口”，例如：
  - `getReadableAgentConfigById(ctx, id)`
  - 或 `resolveAgentConfigForUse(ctx, id)`
- `environment-web.ts` 的 create/update 统一调用该入口

这样可以保证：

- 当前 team 能绑定公开 Agent
- 当前 team 不能绑定无权限访问的 Agent
- Environment 本身的 team 归属逻辑不变

### 5. 启动链路与依赖解析

这是本需求的核心改造点。

当前启动逻辑中，`spawnInstanceFromEnvironment()` 会用 `env.organizationId` 去调用 `getAgentFullConfig()`。这意味着所有 Agent 的依赖解析都站在“当前 Environment 所属 team”的视角，导致一部分已绑定但未公开的 `provider` / `skill` / `mcp_server` 在运行时无法被稳定读到。

改造后应改为：

1. 先解析 `env.agentConfigId` 对应的真实 Agent
2. 确认当前调用方对该 Agent 具备 `read/use` 权限
3. 进入 LaunchSpec 构建链路后，按该 Agent 已绑定的依赖关系直接读取 `provider` / `skill` / `mcp_server`
4. 这种读取仅用于生成本次运行所需的 LaunchSpec，不回流为配置页可见性或资源管理权限

即：

- Agent 本体的“是否可被当前 team 使用”，由 `agent_config` 权限决定
- Agent 依赖的“是否可被本次运行使用”，统一由 LaunchSpec 构建链路内的直连解析规则决定

这样能满足目标：

- owner 不需要公开其底层 provider/skill/mcp
- 内部 Agent 与外部共享 Agent 都走同一套运行时规则
- 使用方 team 仍然可以成功启动共享 Agent
- 使用方 team 不会因此自动获得这些依赖资源的管理权限

### 6. 可见性边界与信息泄露控制

共享 Agent 可以让其他 team 启动成功，但不应把其私有依赖配置的管理能力一并暴露出去。

第一版边界定义如下：

- 外部 team 可以看到 Agent 自身配置字段
  - 如 `name`、`description`、`prompt`、`model`、`steps`、`permission`、`skillIds`
- 外部 team 不可修改任何字段
- 外部 team 不因此获得其依赖 `provider` / `skill` / `mcp_server` 的配置管理权限
- 若外部 team 无权直接访问某个依赖资源，则该依赖仍不应出现在对方的独立配置页里

对于详情展示，第一版接受以下取舍：

- Agent 详情接口仍可返回 `skillIds`、`model` 等运行时必须信息
- 但相关 UI 只做只读展示，不提供跳转到外部私有依赖配置页的可编辑入口

如果后续需要进一步收紧泄露面，可在第二版把“外部 Agent 详情中的依赖字段”改为摘要化展示；第一版先以“可启动 + 不可改”为主，不额外拆复杂脱敏层。

### 7. Knowledge Base 范围

本次不扩展 `knowledge_base` 的跨 team 共享能力。

原因：

- 当前 knowledge 绑定校验仍严格按 `organizationId` 判断
- 知识库数据访问风险和资源体积都明显高于 provider/skill/mcp
- 本次目标是让“Agent 配置公开”先落地，避免把范围扩大到另一套资源模型

因此第一版约束为：

- 共享 Agent 若绑定了仅 owner team 可用的知识库，运行结果是否可完全复用不在本次保证范围内
- 设计与实现中不修改 `agent-knowledge` 现有权限模型
- 文档与验收中明确“本次只解决 provider/skill/mcp 依赖穿透，不包含 knowledge base 共享”

### 8. 前端行为

前端需要延续现有资源公开页面的交互约定。

Agent 列表页：

- 展示内部和外部公开 Agent
- 外部 Agent 显示来源 team 信息
- 内部 Agent 显示公开开关
- 外部 Agent 不显示可编辑、可删除、可切换公开状态的操作

Agent 详情页：

- 可打开外部 Agent 查看配置
- 表单整体为只读态
- `skillIds`、`knowledge` 等字段不允许提交修改

Environment 选择 Agent：

- 可选项中包含当前 team 内部 Agent + 当前 team 可读的外部公开 Agent
- 选择外部 Agent 后允许保存并启动

## 实现要点

- 重点复用现有 `resource_permission` 能力，不新增独立 Agent 权限接口
- `agent_config` 的关键新增读取入口应尽量与 `skill` / `provider` 的模式保持一致，降低维护成本
- `environment-web.ts` 与 `instance.ts` 是本次的关键联动点，只改配置页 list/get 不足以完成需求
- 启动链路必须统一在 LaunchSpec 构建时按 Agent 绑定关系直连解析依赖，避免内部 Agent 与共享 Agent 出现两套运行时规则
- `getAgentFullConfig()` 仍应保持“聚合完整可运行配置”的职责，不把依赖解析散落到 route 层
- UI 侧应明确区分“可使用”与“可管理”，避免让外部公开 Agent 看起来像是本 team 自有资源

## 约束一致性

本方案与当前项目约束保持一致：

- 继续通过原资源接口处理公开状态，不新增独立权限 Web API，符合现有 `resource_permission` 设计方向
- 继续在 service 层完成权限判断和资源聚合，不把权限逻辑下放到前端
- 运行时依赖仍通过 `getAgentFullConfig()` 和 `buildLaunchSpec()` 统一解析，符合当前启动链路架构
- 不引入新的 RBAC 子系统，继续复用现有 `AuthContext` 与 organization role 语义

本方案的唯一新增边界是：

- “所有基于 `agent_config` 启动的 Agent 都可在 LaunchSpec 构建链路中直连解析其绑定依赖，但这些依赖不因此变成独立可读资源”

这不是架构偏离，而是对现有资源公开模型在运行时场景下的补充约束。

## 验收标准

- [ ] `agent_config` 支持 `publicReadable`，owner team 可通过原 `/web/config/agents` 接口切换公开状态
- [ ] 当前 team 的 Agent 列表与详情可看到内部 Agent 和外部公开 Agent，并返回 `resourceAccess`
- [ ] 外部公开 Agent 不可编辑、删除、修改公开状态或修改绑定关系
- [ ] Environment 可以绑定当前 team 可读的外部公开 Agent
- [ ] 所有基于 `agent_config` 启动的 Agent，都通过 LaunchSpec 构建链路按绑定关系直连解析 `provider` / `skill` / `mcp_server`，不再依赖调用方 team 视角的资源可读权限
- [ ] 启动绑定外部公开 Agent 的 Environment 时，即使其依赖的 `provider` / `skill` / `mcp_server` 未公开，也能正常启动
- [ ] 使用共享 Agent 成功启动后，使用方 team 不因此获得其私有依赖资源的管理权限
- [ ] 本次实现不改动 knowledge base 的跨 team 权限模型
