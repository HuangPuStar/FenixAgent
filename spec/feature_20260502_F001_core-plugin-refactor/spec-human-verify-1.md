# core-plugin-refactor（阶段一）人工验收清单

**生成时间:** 2026-05-07 21:44
**关联计划:** `spec/feature_20260502_F001_core-plugin-refactor/spec-plan-1.md`
**关联设计:** `spec/feature_20260502_F001_core-plugin-refactor/spec-design.md`

---

## 验收前准备

### 环境要求
- [x] [AUTO] 检查 Bun 运行时可用: `cd /Users/liyuan/Work/mothership-beta && bun --version`
- [x] [AUTO] 检查 mothership workspace 类型检查通过: `cd /Users/liyuan/Work/mothership-beta/mothership && bun run typecheck`
- [x] [AUTO] 检查 mothership workspace 测试通过: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test`

### 测试数据准备
- [x] 无需额外测试数据；全部验收项基于静态结构与单元测试结果

---

## 验收项目

### 场景 1：独立 workspace 骨架

#### - [x] 1.1 workspace 根配置存在且包含统一脚本
- **来源:** `spec-plan-1.md` Task 1 检查步骤 / `spec-design.md` §一
- **目的:** 确认独立工程入口完整
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && test -f mothership/package.json && test -f mothership/tsconfig.base.json && echo ok` → 期望精确: ok
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n '"workspaces"|"build"|"typecheck"|"test"' mothership/package.json` → 期望包含: "workspaces"

#### - [x] 1.2 目录结构符合 apps/packages/plugins 分层
- **来源:** `spec-plan-1.md` Task 4 端到端验证 2 / `spec-design.md` §一
- **目的:** 确认工程物理分层正确
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort` → 期望包含: mothership/apps/server
  2. [A] `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort` → 期望包含: mothership/apps/web
  3. [A] `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort` → 期望包含: mothership/packages/core
  4. [A] `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort` → 期望包含: mothership/packages/plugin-sdk
  5. [A] `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort` → 期望包含: mothership/plugins/opencode

### 场景 2：独立 server 占位入口

#### - [x] 2.1 Hono app 暴露 `/health` 与 `/version`
- **来源:** `spec-plan-1.md` Task 1 执行步骤 / `spec-design.md` §五.1
- **目的:** 确认独立 server 可被组合
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "createApp|/health|/version" mothership/apps/server/src` → 期望包含: createApp
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/server/src/__tests__/health.test.ts` → 期望包含: 2 pass

#### - [x] 2.2 `/version` 返回 mothership 元信息
- **来源:** `spec-plan-1.md` Task 1 测试场景 / `spec-design.md` §五.1
- **目的:** 确认 server 占位元信息稳定
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n 'name: "mothership"|version: "0.1.0"' mothership/apps/server/src/app.ts` → 期望包含: name: "mothership"

### 场景 3：Core 与 SDK 基础契约

#### - [x] 3.1 plugin-sdk 暴露 provider 主接口与宿主上下文
- **来源:** `spec-plan-1.md` Task 2 检查步骤 / `spec-design.md` §三
- **目的:** 确认 provider 契约可被消费
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "export interface ProviderPlugin|export interface ProviderRuntime|ProviderRuntimeContext" mothership/packages/plugin-sdk/src` → 期望包含: export interface ProviderPlugin

#### - [x] 3.2 core 暴露强类型 ID、Registry 与 RuntimeConfigResolver
- **来源:** `spec-plan-1.md` Task 2-3 检查步骤 / `spec-design.md` §二、§四
- **目的:** 确认 Core 公共 API 已收敛
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "export .*EnvironmentId|export .*PluginRegistry|RuntimeConfigResolver" mothership/packages/core/src/index.ts` → 期望包含: export { PluginRegistry }
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "EnvironmentId|InstanceId|ProviderSessionId|AgentRuntimeSpec" mothership/packages/core/src` → 期望包含: AgentRuntimeSpec

### 场景 4：运行时配置与阶段一回归

#### - [x] 4.1 RuntimeConfigResolver 能解析统一运行时配置
- **来源:** `spec-plan-1.md` Task 3 测试场景 / `spec-design.md` §二.3
- **目的:** 确认平台配置解析链路成立
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test packages/core/src/__tests__/runtime-config-resolver.test.ts` → 期望包含: pass

#### - [x] 4.2 README 已说明 mothership 的功能定位与模块组成
- **来源:** `spec-plan-1.md` Task 1 执行步骤 / `spec-design.md` §一
- **目的:** 确认工程说明可读
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "agent provider|apps/server|packages/core|plugins/opencode" mothership/README.md` → 期望包含: agent provider

#### - [x] 4.3 阶段一完整测试套件通过
- **来源:** `spec-plan-1.md` Task 4 端到端验证 1 / `spec-design.md` 非功能约束
- **目的:** 确认阶段一产物无回归
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test` → 期望包含: 0 fail

---

## 验收后清理

- [x] 无需清理；本清单未启动长期后台服务

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | workspace 根配置存在且包含统一脚本 | 2 | 0 | ✅ |
| 场景 1 | 1.2 | 目录结构符合 apps/packages/plugins 分层 | 5 | 0 | ✅ |
| 场景 2 | 2.1 | Hono app 暴露 `/health` 与 `/version` | 2 | 0 | ✅ |
| 场景 2 | 2.2 | `/version` 返回 mothership 元信息 | 1 | 0 | ✅ |
| 场景 3 | 3.1 | plugin-sdk 暴露 provider 主接口与宿主上下文 | 1 | 0 | ✅ |
| 场景 3 | 3.2 | core 暴露强类型 ID、Registry 与 RuntimeConfigResolver | 2 | 0 | ✅ |
| 场景 4 | 4.1 | RuntimeConfigResolver 能解析统一运行时配置 | 1 | 0 | ✅ |
| 场景 4 | 4.2 | README 已说明 mothership 的功能定位与模块组成 | 1 | 0 | ✅ |
| 场景 4 | 4.3 | 阶段一完整测试套件通过 | 1 | 0 | ✅ |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
