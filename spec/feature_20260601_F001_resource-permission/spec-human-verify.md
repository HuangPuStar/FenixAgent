# resource-permission 人工验收清单

**生成时间:** 2026-06-03 19:43
**关联计划:** `spec/feature_20260601_F001_resource-permission/spec-plan-4-provider-model-permission.md`
**关联设计:** `spec/feature_20260601_F001_resource-permission/spec-design.md`

---

## 验收前准备

### 环境要求
- [ ] [AUTO] 检查 Bun 版本: `bun --version`
- [ ] [AUTO] 验证 Provider/Model 基线测试: `bun test src/__tests__/config-providers.test.ts src/__tests__/config-models.test.ts`
- [ ] [AUTO/SERVICE] 启动后端开发服务: `bun run dev` (port: 3000)
- [ ] [AUTO/SERVICE] 启动前端开发服务: `bun run dev:web` (port: 5173)

### 测试数据准备
- [ ] [MANUAL] 准备两个 organization：org-a 拥有 provider、skill、mcp_server 并可切换公开状态，org-b 用于验证跨 team 只读引用
- [ ] [MANUAL] 在 org-a 中准备一组与外部资源同名的 provider，并确保其下至少有一个 model，便于验证同名共存与稳定引用

---

## 验收项目

### 场景 1：后端 Provider/Model 权限链路

#### - [x] 1.1 Provider service 返回统一可见集合并保护外部资源只读
- **来源:** spec-plan.md Task 1 / spec-design.md §6.3
- **目的:** 确认 Provider 权限接入完整
- **操作步骤:**
  1. [A] `rg -n 'listReadableProviders|getProviderByResourceKey|assertProviderInternalWritable|listReadableResourceRefs|decorateResourceAccess|setPublicRead|assertInternalWritable' src/services/config/provider.ts` → 期望包含: `assertProviderInternalWritable`
  2. [A] `bun test src/__tests__/config-provider-resource-access.test.ts` → 期望包含: `pass`

#### - [x] 1.2 Model 写操作继承 Provider 可写性并校验可读引用
- **来源:** spec-plan.md Task 2 / spec-design.md §4
- **目的:** 确认 Model 继承授权规则
- **操作步骤:**
  1. [A] `rg -n 'function addModel|function updateModel|function removeModel|AuthContext|assertInternalWritable' src/services/config/model.ts` → 期望包含: `assertInternalWritable`
  2. [A] `rg -n 'assertReadableModelRef|stableFullId|providerResourceAccess|providerResourceKey' src/routes/web/config/models.ts` → 期望包含: `assertReadableModelRef`
  3. [A] `bun test src/__tests__/model-provider-access.test.ts src/__tests__/config-providers.test.ts src/__tests__/config-models.test.ts` → 期望包含: `pass`

### 场景 2：运行时解析与原 API 一致

#### - [x] 2.1 聚合入口与 LaunchSpec 支持外部 Provider 和稳定模型引用
- **来源:** spec-plan.md Task 3 / spec-design.md §6.3
- **目的:** 确认配置页与运行时一致
- **操作步骤:**
  1. [A] `rg -n 'listReadableProviders|from\\(provider\\)' src/services/config/aggregate.ts` → 期望包含: `listReadableProviders`
  2. [A] `rg -n 'resourceKey|stable|sourceOrganizationId|resolveModelConfig' src/services/launch-spec-builder.ts` → 期望包含: `resolveModelConfig`
  3. [A] `bun test src/__tests__/launch-spec-provider-model-access.test.ts src/__tests__/workflow-provider-model-access.test.ts` → 期望包含: `pass`

#### - [x] 2.2 原资源 API 继续承载权限能力而非新增独立 route
- **来源:** spec-plan.md Task 5 / spec-design.md §1
- **目的:** 确认接口边界未漂移
- **操作步骤:**
  1. [A] `rg -n 'resourceAccess|resourceKey|publicReadable' src/routes/web/config/providers.ts src/routes/web/config/models.ts packages/sdk/src/types/schemas.ts web/src/types/config.ts` → 期望包含: `resourceAccess`
  2. [A] `! rg -n 'createFileRoute\\(.+resource-permission|resource-permission' src/routes web/src packages/sdk/src/modules` → 期望精确: ``

### 场景 3：前端正确消费 resourceAccess

#### - [x] 3.1 Provider/Model 页面区分内部、外部和公开资源
- **来源:** spec-plan.md Task 4 / spec-design.md §8
- **目的:** 确认来源展示和稳定身份
- **操作步骤:**
  1. [A] `bun test web/src/__tests__/provider-model-resource-access-flow.test.ts` → 期望包含: `pass`
  2. [H] 打开 `http://localhost:5173/ctrl/agent/models`，查看同名内部/外部 provider 是否同时展示，且卡片显示 Internal / External / Public 状态标签 → 是/否

#### - [x] 3.2 外部 Provider 及其 Model 不显示写操作
- **来源:** spec-plan.md Task 4 / spec-design.md §7
- **目的:** 确认只读体验与后端一致
- **操作步骤:**
  1. [A] `rg -n 'resourceAccess|resourceKey|providerResourceAccess|stableFullId|publicReadable' web/src/pages/agent-panel/pages/AgentModelsPage.tsx web/components/config/ModelConfigDialog.tsx web/src/pages/agent-panel/AgentFormDialog.tsx` → 期望包含: `stableFullId`
  2. [H] 打开 `http://localhost:5173/ctrl/agent/models`，查看外部 provider 卡片及其 model 子项是否隐藏 edit/delete/test/add-model/model-edit/model-delete 操作，仅保留只读展示 → 是/否

#### - [x] 3.3 Agent 模型选择优先提交稳定引用并显示来源组织
- **来源:** spec-plan.md Task 4 / spec-design.md §6.3
- **目的:** 确认同名模型选择稳定
- **操作步骤:**
  1. [A] `rg -n 'makePublic|makePrivate|external|readOnly|stableFullId' web/src/i18n/locales/en/models.json web/src/i18n/locales/zh/models.json web/src/i18n/locales/en/components.json web/src/i18n/locales/zh/components.json web/components/config/ModelConfigDialog.tsx web/src/pages/agent-panel/AgentFormDialog.tsx` → 期望包含: `stableFullId`
  2. [H] 打开 `http://localhost:5173/ctrl/agent/dashboard`，进入创建 Agent 弹窗，查看模型下拉项是否带来源组织前缀，保存后引用值是否优先使用稳定 `sourceOrg/providerUid/modelId` 格式 → 是/否

### 场景 4：回归与跨 team 验收

#### - [x] 4.1 自动化测试矩阵与构建全部通过
- **来源:** spec-plan.md Task 5 / spec-design.md 非功能约束
- **目的:** 确认改造无整体回归
- **操作步骤:**
  1. [A] `bun run precheck` → 期望包含: `Checked`
  2. [A] `bun test src/__tests__/resource-permission-service.test.ts src/__tests__/config-skill-resource-access.test.ts src/__tests__/config-mcp-resource-access.test.ts src/__tests__/config-provider-resource-access.test.ts src/__tests__/model-provider-access.test.ts` → 期望包含: `pass`
  3. [A] `bun test src/__tests__/skill-resource-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts src/__tests__/launch-spec-provider-model-access.test.ts src/__tests__/workflow-provider-model-access.test.ts` → 期望包含: `pass`
  4. [A] `bun test web/src/__tests__/skill-resource-access-flow.test.ts web/src/__tests__/mcp-resource-access-flow.test.ts web/src/__tests__/provider-model-resource-access-flow.test.ts` → 期望包含: `pass`
  5. [A] `bun run build:web` → 期望包含: `dist`

#### - [x] 4.2 手动跨 team 场景符合只读共享预期
- **来源:** spec-plan.md Task 5 / spec-design.md §6.2/§6.3/§8
- **目的:** 确认端到端共享行为正确
- **操作步骤:**
  1. [H] 打开 `http://localhost:5173/ctrl/agent/models`，在 org-a 将 provider 设为公开后切换到 org-b，查看外部 provider 是否可见、详情可查看、公开开关与编辑删除测试按钮不可用 → 是/否（已通过）
  2. [H] 打开 `http://localhost:5173/ctrl/agent/skills`，切换到 org-b，查看外部 skill 是否可见且只读，可被 Agent 配置引用 → 是/否（已通过）
  3. [H] 打开 `http://localhost:5173/ctrl/agent/mcp`，切换到 org-b，查看外部 MCP 是否可见且只读，可被 Agent 配置引用 → 是/否（已通过）

---

## 验收后清理

- [x] [AUTO] 终止后台服务 [后端 dev]: `kill $PID_BACKEND`
- [x] [AUTO] 终止后台服务 [前端 dev:web]: `kill $PID_WEB`

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | Provider service 可见集合与只读保护 | 2 | 0 | ✅ |
| 场景 1 | 1.2 | Model 继承 Provider 授权并校验引用 | 3 | 0 | ✅ |
| 场景 2 | 2.1 | 聚合入口与 LaunchSpec 支持外部模型 | 3 | 0 | ✅ |
| 场景 2 | 2.2 | 原资源 API 承载权限能力 | 2 | 0 | ✅ |
| 场景 3 | 3.1 | 页面区分内部外部公开资源 | 1 | 1 | ✅ |
| 场景 3 | 3.2 | 外部 Provider/Model 隐藏写操作 | 1 | 1 | ✅ |
| 场景 3 | 3.3 | Agent 选择稳定模型引用 | 1 | 1 | ✅ |
| 场景 4 | 4.1 | 自动化矩阵与构建通过 | 5 | 0 | ✅ |
| 场景 4 | 4.2 | 跨 team 只读共享端到端正常 | 0 | 3 | ✅ |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
