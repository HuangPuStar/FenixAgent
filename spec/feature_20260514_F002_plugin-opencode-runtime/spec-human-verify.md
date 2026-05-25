# plugin-opencode-runtime 人工验收清单

**生成时间:** 2026-05-15 09:42
**关联计划:** `spec/feature_20260514_F002_plugin-opencode-runtime/spec-plan.md`
**关联设计:** `spec/feature_20260514_F002_plugin-opencode-runtime/spec-design.md`

---

所有验收项均可自动化验证，无需人类参与。仍保留清单格式，便于后续统一执行与记录。

## 验收前准备

### 环境要求
- [ ] [AUTO] 检查 Bun 可用: `bun --version`
- [ ] [AUTO] 检查根脚本入口可解析: `bun run typecheck --help >/dev/null`
- [ ] [AUTO] 检查 Bun test 基础入口: `bun test src/__tests__/executable.test.ts`

### 测试数据准备
- [ ] 使用测试内临时 workspace、mock spawn、mock WebSocket 与 mock skill zip 下载器，无需额外手工造数

---

## 验收项目

### 场景 1：插件入口与包解析

#### - [x] 1.1 插件入口导出稳定
- **来源:** spec-plan.md Task 1 / spec-design.md 三、plugin-opencode 内部结构
- **目的:** 确认公开入口可直接消费
- **操作步骤:**
  1. [A] `rg -n "export function createEnginePlugin|createRuntime\\(" packages/plugin-opencode/src/plugin.ts packages/plugin-opencode/src/index.ts` → 期望包含: createEnginePlugin

#### - [x] 1.2 插件测试与类型可通过
- **来源:** spec-plan.md Task 1、Task 6 / spec-design.md 目标
- **目的:** 确认包可被 workspace 解析
- **操作步骤:**
  1. [A] `bun test packages/plugin-opencode/src/__tests__/plugin.test.ts` → 期望包含: pass
  2. [A] `bunx tsc -p packages/plugin-opencode/tsconfig.json --noEmit` → 期望精确:

#### - [x] 1.3 整个 plugin-opencode 测试套件无回归
- **来源:** spec-plan.md Task 6-1 / spec-design.md 验收标准
- **目的:** 确认插件整体行为稳定
- **操作步骤:**
  1. [A] `bun test packages/plugin-opencode/src/__tests__/` → 期望包含: pass

### 场景 2：prepare 阶段物化运行时资源

#### - [x] 2.1 运行时配置映射入口存在
- **来源:** spec-plan.md Task 2 / spec-design.md 四.1、实现要点
- **目的:** 确认 launchSpec 映射已落地
- **操作步骤:**
  1. [A] `rg -n "buildOpencodeRuntimeConfig|default_agent|mcpServers" packages/plugin-opencode/src/runtime/runtime-config.ts` → 期望包含: default_agent

#### - [x] 2.2 workspace 写入路径固定为 .opencode 与根目录 .env
- **来源:** spec-plan.md Task 2 / spec-design.md 四.1、实现要点
- **目的:** 确认文件写入路径正确
- **操作步骤:**
  1. [A] `rg -n "\\.opencode/opencode\\.json|\\.env|prepareWorkspaceEnvironment" packages/plugin-opencode/src/runtime/environment-preparer.ts packages/plugin-opencode/src/runtime/opencode-runtime.ts` → 期望包含: .env

#### - [x] 2.3 prepare 阶段会生成并覆盖运行时文件
- **来源:** spec-plan.md Task 2、Task 6-3 / spec-design.md 四.1、七
- **目的:** 确认环境准备主流程生效
- **操作步骤:**
  1. [A] `bun test packages/plugin-opencode/src/__tests__/environment-preparer.test.ts packages/plugin-opencode/src/__tests__/skill-installer.test.ts packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts` → 期望包含: pass

### 场景 3：进程管理与 relay 生命周期

#### - [x] 3.1 端口分配器已独立并支持释放
- **来源:** spec-plan.md Task 3 / spec-design.md 三、四.2
- **目的:** 确认本地端口策略可复用
- **操作步骤:**
  1. [A] `rg -n "PORT_MIN|PORT_MAX|allocate\\(|release\\(" packages/plugin-opencode/src/process/port-allocator.ts` → 期望包含: allocate

#### - [x] 3.2 进程管理器包含 token 捕获与双阶段终止
- **来源:** spec-plan.md Task 3 / spec-design.md 四.2、实现要点
- **目的:** 确认本地 acp-link 生命周期完整
- **操作步骤:**
  1. [A] `rg -n "Token:\\\\s\\*\\(\\[a-f0-9\\]\\{64\\}\\)|SIGTERM|SIGKILL|resolveExecutable\\(\"acp-link\"\\)" packages/plugin-opencode/src/process/acp-link-process-manager.ts` → 期望包含: SIGTERM

#### - [x] 3.3 relay 具备共享连接与噪音过滤
- **来源:** spec-plan.md Task 4 / spec-design.md 四.3
- **目的:** 确认 relay 不透传噪音消息
- **操作步骤:**
  1. [A] `rg -n "keep_alive|pong|state: \\\"open\\\"|close\\(|send\\(" packages/plugin-opencode/src/relay/relay-handle.ts` → 期望包含: keep_alive
  2. [A] `rg -n "connectRelay\\(|running|ws://127\\.0\\.0\\.1" packages/plugin-opencode/src/runtime/opencode-runtime.ts` → 期望包含: ws://127.0.0.1

#### - [x] 3.4 prepare/start/connect/stop 主流程串通
- **来源:** spec-plan.md Task 4、Task 6-4 / spec-design.md 四.2、四.3、四.4、七
- **目的:** 确认 runtime 生命周期闭环
- **操作步骤:**
  1. [A] `bun test packages/plugin-opencode/src/__tests__/port-allocator.test.ts packages/plugin-opencode/src/__tests__/acp-link-process-manager.test.ts packages/plugin-opencode/src/__tests__/relay-handle.test.ts packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts` → 期望包含: 17 pass

### 场景 4：边界与回归

#### - [x] 4.1 未 prepare 不允许直接 start
- **来源:** spec-design.md 七 / spec-plan.md Task 4 测试场景
- **目的:** 确认非法状态被明确拦截
- **操作步骤:**
  1. [A] `bun test packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts` → 期望包含: pass

#### - [x] 4.2 未 running 不允许直接 connectRelay
- **来源:** spec-design.md 四.3、七 / spec-plan.md Task 4 测试场景
- **目的:** 确认 relay 前置状态严格
- **操作步骤:**
  1. [A] `bun test packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts` → 期望包含: pass

#### - [x] 4.3 stopInstance 幂等且不会重复异常
- **来源:** spec-design.md 四.4、七 / spec-plan.md Task 3、Task 5 测试场景
- **目的:** 确认停止流程可安全重入
- **操作步骤:**
  1. [A] `bun test packages/plugin-opencode/src/__tests__/acp-link-process-manager.test.ts packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts src/__tests__/instance-service.test.ts` → 期望包含: pass

---

## 验收后清理

- [x] [AUTO] 无需终止后台服务: `true`

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | 插件入口导出稳定 | 1 | 0 | ✅ |
| 场景 1 | 1.2 | 插件测试与类型可通过 | 2 | 0 | ✅ |
| 场景 1 | 1.3 | 整个 plugin-opencode 测试套件无回归 | 1 | 0 | ✅ |
| 场景 2 | 2.1 | 运行时配置映射入口存在 | 1 | 0 | ✅ |
| 场景 2 | 2.2 | workspace 写入路径固定为 .opencode 与根目录 .env | 1 | 0 | ✅ |
| 场景 2 | 2.3 | prepare 阶段会生成并覆盖运行时文件 | 1 | 0 | ✅ |
| 场景 3 | 3.1 | 端口分配器已独立并支持释放 | 1 | 0 | ✅ |
| 场景 3 | 3.2 | 进程管理器包含 token 捕获与双阶段终止 | 1 | 0 | ✅ |
| 场景 3 | 3.3 | relay 具备共享连接与噪音过滤 | 2 | 0 | ✅ |
| 场景 3 | 3.4 | prepare/start/connect/stop 主流程串通 | 1 | 0 | ✅ |
| 场景 4 | 4.1 | 未 prepare 不允许直接 start | 1 | 0 | ✅ |
| 场景 4 | 4.2 | 未 running 不允许直接 connectRelay | 1 | 0 | ✅ |
| 场景 4 | 4.3 | stopInstance 幂等且不会重复异常 | 1 | 0 | ✅ |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
