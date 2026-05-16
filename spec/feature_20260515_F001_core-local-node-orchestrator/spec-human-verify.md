# core-local-node-orchestrator 人工验收清单

**生成时间:** 2026-05-15 16:41
**关联计划:** `spec/feature_20260515_F001_core-local-node-orchestrator/spec-plan.md`
**关联设计:** `spec/feature_20260515_F001_core-local-node-orchestrator/spec-design.md`

---

## 验收前准备

### 环境要求
- [x] [AUTO] 检查 Bun 可用: `cd /Users/liyuan/Work/mothership-beta_new && bun --version`
- [x] [AUTO] 检查 `packages/core` TypeScript 配置可解析: `cd /Users/liyuan/Work/mothership-beta_new && bunx tsc -p packages/core/tsconfig.json --showConfig >/dev/null`
- [x] [MANUAL] 如需执行真实链路联调，按 `packages/core/integration/README.md` 准备 `core-runtime.local.json`，填入真实 `launchSpec.workspace`、模型参数、密钥和 `relay.requestMessages`

### 测试数据准备
- [x] 默认使用 `packages/core/integration/core-runtime.conf.json` 验证”入口存在且默认关闭”
- [x] 如执行真实链路，确认 `engineType = “opencode”`、`nodeId = “local-default”`，且 `successMatch` 能匹配目标响应

---

## 验收项目

### 场景 1：工程边界与公开导出

#### - [x] 1.1 `packages/core` 能独立通过类型检查
- **来源:** spec-plan.md Task 5.2 / spec-design.md 验收标准
- **目的:** 确认包级类型边界稳定
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new/packages/core && bun run typecheck` → 期望包含: Exited with code 0

#### - [x] 1.2 公开导出面受控且未泄漏 orchestrator 内部实现
- **来源:** spec-plan.md Task 4 检查步骤 / spec-design.md §九
- **目的:** 确认 facade 是唯一主入口
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new && rg -n "createCoreRuntime|EnginePluginRegistry|CoreNodeRegistry|createRuntimeInstanceStore|createInstanceOrchestrator|RuntimeInstanceRuntimeEntry" packages/core/src/index.ts` → 期望包含: createCoreRuntime
  2. [A] `cd /Users/liyuan/Work/mothership-beta_new && bash -lc 'if rg -q "export .*createInstanceOrchestrator|export .*RuntimeInstanceRuntimeEntry" packages/core/src/index.ts; then echo leaked; else echo ok; fi'` → 期望精确: ok

### 场景 2：单元测试覆盖核心编排闭环

#### - [x] 2.1 `packages/core` 全量单元测试通过且无回归
- **来源:** spec-plan.md Task 5.1 / spec-design.md §八
- **目的:** 确认核心模块整体可用
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new/packages/core && bun test` → 期望包含: pass

#### - [x] 2.2 生命周期编排测试覆盖 `launch -> connectRelay -> stop`
- **来源:** spec-plan.md Task 5.4 / spec-design.md 验收标准
- **目的:** 确认最小编排闭环落地
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new && bun test packages/core/src/__tests__/instance-orchestrator.test.ts packages/core/src/__tests__/core-runtime.test.ts` → 期望包含: pass

#### - [x] 2.3 异常路径与幂等约束已被测试显式覆盖
- **来源:** spec-plan.md Task 3 测试场景 / spec-design.md §六
- **目的:** 确认边界行为可回归
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new && rg -n "INSTANCE_ALREADY_EXISTS|PLUGIN_NOT_FOUND|NODE_OFFLINE|ENGINE_NOT_SUPPORTED|INVALID_INSTANCE_STATE|failOnConnectRelay|failOnStop|stopped" packages/core/src/__tests__/instance-orchestrator.test.ts` → 期望包含: INVALID_INSTANCE_STATE

### 场景 3：integration 入口可发现且默认关闭

#### - [x] 3.1 integration 目录结构与模板配置完整
- **来源:** spec-plan.md Task 4 检查步骤 / spec-design.md §九
- **目的:** 确认手动联调入口齐备
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new && find packages/core/integration -maxdepth 1 -type f | sort` → 期望包含: packages/core/integration/core-runtime.integration.test.ts
  2. [A] `cd /Users/liyuan/Work/mothership-beta_new && rg -n "\"enabled\": false|createEnginePlugin|registerPlugin|local-default|launchInstance|connectInstanceRelay|stopInstance" packages/core/integration` → 期望包含: "enabled": false

#### - [x] 3.2 默认配置下真实链路测试会跳过，不进入常规 CI 语义
- **来源:** spec-plan.md Task 4 执行步骤 / spec-design.md §9.5
- **目的:** 确认默认关闭策略生效
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new/packages/core/integration && bun test ./core-runtime.integration.test.ts` → 期望包含: skip

### 场景 4：真实插件链路可通过 facade 跑通

#### - [x] 4.1 启用本地私有配置后，真实链路按预期阶段推进
- **来源:** spec-plan.md Task 5.6 / spec-design.md §9.3 §9.4
- **目的:** 确认 facade 未破坏真实插件集成
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta_new && bash -lc 'test -f packages/core/integration/core-runtime.local.json && rg -q "\"enabled\"\\s*:\\s*true" packages/core/integration/core-runtime.local.json && echo enabled'` → 期望精确: enabled
  2. [A] `cd /Users/liyuan/Work/mothership-beta_new/packages/core/integration && bun test ./core-runtime.integration.test.ts` → 期望包含: waitForExpectedResponse:ok
  3. [A] `cd /Users/liyuan/Work/mothership-beta_new/packages/core/integration && bun test ./core-runtime.integration.test.ts` → 期望包含: stopInstance:ok

---

## 验收后清理

- [x] [AUTO] 本清单未启动后台常驻服务，无额外清理命令

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | `packages/core` 能独立通过类型检查 | 1 | 0 | ✅ 通过 |
| 场景 1 | 1.2 | 公开导出面受控且未泄漏 orchestrator 内部实现 | 2 | 0 | ✅ 通过 |
| 场景 2 | 2.1 | `packages/core` 全量单元测试通过且无回归 | 1 | 0 | ✅ 通过 |
| 场景 2 | 2.2 | 生命周期编排测试覆盖 `launch -> connectRelay -> stop` | 1 | 0 | ✅ 通过 |
| 场景 2 | 2.3 | 异常路径与幂等约束已被测试显式覆盖 | 1 | 0 | ✅ 通过 |
| 场景 3 | 3.1 | integration 目录结构与模板配置完整 | 2 | 0 | ✅ 通过 |
| 场景 3 | 3.2 | 默认配置下真实链路测试会跳过，不进入常规 CI 语义 | 1 | 0 | ✅ 通过 |
| 场景 4 | 4.1 | 启用本地私有配置后，真实链路按预期阶段推进 | 3 | 0 | ✅ 通过（修复后通过） |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
