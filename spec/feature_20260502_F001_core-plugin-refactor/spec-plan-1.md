# core-plugin-refactor（阶段一：独立工程骨架与核心契约）执行计划

**目标:** 在不改动 legacy `src/`、`web/` 主链路的前提下，建立独立 `mothership/` 工程，并先落下可测试的 SDK / Core 契约层。

**技术栈:** Bun, TypeScript, Hono, React, Vite, Bun test

**设计文档:** `spec/feature_20260502_F001_core-plugin-refactor/spec-design.md`

## 改动总览

本阶段只新增 `mothership/` 目录及其内部文件，不修改 legacy `src/`、`web/`，与设计文档“旧系统只接受 bugfix”的冻结线保持一致。经代码分析确认，仓库根目录当前只有单体 `package.json` / `tsconfig.json`，也不存在 `mothership/`、`refactor/` 或任何新架构目录，因此 Task 1 需要先建立真正独立的子工程入口。Task 2 在 `packages/plugin-sdk` 与 `packages/core` 中定义最小可用的 provider-plugin 契约和强类型 ID 模型，Task 3 再补齐 registry / repository / runtime resolver 抽象，确保后续服务层与 opencode 插件都只依赖这些稳定接口。本文件的改动量控制在工程脚手架、领域模型和基础契约三组文件内，单次实现可保持在 2000 行以内。

---

### Task 0: 环境准备

**背景:**
当前仓库使用 Bun 作为运行、构建和测试工具；新工程也需要沿用同一工具链，避免引入第二套 Node 包管理和测试约定。由于 `mothership/` 目录目前不存在，本 Task 先验证根仓库已有 Bun 能力，再为后续任务创建独立工程时提供稳定前提。

**执行步骤:**
- [x] 验证 Bun 运行时与包管理命令可用
  - 位置: 仓库根目录 `/Users/liyuan/Work/mothership-beta`
  - 执行 `bun --version`，确认当前环境已经安装 Bun，后续 `mothership/package.json` 直接复用该工具链
  - 原因: 新工程所有脚本都将以 Bun 为唯一入口
- [x] 验证根仓库 TypeScript 检查命令可用
  - 位置: `/Users/liyuan/Work/mothership-beta/package.json` 的 `scripts.typecheck`
  - 执行 `bun run typecheck`，确认当前仓库的 TypeScript 编译环境正常
  - 原因: 后续新增子工程时，需要区分 legacy 与新工程的类型检查边界
- [x] 验证根仓库 Bun test 可正常执行单测
  - 位置: `src/__tests__/store.test.ts`
  - 执行 `bun test src/__tests__/store.test.ts`
  - 原因: 后续 `mothership/` 继续沿用 Bun test，需要确认本地测试 runner 正常

**检查步骤:**
- [x] 检查 Bun 已安装
  - `bun --version`
  - 预期: 输出 Bun 版本号，命令退出码为 0
- [x] 检查 legacy 类型检查可用
  - `cd /Users/liyuan/Work/mothership-beta && bun run typecheck`
  - 预期: 命令成功结束，无 TypeScript 配置错误
- [x] 检查 legacy 单测可运行
  - `cd /Users/liyuan/Work/mothership-beta && bun test src/__tests__/store.test.ts`
  - 预期: `store.test.ts` 通过，证明 Bun test 环境可用

---

### Task 1: 建立独立 `mothership/` 工程骨架

**背景:**
设计文档要求“新工程必须真正独立”，而当前仓库根目录只有 legacy 单体入口 `src/index.ts`、`web/` 和单一 `package.json`，不存在任何可复用的新工程脚手架。本 Task 产出后，Task 2 和 Task 3 才能把 SDK / Core 契约放进独立 workspace，不会与旧系统脚本和构建路径耦合。

**涉及文件:**
- 新建: `mothership/package.json`
- 新建: `mothership/bunfig.toml`
- 新建: `mothership/tsconfig.base.json`
- 新建: `mothership/.gitignore`
- 新建: `mothership/README.md`
- 新建: `mothership/apps/server/package.json`
- 新建: `mothership/apps/server/tsconfig.json`
- 新建: `mothership/apps/server/src/index.ts`
- 新建: `mothership/apps/server/src/app.ts`
- 新建: `mothership/apps/server/src/__tests__/health.test.ts`
- 新建: `mothership/apps/web/package.json`
- 新建: `mothership/apps/web/tsconfig.json`
- 新建: `mothership/apps/web/vite.config.ts`
- 新建: `mothership/apps/web/src/main.tsx`
- 新建: `mothership/apps/web/src/App.tsx`
- 新建: `mothership/packages/core/package.json`
- 新建: `mothership/packages/core/tsconfig.json`
- 新建: `mothership/packages/plugin-sdk/package.json`
- 新建: `mothership/packages/plugin-sdk/tsconfig.json`
- 新建: `mothership/plugins/opencode/package.json`
- 新建: `mothership/plugins/opencode/tsconfig.json`

**执行步骤:**
- [x] 在 `mothership/package.json` 建立独立 workspace 根配置
  - 位置: 新文件 `mothership/package.json`
  - 写入 `workspaces: ["apps/*", "packages/*", "plugins/*"]`，并定义 `dev:server`、`dev:web`、`build`、`typecheck`、`test` 五个脚本；不要复用根目录 `package.json`
  - 原因: 经代码确认根目录当前不是 workspace 结构，子工程必须有自己的依赖入口和脚本边界
- [x] 在 `mothership/tsconfig.base.json` 与各子包 `tsconfig.json` 建立统一 TypeScript 继承链
  - 位置: `mothership/tsconfig.base.json`，以及 `apps/server`、`apps/web`、`packages/core`、`packages/plugin-sdk`、`plugins/opencode` 各自的 `tsconfig.json`
  - 统一设置 `target: "ES2022"`、`moduleResolution: "bundler"`、`strict: true`、路径别名 `@mothership/core`、`@mothership/plugin-sdk`、`@mothership/opencode`
  - 原因: 后续跨包导入需要稳定别名和一致编译选项，否则 Core / Plugin 契约无法平滑联调
- [x] 在 `mothership/apps/server/src/app.ts` 和 `src/index.ts` 建立最小可运行 Hono 入口
  - 位置: `mothership/apps/server/src/app.ts` 导出 `createApp()`，`mothership/apps/server/src/index.ts` 只负责 `Bun.serve`
  - `createApp()` 先提供 `/health` 和 `/version` 两个只读路由，返回静态 JSON；`index.ts` 不接入 legacy `src/index.ts`
  - 原因: 设计文档要求 server 只做 composition layer，本阶段先验证独立启动方式
- [x] 在 `mothership/apps/web` 建立最小 Vite + React 占位前端
  - 位置: `mothership/apps/web/vite.config.ts`、`src/main.tsx`、`src/App.tsx`
  - `App.tsx` 仅渲染 “mothership bootstrap” 占位页面，并通过 `import.meta.env` 读取后端基地址；不要复制 legacy `web/src/App.tsx`
  - 原因: 设计文档要求 `apps/web` 物理存在且可独立启动，但本阶段不重写旧控制台交互
- [x] 在 `mothership/README.md` 与 `.gitignore` 说明新旧工程边界
  - 位置: `mothership/README.md` 和 `mothership/.gitignore`
  - README 明确“legacy `src/`、`web/` 冻结维护；新架构只在 `mothership/` 演进”；`.gitignore` 增加 `node_modules`、`dist`、`.turbo`、`coverage`
  - 原因: 这条边界是后续所有 plan 的执行前提，必须一开始就落盘
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `mothership/apps/server/src/__tests__/health.test.ts`
  - 测试场景:
    - `/health`: 请求 `GET /health` → 返回 200 和 `{ "status": "ok" }`
    - `/version`: 请求 `GET /version` → 返回 200，且包含 `name: "mothership"`
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/server/src/__tests__/health.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 workspace 根配置已创建
  - `cd /Users/liyuan/Work/mothership-beta && test -f mothership/package.json && test -f mothership/tsconfig.base.json && echo ok`
  - 预期: 输出 `ok`
- [x] 检查独立 server 占位入口存在
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "createApp|/health|/version" mothership/apps/server/src`
  - 预期: 输出 `app.ts` 和 `index.ts` 中的路由与导出定义
- [x] 检查本 Task 单测通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/server/src/__tests__/health.test.ts`
  - 预期: `health.test.ts` 全部通过

---

### Task 2: 定义 provider SDK 与统一 ID / 领域模型

**背景:**
设计文档明确要求“统一 ID 模型”和“core 只依赖 provider-plugin 接口”，而 legacy 代码里 `src/store.ts`、`src/services/session.ts`、`src/services/instance.ts` 仍把 `environmentId`、`sessionId`、provider session 混在普通字符串里。本 Task 先把最小 SDK、强类型 ID 和核心领域对象写实，后续 Task 3 的 registry / repository 以及阶段二的服务层都直接依赖这里的类型。

**涉及文件:**
- 新建: `mothership/packages/plugin-sdk/src/provider-plugin.ts`
- 新建: `mothership/packages/plugin-sdk/src/provider-runtime-context.ts`
- 新建: `mothership/packages/plugin-sdk/src/provider-relay.ts`
- 新建: `mothership/packages/plugin-sdk/src/index.ts`
- 新建: `mothership/packages/plugin-sdk/src/__tests__/provider-plugin.test.ts`
- 新建: `mothership/packages/core/src/domain/ids.ts`
- 新建: `mothership/packages/core/src/domain/environment.ts`
- 新建: `mothership/packages/core/src/domain/instance.ts`
- 新建: `mothership/packages/core/src/domain/session.ts`
- 新建: `mothership/packages/core/src/runtime/agent-runtime-spec.ts`
- 新建: `mothership/packages/core/src/index.ts`
- 新建: `mothership/packages/core/src/__tests__/ids.test.ts`

**执行步骤:**
- [x] 在 `mothership/packages/plugin-sdk/src/provider-plugin.ts` 定义最小 `ProviderPlugin` / `ProviderRuntime` 契约
  - 位置: 新文件 `provider-plugin.ts`
  - 按设计文档固化 `ProviderPluginMeta`、`ProviderPlugin`、`ProviderRuntime`，包含 `prepareEnvironment`、`injectRuntimeConfig?`、`startInstance`、`stopInstance`、`connectRelay`、`listSessions?`、`getHealth?`
  - 原因: 经代码分析确认 legacy `spawnInstanceFromEnvironment()`、`handleRelayOpen()`、`storeListSessionsForAgentByCwd()` 已覆盖这些能力边界，不需要再扩大首版 SDK
- [x] 在 `mothership/packages/plugin-sdk/src/provider-runtime-context.ts` 建立受控宿主能力接口
  - 位置: 新文件 `provider-runtime-context.ts`
  - 定义 `logger`、`eventBus`、`environments`、`instances`、`sessions`、`workspaceResolver`、`secretResolver`、`clock`、`idGenerator`，不要暴露原始 `db`、`Hono Context`、任意文件系统句柄
  - 原因: 设计文档明确禁止插件反向绑死宿主实现，这里要把限制落实到类型层
- [x] 在 `mothership/packages/core/src/domain/ids.ts` 建立强类型 ID 工厂
  - 位置: 新文件 `ids.ts`
  - 使用 branded type 或 `type EnvironmentId = string & { readonly __brand: "EnvironmentId" }` 的形式区分 `EnvironmentId`、`InstanceId`、`SessionId`、`ProviderSessionId`，同时导出 `createEnvironmentId()`、`createInstanceId()`、`createSessionId()`、`createProviderSessionId()`
  - 原因: legacy `src/services/session.ts` 已出现 ACP session 与 Web session 的兼容转换逻辑，新工程必须从类型层直接避免混用
- [x] 在 `mothership/packages/core/src/domain/*.ts` 与 `runtime/agent-runtime-spec.ts` 固化核心领域模型
  - 位置: `domain/environment.ts`、`domain/instance.ts`、`domain/session.ts`、`runtime/agent-runtime-spec.ts`
  - `Environment` 只保留 provider 类型、workspace、平台配置引用；`Instance` 提供 `runtimeMetadata: Record<string, unknown>`；`Session` 同时持有 `sessionId` 与 `providerSessionId`; `AgentRuntimeSpec` 按设计文档字段定义
  - 原因: 后续服务层要围绕这些对象编排，而不是直接复用 legacy `EnvironmentRecord` / `SessionRecord`
- [x] 在 `packages/plugin-sdk/src/index.ts` 与 `packages/core/src/index.ts` 暴露稳定公共导出
  - 位置: 各包 `src/index.ts`
  - 只 re-export 外部需要消费的类型、工厂和契约；不要把内部测试工具或 fixtures 暴露出去
  - 原因: 阶段二和阶段三会跨包依赖这些入口，先收敛公共 surface area
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `mothership/packages/plugin-sdk/src/__tests__/provider-plugin.test.ts`, `mothership/packages/core/src/__tests__/ids.test.ts`
  - 测试场景:
    - `ProviderPluginMeta`: capability 全量声明对象 → 通过类型与运行时 shape 校验
    - `createSessionId` vs `createProviderSessionId`: 传入不同前缀字符串 → 生成两个不可混用的 branded 值
    - `Session` 模型: 同时传 `sessionId` 和 `providerSessionId` → 结构保留两套字段，不发生覆盖
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test packages/plugin-sdk/src/__tests__/provider-plugin.test.ts packages/core/src/__tests__/ids.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 SDK 主接口已创建
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "export interface ProviderPlugin|export interface ProviderRuntime|ProviderRuntimeContext" mothership/packages/plugin-sdk/src`
  - 预期: 输出三个接口定义所在文件和行号
- [x] 检查强类型 ID 与领域模型已创建
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "EnvironmentId|InstanceId|ProviderSessionId|AgentRuntimeSpec" mothership/packages/core/src`
  - 预期: 输出 `ids.ts` 与模型文件中的定义
- [x] 检查本 Task 单测通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test packages/plugin-sdk/src/__tests__/provider-plugin.test.ts packages/core/src/__tests__/ids.test.ts`
  - 预期: 两个测试文件全部通过

---

### Task 3: 实现 PluginRegistry、仓储接口与 RuntimeConfigResolver 抽象

**背景:**
经代码分析确认，legacy `src/index.ts` 直接把路由、实例启动、relay 关闭、自动启动环境全部揉在入口里，`src/services/instance.ts` 也直接依赖 store 与 transport。新工程要避免继续复制这种耦合，就必须先在 Core 中准备 registry、repository contracts 和 runtime config resolver 抽象，让后续服务只面向接口编排。

**涉及文件:**
- 新建: `mothership/packages/core/src/contracts/environment-repository.ts`
- 新建: `mothership/packages/core/src/contracts/instance-repository.ts`
- 新建: `mothership/packages/core/src/contracts/session-repository.ts`
- 新建: `mothership/packages/core/src/contracts/config-repository.ts`
- 新建: `mothership/packages/core/src/plugins/plugin-registry.ts`
- 新建: `mothership/packages/core/src/runtime/runtime-config-resolver.ts`
- 新建: `mothership/packages/core/src/testing/in-memory-repositories.ts`
- 新建: `mothership/packages/core/src/__tests__/plugin-registry.test.ts`
- 新建: `mothership/packages/core/src/__tests__/runtime-config-resolver.test.ts`
- 修改: `mothership/packages/core/src/index.ts`

**执行步骤:**
- [x] 在 `contracts/*.ts` 中拆分环境、实例、会话、平台配置四类仓储接口
  - 位置: `environment-repository.ts`、`instance-repository.ts`、`session-repository.ts`、`config-repository.ts`
  - 每个接口只暴露 Core 服务真正需要的方法；参考 legacy 调用链，将 `EnvironmentService` 需要的 `getById` / `save` / `listByUser`，`InstanceService` 需要的 `save` / `getRunningByEnvironment` / `updateStatus`，`SessionService` 需要的 `create` / `findByProviderSessionId` / `listByEnvironment` 显式列出
  - 原因: 先把服务依赖面缩到最小，后续 SQLite / 内存实现才能稳定替换
- [x] 在 `plugin-registry.ts` 实现 provider 注册与能力查询
  - 位置: 新文件 `mothership/packages/core/src/plugins/plugin-registry.ts`
  - 提供 `register(plugin)`、`get(pluginId)`、`require(pluginId)`、`list()`、`supports(pluginId, capability)`；对重复 `plugin.meta.id` 抛出确定性错误
  - 原因: 设计文档要求 capability 显式声明，Core 不能靠字符串判断或隐式猜测插件能力
- [x] 在 `runtime-config-resolver.ts` 定义并实现首版 `RuntimeConfigResolver`
  - 位置: 新文件 `mothership/packages/core/src/runtime/runtime-config-resolver.ts`
  - 接收 `ResolveRuntimeConfigInput`，通过 `ConfigRepository` 解析 provider / model / agent / skills / mcp 为统一 `AgentRuntimeSpec`；缺失引用直接抛具名错误，不做 silent fallback
  - 原因: 经代码分析确认 legacy 当前由 `src/services/instance.ts` 直接往 `.opencode/opencode.json` 写入 `default_agent` 和知识库 MCP，新工程需要先把“解析”与“注入”拆开
- [x] 在 `testing/in-memory-repositories.ts` 提供内存实现供后续服务测试复用
  - 位置: 新文件 `mothership/packages/core/src/testing/in-memory-repositories.ts`
  - 用 `Map` 实现四类仓储接口，并导出 `reset()`；风格参考 legacy `src/store.ts`，但只保留 Core 契约内的方法
  - 原因: 阶段二服务层测试需要快速构建上下文，不应反复手写 mock
- [x] 更新 `mothership/packages/core/src/index.ts` 导出 registry、contracts 与 resolver
  - 位置: `mothership/packages/core/src/index.ts`
  - 将 Task 2 与本 Task 的公共类型统一汇总，保持跨包只从单一入口导入
  - 原因: 后续 `apps/server` 与 `plugins/opencode` 都会消费这些抽象
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `mothership/packages/core/src/__tests__/plugin-registry.test.ts`, `mothership/packages/core/src/__tests__/runtime-config-resolver.test.ts`
  - 测试场景:
    - `PluginRegistry`: 连续注册两个不同插件 → `list()` 返回 2 个；重复注册同 ID → 抛出错误
    - `supports()`: `multiInstance: true` 的插件 → 返回 true；未声明能力 → 返回 false
    - `RuntimeConfigResolver`: 提供完整 provider / model / agent / skills / mcp 引用 → 解析出完整 `AgentRuntimeSpec`
    - `RuntimeConfigResolver`: 缺失 model 引用 → 抛出具名解析错误，错误消息包含缺失 key
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test packages/core/src/__tests__/plugin-registry.test.ts packages/core/src/__tests__/runtime-config-resolver.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 registry 与 resolver 导出存在
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "class PluginRegistry|class RuntimeConfigResolver|supports\\(" mothership/packages/core/src`
  - 预期: 输出 `plugin-registry.ts` 与 `runtime-config-resolver.ts` 中的定义
- [x] 检查仓储接口已按边界拆分
  - `cd /Users/liyuan/Work/mothership-beta && find mothership/packages/core/src/contracts -maxdepth 1 -type f | sort`
  - 预期: 至少包含 environment / instance / session / config 四个接口文件
- [x] 检查本 Task 单测通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test packages/core/src/__tests__/plugin-registry.test.ts packages/core/src/__tests__/runtime-config-resolver.test.ts`
  - 预期: 两个测试文件全部通过

---

### Task 4: 阶段一验收

**前置条件:**
- 启动命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun install`
- 测试数据准备: 无，全部使用单元测试与静态结构检查
- 其他环境准备: 已完成本文件 Task 0

**端到端验证:**

1. 运行阶段一完整测试套件确保无回归
   - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test`
   - 预期: `apps/server`、`packages/core`、`packages/plugin-sdk` 现有测试全部通过
   - 失败排查: 检查 Task 1、Task 2、Task 3 的测试步骤

2. 验证 `mothership/` 目录结构独立存在
   - `cd /Users/liyuan/Work/mothership-beta && find mothership -maxdepth 2 -type d | sort`
   - 预期: 输出 `apps/server`、`apps/web`、`packages/core`、`packages/plugin-sdk`、`plugins/opencode`
   - 失败排查: 检查 Task 1 工程骨架创建步骤

3. 验证新工程类型导出可被统一索引访问
   - `cd /Users/liyuan/Work/mothership-beta && rg -n "export .*ProviderPlugin|export .*EnvironmentId|export .*PluginRegistry" mothership/packages`
   - 预期: `plugin-sdk` 与 `core` 的公共 API 均能从 `src/index.ts` 找到
   - 失败排查: 检查 Task 2、Task 3 的索引导出步骤

4. 验证新旧系统物理隔离边界已写入文档
   - `cd /Users/liyuan/Work/mothership-beta && rg -n "legacy|冻结|mothership" mothership/README.md`
   - 预期: README 明确说明 legacy 与 `mothership/` 的职责边界
   - 失败排查: 检查 Task 1 的 README 编写步骤
