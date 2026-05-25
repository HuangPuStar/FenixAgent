# core-plugin-refactor（阶段二：Core 服务与 opencode 插件迁移）人工验收清单

**生成时间:** 2026-05-08 14:08
**关联计划:** `spec/feature_20260502_F001_core-plugin-refactor/spec-plan-2.md`
**关联设计:** `spec/feature_20260502_F001_core-plugin-refactor/spec-design.md`

---

## 验收前准备

### 环境要求
- [x] [AUTO] 检查 Bun 运行时可用: `cd /Users/liyuan/Work/mothership-beta && bun --version`
- [x] [AUTO] 检查 mothership workspace 依赖可解析: `cd /Users/liyuan/Work/mothership-beta/mothership && bun install`
- [x] [AUTO] 检查阶段二完整测试套件通过: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test`

### 测试数据准备
- [x] 无需额外测试数据；本清单基于代码结构检查与单元测试结果完成验收

---

## 验收项目

所有验收项均可自动化验证，无需人类参与。仍将生成清单用于自动执行。

### 场景 1：Core 服务编排落地

#### - [x] 1.1 Core 服务与门面类已公开导出
- **来源:** `spec-plan-2.md` Task 5 检查步骤 / `spec-design.md` §二.1、§五.1
- **目的:** 确认 Core 统一入口稳定
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "class EnvironmentService|class InstanceService|class RelayOrchestrator|class CoreFacade" mothership/packages/core/src` → 期望包含: class CoreFacade
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "EnvironmentService|SessionService|InstanceService|RelayOrchestrator|CoreFacade" mothership/packages/core/src/index.ts` → 期望包含: CoreFacade

#### - [x] 1.2 实例启动链路按抽象接口顺序编排
- **来源:** `spec-plan-2.md` Task 5 检查步骤 / `spec-design.md` §五.3
- **目的:** 确认先抽象后搬运
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "prepareEnvironment|injectRuntimeConfig|startInstance" mothership/packages/core/src/services/instance-service.ts` → 期望包含: prepareEnvironment
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test packages/core/src/__tests__/instance-service.test.ts packages/core/src/__tests__/relay-orchestrator.test.ts` → 期望包含: pass

#### - [x] 1.3 Relay 编排仅通过 session 与 instance 路由
- **来源:** `spec-plan-2.md` Task 5 执行步骤 / `spec-design.md` §五.2
- **目的:** 确认 Core 不承接私有协议
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "connect\\(sessionId|disconnect\\(relayId|instanceId" mothership/packages/core/src/services/relay-orchestrator.ts` → 期望包含: disconnect(relayId
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test packages/core/src/__tests__/relay-orchestrator.test.ts` → 期望包含: pass

### 场景 2：opencode 私有配置翻译与注入

#### - [x] 2.1 opencode 私有运行时配置类型未泄漏到 Core
- **来源:** `spec-plan-2.md` Task 6 检查步骤 / `spec-design.md` §二.2、§五.3
- **目的:** 确认 provider 边界清晰
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "OpencodeRuntimeConfig" mothership/plugins/opencode mothership/packages/core` → 期望包含: mothership/plugins/opencode
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "OpencodeRuntimeConfig" mothership/packages/core | wc -l | tr -d ' '` → 期望精确: 0

#### - [x] 2.2 注入器固定写入 `.opencode/opencode.json`
- **来源:** `spec-plan-2.md` Task 6 检查步骤 / `spec-design.md` §五.3
- **目的:** 确认 provider 私有落盘稳定
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "\\.opencode/opencode\\.json|default_agent|mcp" mothership/plugins/opencode/src/runtime` → 期望包含: .opencode/opencode.json
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test plugins/opencode/src/__tests__/opencode-config-writer.test.ts` → 期望包含: pass

#### - [x] 2.3 Provider 私有映射只消费 `mcpServers`
- **来源:** `spec-plan-2.md` Task 6 测试场景 / `spec-design.md` §二.3、§五.3
- **目的:** 确认知识库能力未误入插件
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "mcpServers|knowledgeBindings" mothership/plugins/opencode/src/runtime mothership/plugins/opencode/src/__tests__/opencode-config-writer.test.ts` → 期望包含: knowledgeBindings
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test plugins/opencode/src/__tests__/opencode-config-writer.test.ts` → 期望包含: pass

### 场景 3：opencode 运行时与 relay 迁移

#### - [x] 3.1 `acp-link` 进程管理迁入插件包
- **来源:** `spec-plan-2.md` Task 7 检查步骤 / `spec-design.md` §六
- **目的:** 确认私有行为完成收口
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "Token:\\\\s\\*\\(\\[a-f0-9\\]\\{64\\}\\)|SIGTERM|SIGKILL|keep_alive" mothership/plugins/opencode/src` → 期望包含: SIGTERM
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test plugins/opencode/src/__tests__/acp-link-process-manager.test.ts` → 期望包含: pass

#### - [x] 3.2 `ProviderPlugin` 实现了完整运行时能力
- **来源:** `spec-plan-2.md` Task 7 检查步骤 / `spec-design.md` §三.2、§六
- **目的:** 确认插件主入口完整
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "prepareEnvironment|injectRuntimeConfig|startInstance|stopInstance|connectRelay" mothership/plugins/opencode/src/opencode-plugin.ts` → 期望包含: connectRelay
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "createOpencodePlugin" mothership/plugins/opencode/src/index.ts mothership/plugins/opencode/src/opencode-plugin.ts` → 期望包含: createOpencodePlugin

#### - [x] 3.3 relay 过滤 `keep_alive` 且前端断连不杀进程
- **来源:** `spec-plan-2.md` Task 7 测试场景 / `spec-design.md` §五.2、§六
- **目的:** 确认 relay 生命周期兼容
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test plugins/opencode/src/__tests__/opencode-relay-handle.test.ts` → 期望包含: pass
  2. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "keep_alive|disconnect|close" mothership/plugins/opencode/src/relay/opencode-relay-handle.ts` → 期望包含: keep_alive

### 场景 4：阶段二集成回归

#### - [x] 4.1 阶段二完整测试套件通过
- **来源:** `spec-plan-2.md` Task 8 验证 1 / `spec-design.md` §实现要点 6
- **目的:** 确认迁移结果无回归
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test` → 期望包含: 0 fail

#### - [x] 4.2 Core 与 server 不再包含 opencode 私有实现
- **来源:** `spec-plan-2.md` Task 8 验证 2 / `spec-design.md` §二.2、§实现要点 3
- **目的:** 确认分层边界已收紧
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "opencode\\.json|Token:\\s*\\(|acp-link --host" mothership/packages/core mothership/apps/server | wc -l | tr -d ' '` → 期望精确: 0

#### - [x] 4.3 Core 通过 PluginRegistry 驱动实例启动
- **来源:** `spec-plan-2.md` Task 8 验证 3 / `spec-design.md` §三.2、§五.1
- **目的:** 确认核心编排依赖接口
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && bun test mothership/packages/core/src/__tests__/instance-service.test.ts` → 期望包含: pass

#### - [x] 4.4 opencode relay 不向前端透传 `keep_alive`
- **来源:** `spec-plan-2.md` Task 8 验证 4 / `spec-design.md` §五.2、§六
- **目的:** 确认协议兼容仍成立
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && bun test mothership/plugins/opencode/src/__tests__/opencode-relay-handle.test.ts` → 期望包含: pass

### 场景 5：边界与回归

#### - [x] 5.1 统一 ID 模型仍显式区分平台与 provider 会话
- **来源:** `spec-design.md` §四.3、§实现要点 4
- **目的:** 确认旧问题不会复发
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "providerSessionId|sessionId" mothership/packages/core mothership/plugins/opencode/src/session` → 期望包含: providerSessionId

#### - [x] 5.2 新功能继续限定在 `mothership/` 内演进
- **来源:** `spec-design.md` §七 双轨并行的硬约束
- **目的:** 确认迁移冻结线明确
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta && rg -n "legacy|src/services/instance.ts|src/transport/acp-relay-handler.ts|src/transport/acp-ws-handler.ts" spec/feature_20260502_F001_core-plugin-refactor/spec-plan-2.md` → 期望包含: 不再回头修改 legacy

---

## 验收后清理

- [x] [AUTO] 无需清理；本清单未启动长期后台服务

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | Core 服务与门面类已公开导出 | 2 | 0 | ✅ |
| 场景 1 | 1.2 | 实例启动链路按抽象接口顺序编排 | 2 | 0 | ✅ |
| 场景 1 | 1.3 | Relay 编排仅通过 session 与 instance 路由 | 2 | 0 | ✅ |
| 场景 2 | 2.1 | opencode 私有运行时配置类型未泄漏到 Core | 2 | 0 | ✅ |
| 场景 2 | 2.2 | 注入器固定写入 `.opencode/opencode.json` | 2 | 0 | ✅ |
| 场景 2 | 2.3 | Provider 私有映射只消费 `mcpServers` | 2 | 0 | ✅ |
| 场景 3 | 3.1 | `acp-link` 进程管理迁入插件包 | 2 | 0 | ✅ |
| 场景 3 | 3.2 | `ProviderPlugin` 实现了完整运行时能力 | 2 | 0 | ✅ |
| 场景 3 | 3.3 | relay 过滤 `keep_alive` 且前端断连不杀进程 | 2 | 0 | ✅ |
| 场景 4 | 4.1 | 阶段二完整测试套件通过 | 1 | 0 | ✅ |
| 场景 4 | 4.2 | Core 与 server 不再包含 opencode 私有实现 | 1 | 0 | ✅ |
| 场景 4 | 4.3 | Core 通过 PluginRegistry 驱动实例启动 | 1 | 0 | ✅ |
| 场景 4 | 4.4 | opencode relay 不向前端透传 `keep_alive` | 1 | 0 | ✅ |
| 场景 5 | 5.1 | 统一 ID 模型仍显式区分平台与 provider 会话 | 1 | 0 | ✅ |
| 场景 5 | 5.2 | 新功能继续限定在 `mothership/` 内演进 | 1 | 0 | ✅ |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
