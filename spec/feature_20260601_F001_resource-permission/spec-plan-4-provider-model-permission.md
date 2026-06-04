# resource-permission 执行计划 4：Provider / Model 前后端接入权限改造

**目标:** 让 Provider 支持跨 team 只读共享，Model 通过所属 Provider 继承可见性，并保证前端列表、模型选择、Agent LaunchSpec、Meta Agent 和 Workflow 解析链路一致。

**技术栈:** Bun + Elysia + Drizzle ORM + React 19 + Vite + i18next + Bun test

**设计文档:** `spec/feature_20260601_F001_resource-permission/spec-design.md`

## 改动总览

本计划改造 `src/services/config/provider.ts`、`model.ts`、`aggregate.ts`、`routes/web/config/providers.ts`、`routes/web/config/models.ts`、Provider/Model 前端页面和类型。
Provider 是授权最小单元，Model 不写入 `resource_permission`，所有 model list/get/write/test 均通过 provider 的 `resourceAccess` 判定。
模型引用继续兼容 `provider/model`，新增稳定 provider key 字段供 UI 和内部解析使用；旧 name 路径保留兼容现有数据。
本计划是四份计划的总体验收入口，Acceptance 覆盖 DB、Skill、MCP、Provider/Model 全链路。

---

### Task 0: 环境准备

**背景:**
Provider/Model 改造依赖计划 1 的权限 service，并与计划 2/3 的运行时集合改造共享 `aggregate.ts`。执行前验证前三份计划核心测试已通过。

**执行步骤:**
- [x] 验证权限 service 已可用
  - 位置: 仓库根目录
  - 执行 `bun test src/__tests__/resource-permission-service.test.ts`
  - 原因: Provider service 将复用统一来源和只读判断
- [x] 验证现有 Provider/Model 测试可运行
  - 位置: 仓库根目录
  - 执行 `bun test src/__tests__/config-providers.test.ts src/__tests__/config-models.test.ts`
  - 原因: 本计划会改动 provider route 和 model available list

**检查步骤:**
- [x] 检查权限 service 测试
  - `bun test src/__tests__/resource-permission-service.test.ts`
  - 预期: 测试通过
- [x] 检查 Provider/Model 基线测试
  - `bun test src/__tests__/config-providers.test.ts src/__tests__/config-models.test.ts`
  - 预期: 测试通过

---

### Task 1: Provider service 接入可读集合和公开开关

**背景:**
当前 Provider 只按当前 organization 查询，Model 也只按内部 provider 展开。需要 Provider service 返回内部和外部授权 provider，并补齐 `resourceAccess`，后续 Model 和运行时解析全部继承该可见性。

**涉及文件:**
- 修改: `src/services/config/provider.ts`
- 修改: `src/services/config/types.ts`
- 修改: `src/services/config/index.ts`
- 新建: `src/__tests__/config-provider-resource-access.test.ts`

**执行步骤:**
- [x] 扩展 Provider/Model 类型
  - 位置: `src/services/config/types.ts` 的 Provider 和 Model section
  - 新增:
    ```ts
    export interface ProviderSetOptions { publicReadable?: boolean }
    export interface ProviderResourceRef { id: string; name: string; organizationId: string; resourceAccess: ResourceAccess }
    export interface ModelEntryWithProviderAccess {
      id: string;
      providerId: string;
      organizationId: string;
      modelId: string;
      displayName: string | null;
      modalities: unknown;
      limitConfig: unknown;
      cost: unknown;
      options: unknown;
      providerResourceAccess: ResourceAccess;
    }
    ```
  - 原因: Model 继承 Provider 来源字段，前端据此判断 model 是否可编辑
- [x] 新增外部 Provider 批量读取 helper
  - 位置: `src/services/config/provider.ts`，在 `listProviders()` 之前
  - 新增 `async function listExternalProviders(ctx)`，调用 `listReadableResourceRefs(ctx, "provider")`，按 `provider.id` 查询外部 rows，过滤不存在引用
  - 原因: 权限 service 只返回引用，业务字段由 Provider service 读取
- [x] 新增 `listReadableProviders(ctx)`
  - 位置: `src/services/config/provider.ts`
  - 查询内部 providers 和外部 providers；不按 name 去重；调用 `decorateResourceAccess(ctx, "provider", rows)`；返回带 `resourceAccess` 的 provider rows
  - 原因: `listProviders`、`getProvider`、model available list、aggregate 都依赖统一 provider 可见集合
- [x] 改造 `listProviders(ctx)`
  - 位置: `src/services/config/provider.ts:listProviders()`
  - 使用 `listReadableProviders(ctx)`；model count 按 provider ids 查询，不再加 `eq(model.organizationId, ctx.organizationId)`；返回每项增加 `resourceAccess`、`resourceKey`
  - 原因: 外部 provider 下的 models 必须被计数
- [x] 新增 `getProviderByResourceKey(ctx, resourceKey)`
  - 位置: `src/services/config/provider.ts`，在 `getProvider()` 后
  - 解析 `sourceOrganizationId/resourceUid`，按 `provider.id` 查询；调用 `canReadResource(ctx, "provider", row.id, row.organizationId)`；返回带 models 和 `resourceAccess`
  - 原因: 支持同名 provider 详情和前端稳定操作
- [x] 改造 `getProvider(ctx, name)`
  - 位置: `src/services/config/provider.ts:getProvider()`
  - 先查内部 `organizationId + name`；未命中从 `listReadableProviders(ctx)` 找 name 相等的第一条外部 provider；models 查询按 `providerId`，不按当前 organization 过滤；返回 provider `resourceAccess`，每个 model 附 `providerResourceAccess`
  - 原因: Model 可见性继承 provider，不单独授权
- [x] 改造 `upsertProvider(ctx, name, data, options)`
  - 位置: `src/services/config/provider.ts:upsertProvider()`
  - 签名增加 `options: ProviderSetOptions = {}`；内部 upsert 后当 `options.publicReadable !== undefined` 调用 `setPublicRead(ctx, "provider", ctx.organizationId, row.id, options.publicReadable)`
  - 原因: 公开开关通过原 provider set 接口修改
- [x] 改造 `deleteProvider(ctx, name)`
  - 位置: `src/services/config/provider.ts:deleteProvider()`
  - 先 `getProvider(ctx, name)`；不存在返回 false；调用 `assertInternalWritable(ctx, "provider", row.id, row.organizationId)`；按 provider id 删除
  - 原因: 外部 provider 不可删除，且同名资源不能误删
- [x] 新增 `assertProviderInternalWritable(ctx, nameOrResourceKey)`
  - 位置: `src/services/config/provider.ts` helper 区
  - 支持 resourceKey 和 name；读取 provider 后调用 `assertInternalWritable`；返回 provider detail
  - 原因: route 的 test、model add/update/remove 必须拒绝外部 provider
- [x] 从 config barrel 导出新增函数和类型
  - 位置: `src/services/config/index.ts`
  - 导出 `listReadableProviders`、`getProviderByResourceKey`、`assertProviderInternalWritable`、`ProviderSetOptions`、`ModelEntryWithProviderAccess`
  - 原因: route、models API、aggregate 和测试需要复用
- [x] 为 Provider service 编写单元测试
  - 测试文件: `src/__tests__/config-provider-resource-access.test.ts`
  - 测试场景:
    - 内部和外部同名 provider 同时出现在 `listProviders`，`resourceKey` 不同
    - 外部 provider 的 modelCount 按源 provider models 统计
    - `getProviderByResourceKey` 返回外部 provider 和 models，model 带 `providerResourceAccess.writable=false`
    - `deleteProvider` 和 `assertProviderInternalWritable` 对外部 provider 抛 403
    - `upsertProvider(..., { publicReadable: true })` 调用 `setPublicRead`
  - 运行命令: `bun test src/__tests__/config-provider-resource-access.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 Provider service 权限调用
  - `rg -n 'listReadableProviders|getProviderByResourceKey|assertProviderInternalWritable|listReadableResourceRefs|decorateResourceAccess|setPublicRead|assertInternalWritable' src/services/config/provider.ts`
  - 预期: 所有关键函数和权限调用均存在
- [x] 运行 Provider service 权限测试
  - `bun test src/__tests__/config-provider-resource-access.test.ts`
  - 预期: 测试通过

---

### Task 2: Model 继承 Provider 可见性并保护写操作

**背景:**
Model 不独立授权，当前 add/update/remove 只接收 organizationId 和 providerId。需要所有 model 写操作先通过 Provider 可写性校验，模型列表和默认模型选择通过 Provider 可读集合展开。

**涉及文件:**
- 修改: `src/services/config/model.ts`
- 修改: `src/routes/web/config/providers.ts`
- 修改: `src/routes/web/config/models.ts`
- 新建: `src/__tests__/model-provider-access.test.ts`
- 修改: `src/__tests__/config-providers.test.ts`
- 修改: `src/__tests__/config-models.test.ts`

**执行步骤:**
- [x] 改造 model service 函数签名
  - 位置: `src/services/config/model.ts`
  - 将 `addModel(organizationId, providerId, data)` 改为 `addModel(ctx: AuthContext, providerId, data)`；`updateModel`、`removeModel` 同样改为首参 `ctx`
  - 函数内通过 `providerId` 查 provider row，调用 `assertInternalWritable(ctx, "provider", provider.id, provider.organizationId)`，写入时使用 `provider.organizationId`
  - 原因: 外部 provider 下的 model 不可增删改，内部 provider 写入仍落当前 team
- [x] 改造 Provider route 的 get/list 返回
  - 位置: `src/routes/web/config/providers.ts:handleList()` 和 `handleGet()`
  - list 每个 provider 返回 `resourceAccess`、`resourceKey`；get 返回 provider `resourceAccess`，models 每项返回 `providerResourceAccess`
  - 原因: 前端通过原 API 判断 provider/model 可写性
- [x] 改造 Provider route 的 set/delete/test
  - 位置: `handleSet`、`handleDelete`、`handleTest`
  - set 从 data 提取 `publicReadable` 并传给 `configPg.upsertProvider(ctx, name, providerData, { publicReadable })`；delete/test 先调用 `configPg.assertProviderInternalWritable(ctx, name)`
  - 原因: 公开开关通过原 set 入口，外部 provider 不可测试或删除
- [x] 改造 model add/update/remove route
  - 位置: `handleAddModel`、`handleUpdateModel`、`handleRemoveModel`
  - 先调用 `configPg.assertProviderInternalWritable(ctx, providerName)`；再调用新签名 `configPg.addModel(ctx, p.id, ...)` 等方法
  - 原因: 外部 provider 下的 model 不可编辑
- [x] 改造 `buildAvailableList(ctx)`
  - 位置: `src/routes/web/config/models.ts`
  - 使用 `configPg.listProviders(ctx)` 和 `configPg.getProvider(ctx, p.resourceAccess?.resourceKey ?? p.name)`；available item 增加 `providerResourceAccess`、`providerResourceKey`
  - `fullId` 第一版继续输出 `${p.name}/${m.modelId}`，当存在同名外部 provider 时同时输出 `providerResourceKey/modelId` 到新增字段 `stableFullId`
  - 原因: 兼容旧模型引用，同时为同名资源提供稳定身份
- [x] 改造 `handleSet(ctx, data)`
  - 位置: `src/routes/web/config/models.ts:handleSet()`
  - 当 `data.model` 或 `data.small_model` 存在时调用新增 helper `assertReadableModelRef(ctx, ref)` 校验 provider 可读；不可读返回 `CONFIG_READ_ERROR`/`VALIDATION_ERROR`
  - 原因: 用户配置不能保存不可读外部模型引用
- [x] 新增 `assertReadableModelRef(ctx, ref)`
  - 位置: `src/routes/web/config/models.ts` 的 helper 区
  - 支持 `provider/model` 和 `sourceOrg/providerUid/model` 两种格式；解析 provider 后调用 `configPg.getProvider` 或 `getProviderByResourceKey`，并确认 modelId 存在
  - 原因: 模型选择和运行时解析需要统一 provider 可读性判断
- [x] 更新测试 stub 的 model 方法签名
  - 位置: `src/test-utils/stubs/config-pg-stub.ts`、`src/__tests__/config-providers.test.ts`
  - `addModel/updateModel/removeModel` 首参改为 ctx；保留测试内存 store 的行为
  - 原因: route 测试需要匹配新 service 签名
- [x] 为 Model 继承 Provider 编写单元测试
  - 测试文件: `src/__tests__/model-provider-access.test.ts`
  - 测试场景:
    - 外部 provider 下 models 出现在 `/web/config/models` available 中
    - 外部 provider 的 add/update/remove model 返回 403
    - `handleSet` 可保存可读外部 model ref
    - `handleSet` 拒绝不可读 provider/model ref
  - 运行命令: `bun test src/__tests__/model-provider-access.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 model service 首参使用 AuthContext
  - `rg -n 'function addModel|function updateModel|function removeModel|AuthContext|assertInternalWritable' src/services/config/model.ts`
  - 预期: 三个写方法均使用 `ctx` 并调用写保护
- [x] 检查 models route 校验 model ref
  - `rg -n 'assertReadableModelRef|stableFullId|providerResourceAccess|providerResourceKey' src/routes/web/config/models.ts`
  - 预期: available 和 set 均接入 provider 可见性
- [x] 运行 Model 权限测试
  - `bun test src/__tests__/model-provider-access.test.ts src/__tests__/config-providers.test.ts src/__tests__/config-models.test.ts`
  - 预期: 测试通过

---

### Task 3: 运行时聚合、LaunchSpec、Meta Agent 和 Workflow 解析统一可见 Provider

**背景:**
前端看到外部 provider/model 还不够，Agent LaunchSpec、Meta Agent 和 Workflow agent config resolver 必须使用同一 provider/model 可见入口。当前 `aggregate.ts` 直接查内部 provider，`launch-spec-builder.ts` 按 provider name 解析模型。

**涉及文件:**
- 修改: `src/services/config/aggregate.ts`
- 修改: `src/services/launch-spec-builder.ts`
- 修改: `src/services/meta-agent.ts`
- 修改: `src/services/workflow/agent-config-resolver.ts`
- 新建: `src/__tests__/launch-spec-provider-model-access.test.ts`
- 新建: `src/__tests__/workflow-provider-model-access.test.ts`

**执行步骤:**
- [x] 改造 `getAgentFullConfig(ctx, agentConfigId)` 的 provider 读取
  - 位置: `src/services/config/aggregate.ts`
  - 用 `listReadableProviders(ctx)` 替换所有直接 `db.select().from(provider).where(eq(provider.organizationId, ctx.organizationId))`
  - 保留 agentConfig 自身仍按 `ctx.organizationId` 查询
  - 原因: 运行时 provider 可见集合必须与配置页一致
- [x] 保持 Skill/MCP 聚合使用计划 2/3 的 service
  - 位置: `src/services/config/aggregate.ts`
  - 确认 skills 使用计划 2 的可读 skill 入口，mcpServers 使用计划 3 的 `listMcpServers(ctx).filter(enabled)`
  - 原因: 最终聚合入口必须覆盖三类外部资源
- [x] 改造 `resolveModelConfig(modelRef, providers)`
  - 位置: `src/services/launch-spec-builder.ts`
  - 支持两种引用:
    - 旧格式 `providerName/modelId`：按 `providers.find(p => p.name === providerName)` 解析
    - 稳定格式 `sourceOrg/providerUid/modelId`：按 `p.resourceAccess?.resourceKey === sourceOrg/providerUid` 解析
  - 当旧格式命中多个同名 provider 时优先内部 provider，再取第一个外部 provider，并记录 log
  - 原因: 保持旧数据兼容，同时支持同名外部 provider 的稳定引用
- [x] 确认 LaunchSpec 输出 provider 名称策略
  - 位置: `src/services/launch-spec-builder.ts:resolveModelConfig()`
  - 输出 `provider` 字段继续使用 `prov.name`，`baseUrl/apiKey/protocol` 使用源 provider 当前字段
  - 原因: SDK 不需要知道权限表，运行时只需要正确 provider 配置
- [x] 改造 Meta Agent 创建默认模型引用
  - 位置: `src/services/meta-agent.ts`
  - 查找或创建 meta-agent provider 时使用 `configPg.listProviders(ctx)`；当已有可读外部 provider 满足默认模型时只读引用，不复制 provider；创建/更新 meta-agent 自身配置仍写当前 team
  - 原因: Meta Agent 的模型选择与普通 Agent 一致
- [x] 改造 Workflow agent config resolver
  - 位置: `src/services/workflow/agent-config-resolver.ts`
  - 解析 agent config 的 model 字段时使用 `getAgentFullConfig(ctx, agentConfigId)` 输出的 providers，不直接查内部 provider/model
  - 原因: Workflow 运行时必须能使用外部 provider 下 model
- [x] 为 LaunchSpec provider/model 权限编写测试
  - 测试文件: `src/__tests__/launch-spec-provider-model-access.test.ts`
  - 测试场景:
    - 外部 provider 进入 `fullConfig.providers` 并被 `buildLaunchSpec` 解析为正确 `apiKey/baseUrl/model`
    - 同名内部和外部 provider 同时存在，旧 `provider/model` 优先内部 provider
    - 稳定 `sourceOrg/providerUid/model` 解析到外部 provider
  - 运行命令: `bun test src/__tests__/launch-spec-provider-model-access.test.ts`
  - 预期: 所有测试通过
- [x] 为 Workflow provider/model 解析编写测试
  - 测试文件: `src/__tests__/workflow-provider-model-access.test.ts`
  - 测试场景:
    - Workflow resolver 读取外部 provider model 成功
    - 不可读 provider model 返回明确错误
  - 运行命令: `bun test src/__tests__/workflow-provider-model-access.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 aggregate 使用统一 provider 可见入口
  - `rg -n 'listReadableProviders|from\\(provider\\)' src/services/config/aggregate.ts`
  - 预期: 存在 `listReadableProviders(ctx)`，不存在直接内部 provider 查询
- [x] 检查 LaunchSpec 支持稳定模型引用
  - `rg -n 'resourceKey|stable|sourceOrganizationId|resolveModelConfig' src/services/launch-spec-builder.ts`
  - 预期: `resolveModelConfig` 支持 `sourceOrg/providerUid/modelId`
- [x] 运行运行时解析测试
  - `bun test src/__tests__/launch-spec-provider-model-access.test.ts src/__tests__/workflow-provider-model-access.test.ts`
  - 预期: 测试通过

---

### Task 4: Provider / Model 前端消费 resourceAccess

**背景:**
Provider/Model 页面当前对所有 provider 和 model 都显示编辑、删除、测试和模型增删改。需要基于 provider 的 `resourceAccess` 隐藏外部资源写操作，并让模型选择器展示来源组织。

**涉及文件:**
- 修改: `packages/sdk/src/types/schemas.ts`
- 修改: `web/src/types/config.ts`
- 修改: `web/src/pages/agent-panel/pages/AgentModelsPage.tsx`
- 修改: `web/components/config/ModelConfigDialog.tsx`
- 修改: `web/src/pages/agent-panel/AgentFormDialog.tsx`
- 修改: `web/src/i18n/locales/en/models.json`
- 修改: `web/src/i18n/locales/zh/models.json`
- 修改: `web/src/i18n/locales/en/components.json`
- 修改: `web/src/i18n/locales/zh/components.json`
- 新建: `web/src/__tests__/provider-model-resource-access-flow.test.ts`

**执行步骤:**
- [x] 扩展 SDK 和 web Provider/Model 类型
  - 位置: `packages/sdk/src/types/schemas.ts`、`web/src/types/config.ts`
  - `ProviderInfo`、`ProviderDetail` 增加 `resourceAccess?: ResourceAccess`、`resourceKey?: string`
  - `ProviderModel`、`ModelEntry` 增加 `providerResourceAccess?: ResourceAccess`、`providerResourceKey?: string`、`stableFullId?: string`
  - 原因: UI 需要基于 provider 来源判断 model 可写性和选择值
- [x] 改造 `AgentModelsPage` provider key 和按钮
  - 位置: `web/src/pages/agent-panel/pages/AgentModelsPage.tsx` 的 `AgentCardList`
  - `cardKey` 使用 `provider.resourceAccess?.resourceKey ?? provider.id`
  - 外部 provider 显示 External badge；内部公开显示 Public badge；内部显示 Internal badge
  - test/edit/delete/model add 按钮仅在 `provider.resourceAccess?.writable !== false` 时显示
  - 原因: 外部 provider 和其 models 只读
- [x] 新增 Provider 公开开关
  - 位置: `AgentModelsPage` provider card 按钮区域
  - 当 `provider.resourceAccess?.manageable === true` 时显示开关；点击后先 `providerApi.get(provider.resourceAccess.resourceKey)`，再 `providerApi.set(provider.id, { ...options, publicReadable: next })`
  - 原因: 公开开关通过原 provider set 接口映射 all:read
- [x] 改造 providerModels map key
  - 位置: `AgentModelsPage:loadAll()`
  - 使用 `const providerKey = p.resourceAccess?.resourceKey ?? p.id` 作为 `modelsMap` key；获取详情时调用 `providerApi.get(providerKey)`
  - 原因: 同名 provider 的 models 不能互相覆盖
- [x] 隐藏外部 model 写操作
  - 位置: `AgentModelsPage` model subrow
  - 当 `provider.resourceAccess?.writable === false` 时隐藏 model test/edit/delete 和 add model；保留只读展示
  - 原因: model 写权限继承 provider
- [x] 改造模型配置弹窗展示来源
  - 位置: `web/components/config/ModelConfigDialog.tsx`
  - `available` 选项 label 使用 `providerResourceAccess.sourceOrganizationId / label`；value 优先 `stableFullId ?? fullId`
  - 原因: 同名 provider 下 model 可区分选择
- [x] 改造 AgentFormDialog 模型选项
  - 位置: `web/src/pages/agent-panel/AgentFormDialog.tsx` 加载 `modelApi.get()` 的 map
  - `modelOptions` 从 `available` 中优先取 `stableFullId ?? fullId`，显示 label 使用来源组织和 `fullId`
  - 原因: Agent 配置保存稳定模型引用，运行时可解析外部 provider
- [x] 补充 i18n 文案
  - 位置: `web/src/i18n/locales/en/models.json`、`zh/models.json`、`en/components.json`、`zh/components.json`
  - 新增 `resource.internal`、`resource.external`、`resource.public`、`resource.makePublic`、`resource.makePrivate`、`resource.readOnly`
  - 原因: JSX 禁止硬编码用户可见字符串
- [x] 为 Provider/Model 前端流程编写测试
  - 测试文件: `web/src/__tests__/provider-model-resource-access-flow.test.ts`
  - 测试场景:
    - 内部和外部同名 provider 同时渲染，models map 不互相覆盖
    - 外部 provider 不显示 edit/delete/test/add-model/model-edit/model-delete
    - 内部 provider 公开开关调用原 set API 并携带 `publicReadable`
    - ModelConfigDialog 和 AgentFormDialog 优先提交 `stableFullId`
  - 运行命令: `bun test web/src/__tests__/provider-model-resource-access-flow.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 Provider/Model 页面来源字段使用
  - `rg -n 'resourceAccess|resourceKey|providerResourceAccess|stableFullId|publicReadable' web/src/pages/agent-panel/pages/AgentModelsPage.tsx web/components/config/ModelConfigDialog.tsx web/src/pages/agent-panel/AgentFormDialog.tsx`
  - 预期: key、按钮、模型选择均使用来源字段
- [x] 检查 i18n 文案
  - `rg -n 'makePublic|makePrivate|external|readOnly' web/src/i18n/locales/en/models.json web/src/i18n/locales/zh/models.json web/src/i18n/locales/en/components.json web/src/i18n/locales/zh/components.json`
  - 预期: 中英文文案均存在
- [x] 运行 Provider/Model 前端测试
  - `bun test web/src/__tests__/provider-model-resource-access-flow.test.ts`
  - 预期: 测试通过

---

### Task 5: Provider / Model 及整体资源权限验收

**前置条件:**
- 启动命令: 后端 `bun run dev`，前端开发验证 `bun run dev:web`
- 测试数据准备: 至少准备两个 organization；org-a 创建 provider、skill、mcp_server 并开启公开；org-b 切换 active org 后验证外部资源可读只读

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `bun run precheck`
   - 预期: format、import 排序、tsc、biome check 全部通过
   - 失败排查: 先检查计划 1 的类型导出，再检查计划 2/3/4 的 route 和前端类型同步

2. 运行资源权限后端专项测试
   - `bun test src/__tests__/resource-permission-service.test.ts src/__tests__/config-skill-resource-access.test.ts src/__tests__/config-mcp-resource-access.test.ts src/__tests__/config-provider-resource-access.test.ts src/__tests__/model-provider-access.test.ts`
   - 预期: DB/service、Skill、MCP、Provider/Model 权限测试全部通过
   - 失败排查: 对应回看计划 1 Task 2、计划 2 Task 1、计划 3 Task 1、计划 4 Task 1/2

3. 运行运行时一致性测试
   - `bun test src/__tests__/skill-resource-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts src/__tests__/launch-spec-provider-model-access.test.ts src/__tests__/workflow-provider-model-access.test.ts`
   - 预期: Skill archive、MCP LaunchSpec、Provider/Model LaunchSpec、Workflow resolver 均可使用外部可读资源
   - 失败排查: 检查计划 2 Task 2、计划 3 Task 2、计划 4 Task 3

4. 运行前端资源权限流程测试
   - `bun test web/src/__tests__/skill-resource-access-flow.test.ts web/src/__tests__/mcp-resource-access-flow.test.ts web/src/__tests__/provider-model-resource-access-flow.test.ts`
   - 预期: 三类资源页面均正确显示来源、隐藏外部写操作、公开开关走原 API
   - 失败排查: 检查计划 2 Task 3、计划 3 Task 3、计划 4 Task 4

5. 验证前端生产构建
   - `bun run build:web`
   - 预期: Vite 构建成功，无类型、i18n 或路由生成错误
   - 失败排查: 检查所有前端新增类型和翻译 key

6. 验证原 API 不新增独立权限 route
   - `rg -n 'resource-permission|resource_permission' src/routes web/src packages/sdk/src/modules`
   - 预期: `src/routes`、`web/src`、`packages/sdk/src/modules` 中不存在新的独立 resource-permission API；只在原 config API 响应和调用中出现 `resourceAccess`
   - 失败排查: 移除违反设计的独立权限 route，改回原资源 service 内部调用

7. 验证手动跨 team 场景
   - `bun run dev`
   - 预期: org-a 将 provider/skill/mcp 设为公开后，org-b 的原 Providers/Skills/MCP 页面可看到外部资源；外部资源详情可查看，编辑/删除/启停/公开开关不可用；Agent 创建页可引用外部 Skill 和外部 Provider 下 Model；启动 Agent 后 LaunchSpec 使用源资源当前配置
   - 失败排查: 后端返回缺字段时检查对应 service 的 `resourceAccess` 装饰；运行时缺资源时检查 `getAgentFullConfig` 和 `buildLaunchSpec`
