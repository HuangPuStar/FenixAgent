# core-plugin-refactor（阶段三：Server/Web 接管、命名规范与总验收）人工验收清单

**生成时间:** 2026-05-09 09:25
**关联计划:** `spec/feature_20260502_F001_core-plugin-refactor/spec-plan-3.md`
**关联设计:** `spec/feature_20260502_F001_core-plugin-refactor/spec-design.md`

---

## 验收前准备

### 环境要求
- [ ] [AUTO] 检查 Bun 运行时可用: `cd /Users/liyuan/Work/mothership-beta && bun --version`
- [ ] [AUTO] 安装 mothership workspace 依赖: `cd /Users/liyuan/Work/mothership-beta/mothership && bun install`
- [ ] [AUTO] 编译 mothership workspace: `cd /Users/liyuan/Work/mothership-beta/mothership && bun run build`
- [ ] [AUTO] 检查 mothership workspace 类型通过: `cd /Users/liyuan/Work/mothership-beta/mothership && bun run typecheck`
- [ ] [AUTO/SERVICE] 启动独立 control plane server: `cd /Users/liyuan/Work/mothership-beta/mothership && bun run dev:server` (port: 4001)
- [ ] [AUTO/SERVICE] 启动独立 web 控制台: `cd /Users/liyuan/Work/mothership-beta/mothership && bun run dev:web` (port: 5173)

### 测试数据准备
- [ ] 使用仓库当前默认状态验收；若当前无 environment 数据，允许以空列表页面作为 UI 验收输入

---

## 验收项目

### 场景 1：Server composition layer 与路由装配

#### - [x] 1.1 server 装配层集中在 `bootstrap.ts`
- **来源:** `spec-plan-3.md` Task 9 检查步骤 / `spec-design.md` §五.1
- **目的:** 确认 server 只负责装配
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "createServerRuntime|PluginRegistry|createOpencodePlugin" mothership/apps/server/src` → 期望包含: createServerRuntime
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "createServerRuntime|createApp" mothership/apps/server/src/bootstrap.ts mothership/apps/server/src/app.ts` → 期望包含: createServerRuntime

#### - [x] 1.2 响应字段映射集中定义且统一为驼峰命名
- **来源:** `spec-plan-3.md` Task 9 检查步骤 / `spec-design.md` §七
- **目的:** 确认 API 响应字段规范稳定且无下划线混用
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "instanceId|instanceStatus|sessionId|instances" mothership/apps/server/src/http/response-mappers.ts mothership/apps/server/src/modules` → 期望包含: instanceStatus
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "instance_id|instance_status|session_id" mothership/apps/server/src/http/response-mappers.ts mothership/apps/server/src/modules | wc -l | tr -d ' '` → 期望精确: 0

#### - [x] 1.3 server 路由适配测试通过
- **来源:** `spec-plan-3.md` Task 9 测试场景 / `spec-design.md` §五.1、§五.2
- **目的:** 确认主链路适配可用
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/server/src/__tests__/environment-routes.test.ts apps/server/src/__tests__/relay-routes.test.ts` → 期望包含: pass
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n '"/acp"|"/web/environments"|"/v1/environments"' mothership/apps/server/src/app.ts` → 期望包含: "/web/environments"

### 场景 2：独立存储边界与配置入口

#### - [x] 2.1 默认数据库与配置路径不再指向 legacy
- **来源:** `spec-plan-3.md` Task 10 检查步骤 / `spec-design.md` §七 双轨并行的硬约束
- **目的:** 确认新工程物理隔离
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "mothership/data/db\\.sqlite|~/.config/mothership/config\\.json" mothership/apps/server/src/config/runtime-paths.ts` → 期望包含: mothership/data/db.sqlite
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "data/db\\.sqlite|~/.config/opencode/opencode\\.json" mothership/apps/server/src/config/runtime-paths.ts | wc -l | tr -d ' '` → 期望精确: 0

#### - [x] 2.2 控制面配置入口只读取新路径
- **来源:** `spec-plan-3.md` Task 10 检查步骤 / `spec-design.md` §二.3
- **目的:** 确认配置解析独立
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "MOTHERSHIP_CONFIG_PATH|config\\.json|DEFAULT_CONTROL_PLANE_CONFIG" mothership/apps/server/src/config/control-plane-config.ts mothership/apps/server/src/config/runtime-paths.ts` → 期望包含: MOTHERSHIP_CONFIG_PATH

#### - [x] 2.3 持久化仓储测试通过
- **来源:** `spec-plan-3.md` Task 10 测试场景 / `spec-design.md` §四、§实现要点 5
- **目的:** 确认核心状态可持久化
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/server/src/__tests__/runtime-paths.test.ts apps/server/src/__tests__/sqlite-repositories.test.ts` → 期望包含: pass

### 场景 3：最小 web 控制台与插件文档

#### - [x] 3.1 dashboard 入口与最小 API client 已接通
- **来源:** `spec-plan-3.md` Task 11 检查步骤 / `spec-design.md` §五.1、§Phase 3
- **目的:** 确认新前端能消费新 server
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "loadDashboardData|DashboardPage|VITE_MOTHERSHIP_BASE_URL|/web/environments|/acp/agents" mothership/apps/web/src` → 期望包含: loadDashboardData

#### - [x] 3.2 dashboard 页面可独立打开并显示最小控制台状态
- **来源:** `spec-plan-3.md` Task 11 执行步骤 / `spec-design.md` §Phase 3、§八
- **目的:** 确认最小控制台可见
- **操作步骤:**
  1. [H] 打开 `http://localhost:5173/`，确认页面出现 `Provider-aware control plane` 标题，且页面能显示 `Server health` 摘要卡；若当前无 environment，则出现 `No environments yet`，若有 environment，则出现 environment 卡片与实例状态 → 是/否

#### - [x] 3.3 插件开发文档已创建并说明边界
- **来源:** `spec-plan-3.md` Task 11 检查步骤 / `spec-design.md` §三、§六
- **目的:** 确认插件开发约束清晰
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && test -f mothership/plugins/opencode/README.md && test -f mothership/packages/plugin-sdk/README.md && echo ok` → 期望精确: ok
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "ProviderPlugin|ProviderRuntimeContext|multiInstance|acp-link|opencode.json|relay" mothership/plugins/opencode/README.md mothership/packages/plugin-sdk/README.md` → 期望包含: ProviderPlugin

#### - [x] 3.4 dashboard 单元测试通过
- **来源:** `spec-plan-3.md` Task 11 测试场景 / `spec-design.md` §八
- **目的:** 确认最小控制台无回归
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/web/src/__tests__/dashboard.test.tsx` → 期望包含: pass

### 场景 4：总回归与边界收口

#### - [x] 4.1 mothership 全量测试通过
- **来源:** `spec-plan-3.md` Task 12 验证 1 / `spec-design.md` §实现要点 6
- **目的:** 确认阶段三整体稳定
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test` → 期望包含: 0 fail

#### - [x] 4.2 新工程结构与 legacy 目录保持物理隔离
- **来源:** `spec-plan-3.md` Task 12 验证 2 / `spec-design.md` §一、§约束一致性
- **目的:** 确认双轨边界明确
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort` → 期望包含: mothership/apps/server
  2. [A] `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort` → 期望包含: mothership/apps/web
  3. [A] `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort` → 期望包含: mothership/packages/core
  4. [A] `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort` → 期望包含: mothership/packages/plugin-sdk
  5. [A] `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort` → 期望包含: mothership/plugins/opencode

#### - [x] 4.3 opencode 私有逻辑未回流到 core 或 server
- **来源:** `spec-plan-3.md` Task 12 验证 4 / `spec-design.md` §二.2、§实现要点 3
- **目的:** 确认 provider 边界未反弹
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "opencode\\.json|acp-link --host|Token:\\s*\\([a-f0-9]{64}\\)" mothership/packages/core mothership/apps/server | wc -l | tr -d ' '` → 期望精确: 0

#### - [x] 4.4 新 server 与 web 可独立构建且无 legacy 编译依赖
- **来源:** `spec-plan-3.md` Task 12 验证 6 / `spec-design.md` §一、§实现要点 1
- **目的:** 确认可独立运行验收
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun run build && bun run typecheck && echo ok` → 期望精确: ok

### 场景 5：边界与回归

#### - [x] 5.1 Core 与 plugin-sdk 边界在代码中可追踪
- **来源:** `spec-plan-3.md` Task 12 验证 3 / `spec-design.md` §二、§三
- **目的:** 确认职责拆分清晰
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "ProviderPlugin|ProviderRuntimeContext|AgentRuntimeSpec|PluginRegistry" mothership/packages mothership/plugins` → 期望包含: ProviderPlugin

#### - [x] 5.2 新工程路径策略已显式定义且不隐式共用 legacy 数据
- **来源:** `spec-plan-3.md` Task 12 验证 5 / `spec-design.md` §七 双轨并行的硬约束
- **目的:** 确认迁移策略可执行
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "MOTHERSHIP_DB_PATH|MOTHERSHIP_CONFIG_PATH|config\\.json|db\\.sqlite" mothership/apps/server/src` → 期望包含: MOTHERSHIP_DB_PATH

---

## 验收后清理

- [ ] [AUTO] 终止后台服务 [control plane server]: `kill $PID_SERVER` (对应准备阶段 `bun run dev:server`)
- [ ] [AUTO] 终止后台服务 [web 控制台]: `kill $PID_WEB` (对应准备阶段 `bun run dev:web`)

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | server 装配层集中在 `bootstrap.ts` | 2 | 0 | ✅ |
| 场景 1 | 1.2 | 响应字段映射集中定义且统一为驼峰命名 | 2 | 0 | ✅ |
| 场景 1 | 1.3 | server 路由适配测试通过 | 2 | 0 | ✅ |
| 场景 2 | 2.1 | 默认数据库与配置路径不再指向 legacy | 2 | 0 | ✅ |
| 场景 2 | 2.2 | 控制面配置入口只读取新路径 | 1 | 0 | ✅ |
| 场景 2 | 2.3 | 持久化仓储测试通过 | 1 | 0 | ✅ |
| 场景 3 | 3.1 | dashboard 入口与最小 API client 已接通 | 1 | 0 | ✅ |
| 场景 3 | 3.2 | dashboard 页面可独立打开并显示最小控制台状态 | 0 | 1 | ✅ |
| 场景 3 | 3.3 | 插件开发文档已创建并说明边界 | 2 | 0 | ✅ |
| 场景 3 | 3.4 | dashboard 单元测试通过 | 1 | 0 | ✅ |
| 场景 4 | 4.1 | mothership 全量测试通过 | 1 | 0 | ✅ |
| 场景 4 | 4.2 | 新工程结构与 legacy 目录保持物理隔离 | 5 | 0 | ✅ |
| 场景 4 | 4.3 | opencode 私有逻辑未回流到 core 或 server | 1 | 0 | ✅ |
| 场景 4 | 4.4 | 新 server 与 web 可独立构建且无 legacy 编译依赖 | 1 | 0 | ✅ |
| 场景 5 | 5.1 | Core 与 plugin-sdk 边界在代码中可追踪 | 1 | 0 | ✅ |
| 场景 5 | 5.2 | 新工程路径策略已显式定义且不隐式共用 legacy 数据 | 1 | 0 | ✅ |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
