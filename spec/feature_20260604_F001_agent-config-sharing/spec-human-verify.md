# agent-config-sharing 人工验收清单

**生成时间:** 2026-06-04 01:18
**关联计划:** `spec/feature_20260604_F001_agent-config-sharing/spec-plan.md`
**关联设计:** `spec/feature_20260604_F001_agent-config-sharing/spec-design.md`

---

## 验收前准备

### 环境要求
- [x] [AUTO] 检查 Bun 运行时: `bun --version` → 期望包含: `1.`
- [x] [AUTO] 检查后端基础测试入口: `bun test src/__tests__/agent-config-validators.test.ts` → 期望包含: `pass`
- [x] [AUTO] 检查前端构建链路: `bun run build:web` → 期望包含: `built in`
- [x] [AUTO/SERVICE] 启动后端开发服务: `bun run dev` (port: 3000)
- [x] [AUTO/SERVICE] 启动前端开发服务: `bun run dev:web` (port: 5173)

### 测试数据准备
- [x] [MANUAL] 准备两个组织：`source` 组织内存在一个已公开的 Agent，且该 Agent 绑定未公开的 `provider` / `skill` / `mcp_server`；`consumer` 组织用于读取、绑定并启动该共享 Agent
- [x] [MANUAL] 确认当前浏览器已登录 `consumer` 组织，并能在组织切换器中切换到 `source` / `consumer`

---

## 验收项目

### 场景 1：权限模型与 Agent 共享读写规则

#### - [x] 1.1 `agent_config` 已接入资源公开权限模型
- **来源:** `spec-plan.md` Task 1 / `spec-design.md` §2
- **目的:** 确认权限基础设施生效
- **操作步骤:**
  1. [A] `bun test src/__tests__/resource-permission-agent-config.test.ts src/__tests__/config-agent-resource-access.test.ts` → 期望包含: `pass`
  2. [A] `rg -n 'agent_config' src/db/schema.ts src/repositories/resource-permission.ts src/services/config/agent-config.ts` → 期望包含: `agent_config`

#### - [x] 1.2 `/web/config/agents` 已支持共享可读、外部只读
- **来源:** `spec-plan.md` Task 2 / `spec-design.md` §3
- **目的:** 确认 Agent 路由权限正确
- **操作步骤:**
  1. [A] `bun test src/__tests__/config-integration.test.ts` → 期望包含: `pass`
  2. [A] `rg -n 'resourceAccess|publicReadable|assertAgentConfigInternalWritable' src/routes/web/config/agents.ts` → 期望包含: `resourceAccess`

### 场景 2：Environment 绑定共享 Agent

#### - [x] 2.1 当前组织可以绑定可读的外部共享 Agent
- **来源:** `spec-plan.md` Task 3 / `spec-design.md` §4
- **目的:** 确认共享 Agent 可被绑定
- **操作步骤:**
  1. [A] `bun test src/__tests__/environment-shared-agent-access.test.ts` → 期望包含: `pass`
  2. [A] `rg -n 'getReadableAgentConfigById' src/services/environment-web.ts src/services/instance.ts` → 期望包含: `getReadableAgentConfigById`

### 场景 3：启动链路可穿透解析私有依赖

#### - [x] 3.1 LaunchSpec 聚合时按共享 Agent 源组织解析依赖
- **来源:** `spec-plan.md` Task 3 / `spec-design.md` §5
- **目的:** 确认运行时依赖可用
- **操作步骤:**
  1. [A] `bun test src/__tests__/launch-spec-agent-sharing-access.test.ts` → 期望包含: `pass`
  2. [A] `rg -n 'sourceCtx|agentConfigSkill|getAgentFullConfig' src/services/config/aggregate.ts` → 期望包含: `sourceCtx`

#### - [x] 3.2 绑定共享 Agent 后仍不放大私有依赖管理权限
- **来源:** `spec-design.md` §5 / §6 / 验收标准
- **目的:** 确认只开放使用权
- **操作步骤:**
  1. [A] `bun test src/__tests__/environment-shared-agent-access.test.ts src/__tests__/launch-spec-agent-sharing-access.test.ts` → 期望包含: `pass`
  2. [A] `bun test src/__tests__/config-integration.test.ts` → 期望包含: `FORBIDDEN`

### 场景 4：前端共享 Agent 只读交互

#### - [x] 4.1 前端类型与共享访问辅助逻辑已覆盖同名冲突和只读判断
- **来源:** `spec-plan.md` Task 4 / `spec-design.md` §8
- **目的:** 确认前端逻辑稳定
- **操作步骤:**
  1. [A] `bun test web/src/__tests__/agent-resource-access-flow.test.ts web/src/__tests__/config-types.test.ts web/src/__tests__/config-agents-page.test.ts` → 期望包含: `pass`
  2. [A] `rg -n 'resourceAccess|publicReadable|getAgentOptionValue|isAgentWritable' packages/sdk/src/types/schemas.ts web/src/types/config.ts web/src/lib/agent-resource-access.ts` → 期望包含: `resourceAccess`

#### - [ ] 4.2 共享 Agent 在侧边栏显示来源组织且不可编辑
- **来源:** `spec-plan.md` Task 4 / `spec-design.md` §8
- **目的:** 确认共享 Agent 只读呈现
- **操作步骤:**
  1. [H] 打开 `http://localhost:5173/ctrl/agent/dashboard`，查看左侧 Agent 树中共享 Agent 是否显示来源组织标识或来源文案 → 是/否
  2. [H] 在同一页面打开该共享 Agent 的详情/编辑入口，查看表单字段、skills、knowledge、machine 与保存入口是否为只读或禁用态 → 是/否

### 场景 5：整体回归与构建结果

#### - [ ] 5.1 完整质量检查无回归
- **来源:** `spec-plan.md` Task 5 / `spec-design.md` 验收标准
- **目的:** 确认整体实现稳定
- **操作步骤:**
  1. [A] `bun run precheck` → 期望包含: `Checked`

#### - [ ] 5.2 前端构建产物可正常生成
- **来源:** `spec-plan.md` Task 5 / `spec-design.md` 约束一致性
- **目的:** 确认交付产物可用
- **操作步骤:**
  1. [A] `bun run build:web` → 期望包含: `built in`

---

## 验收后清理

- [ ] [AUTO] 终止后台服务 [后端 dev]: `kill $BACKEND_PID`
- [ ] [AUTO] 终止后台服务 [前端 dev:web]: `kill $FRONTEND_PID`

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | `agent_config` 权限模型接入 | 2 | 0 | ✅ |
| 场景 1 | 1.2 | Agent 路由共享可读外部只读 | 2 | 0 | ✅ |
| 场景 2 | 2.1 | Environment 可绑定共享 Agent | 2 | 0 | ✅ |
| 场景 3 | 3.1 | LaunchSpec 直连解析依赖 | 2 | 0 | ✅ |
| 场景 3 | 3.2 | 私有依赖权限不外溢 | 2 | 0 | ✅ |
| 场景 4 | 4.1 | 前端共享访问逻辑通过 | 2 | 0 | ✅ |
| 场景 4 | 4.2 | 共享 Agent 来源展示且只读 | 0 | 2 | ⬜ |
| 场景 5 | 5.1 | 完整质量检查通过 | 1 | 0 | ⬜ |
| 场景 5 | 5.2 | 前端构建产物生成成功 | 1 | 0 | ⬜ |

**验收结论:** ⬜ 全部通过 / ⬜ 存在问题
