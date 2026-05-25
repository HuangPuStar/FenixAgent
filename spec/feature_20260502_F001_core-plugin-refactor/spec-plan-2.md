# core-plugin-refactor（阶段二：Core 服务与 opencode 插件迁移）执行计划

**目标:** 在阶段一契约层之上，实现最小可用的 Core 服务、运行时配置翻译链路，以及首个 `opencode` provider plugin。

**技术栈:** Bun, TypeScript, Bun test, WebSocket, child_process

**设计文档:** `spec/feature_20260502_F001_core-plugin-refactor/spec-design.md`

## 改动总览

本阶段默认依赖 `spec-plan-1.md` 已创建好的 `mothership/` workspace、SDK 与 Core 契约，不再回头修改 legacy `src/services/instance.ts`、`src/transport/acp-relay-handler.ts`、`src/transport/acp-ws-handler.ts` 的现有行为。经代码分析确认，legacy 的实例启动、relay、本地 token 捕获和 `.opencode/opencode.json` 注入分别散落在上述三个文件中，因此本阶段按“Core 服务编排 → RuntimeSpec 翻译 → opencode 进程与 relay 适配”三步迁移，避免再次把 provider 私有实现写回 Core。每个 Task 只聚焦一层边界，代码量控制在服务层、翻译层、插件实现三组文件内。

---

### Task 0: 环境准备

**背景:**
阶段二直接依赖阶段一已创建的 `mothership/` workspace 和测试基础设施，不需要重复验证 legacy 工具链。这里仅做轻量检查，确保 Core / Plugin 包都能被 Bun workspace 正常解析。

**执行步骤:**
- [x] 验证 `mothership/` workspace 依赖已安装
  - 位置: `/Users/liyuan/Work/mothership-beta/mothership/package.json`
  - 执行 `bun install`，确保 `apps/*`、`packages/*`、`plugins/*` 的依赖链接正常
  - 原因: 本阶段新增跨包依赖，必须先保证 workspace 可解析
- [x] 验证阶段一测试仍然通过
  - 位置: `mothership/apps/server/src/__tests__/health.test.ts` 与 `mothership/packages/core/src/__tests__/*`
  - 执行 `bun test apps/server/src/__tests__/health.test.ts packages/core/src/__tests__/plugin-registry.test.ts`
  - 原因: 避免在进入服务层与插件迁移前带着基础层回归

**检查步骤:**
- [x] 检查 workspace 安装完成
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun install`
  - 预期: 命令成功完成，无 workspace 解析错误
- [x] 检查阶段一基线测试仍通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/server/src/__tests__/health.test.ts packages/core/src/__tests__/plugin-registry.test.ts`
  - 预期: 两个基线测试文件通过

---

### Task 5: 实现 Core 服务与 Facade 编排层

**背景:**
经代码分析确认，legacy `spawnInstanceFromEnvironment()` 同时处理环境校验、session 创建、workspace 配置注入、端口分配和子进程启动；`handleRelayOpen()` 又直接读取实例状态并建立 relay。这种耦合正是设计文档要拆开的对象。本 Task 先在 `packages/core` 中建立 provider 无关的服务层和 facade，给后续 opencode 插件一个稳定宿主。

**涉及文件:**
- 新建: `mothership/packages/core/src/services/environment-service.ts`
- 新建: `mothership/packages/core/src/services/instance-service.ts`
- 新建: `mothership/packages/core/src/services/session-service.ts`
- 新建: `mothership/packages/core/src/services/relay-orchestrator.ts`
- 新建: `mothership/packages/core/src/services/core-facade.ts`
- 新建: `mothership/packages/core/src/events/runtime-event-bus.ts`
- 新建: `mothership/packages/core/src/__tests__/instance-service.test.ts`
- 新建: `mothership/packages/core/src/__tests__/relay-orchestrator.test.ts`
- 修改: `mothership/packages/core/src/index.ts`

**执行步骤:**
- [x] 在 `environment-service.ts` 和 `session-service.ts` 中实现 provider 无关的环境 / 会话服务
  - 位置: `mothership/packages/core/src/services/environment-service.ts`、`session-service.ts`
  - `EnvironmentService` 负责 environment CRUD、默认 agent/model 引用读取；`SessionService` 负责创建 Core `sessionId`、记录 `providerSessionId` 映射、按 environment 查询会话
  - 原因: legacy `src/store.ts` 与 `src/services/session.ts` 已暴露这些稳定需求，应该先从 provider 行为中抽离
- [x] 在 `instance-service.ts` 中实现实例生命周期编排
  - 位置: 新文件 `mothership/packages/core/src/services/instance-service.ts`
  - 提供 `startInstance(environmentId)`、`stopInstance(instanceId)`、`listInstances(environmentId)`、`bindProviderSession(instanceId, providerSessionId)`；`startInstance()` 固定流程为：加载 environment → 解析 `AgentRuntimeSpec` → 取出对应插件 → `prepareEnvironment` → `injectRuntimeConfig` → `startInstance`
  - 原因: 设计文档要求“先抽象、后搬运”，这里先把编排链路固化下来
- [x] 在 `runtime-event-bus.ts` 与 `relay-orchestrator.ts` 中建立统一 relay 入口
  - 位置: `mothership/packages/core/src/events/runtime-event-bus.ts`、`services/relay-orchestrator.ts`
  - `RelayOrchestrator` 提供 `connect(sessionId, transport)` 和 `disconnect(relayId)`；它只根据 `sessionId -> instanceId -> plugin runtime` 路由，真正的本地 WS / keep_alive 细节不在 Core 处理
  - 原因: legacy `src/transport/acp-relay-handler.ts` 目前同时做路由与 provider 协议适配，必须在这里先切边界
- [x] 在 `core-facade.ts` 组合 registry、resolver、服务与事件总线
  - 位置: 新文件 `mothership/packages/core/src/services/core-facade.ts`
  - 暴露 `createEnvironment`、`startEnvironmentInstance`、`stopEnvironmentInstance`、`connectRelay`、`listSessions` 这类供 `apps/server` 直接调用的门面方法
  - 原因: 阶段三 server 只应依赖 facade，不应直接 new 多个底层 service
- [x] 更新 `packages/core/src/index.ts` 暴露服务层入口
  - 位置: `mothership/packages/core/src/index.ts`
  - 导出 `EnvironmentService`、`SessionService`、`InstanceService`、`RelayOrchestrator`、`CoreFacade`
  - 原因: 后续 `apps/server` 与插件测试都要从统一入口导入
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `mothership/packages/core/src/__tests__/instance-service.test.ts`, `mothership/packages/core/src/__tests__/relay-orchestrator.test.ts`
  - 测试场景:
    - `startInstance`: 给定 environment 和 mock plugin runtime → 按固定顺序调用 `prepareEnvironment`、`injectRuntimeConfig`、`startInstance`
    - `startInstance`: 插件未注册 → 抛出具名错误，错误消息包含 providerId
    - `connect(sessionId)`: session 已绑定 instance → 调用插件 `connectRelay()` 并返回 relay handle
    - `disconnect(relayId)`: relay handle 存在 → 正确执行清理，不再向 transport 转发事件
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test packages/core/src/__tests__/instance-service.test.ts packages/core/src/__tests__/relay-orchestrator.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 Core 服务与 Facade 已导出
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "class EnvironmentService|class InstanceService|class RelayOrchestrator|class CoreFacade" mothership/packages/core/src`
  - 预期: 输出四个服务/门面的类定义
- [x] 检查实例启动链路按抽象接口编排
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "prepareEnvironment|injectRuntimeConfig|startInstance" mothership/packages/core/src/services/instance-service.ts`
  - 预期: `instance-service.ts` 中按顺序出现三段调用
- [x] 检查本 Task 单测通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test packages/core/src/__tests__/instance-service.test.ts packages/core/src/__tests__/relay-orchestrator.test.ts`
  - 预期: 两个测试文件全部通过

---

### Task 6: 实现 RuntimeSpec 到 opencode 注入配置的翻译层

**背景:**
legacy 当前由 `src/services/instance.ts` 直接把 `default_agent` 和知识库 MCP 写入 `.opencode/opencode.json`；这说明“平台配置解析”与“provider 私有落盘格式”目前完全耦合在一起。设计文档要求这条链路拆成 Core `RuntimeConfigResolver` + provider plugin 注入层。但这里需要额外收紧边界：`knowledge` 属于跨 provider 的能力，不应继续搬进 `plugins/opencode`。本 Task 只负责 `opencode` 私有配置翻译与写入，知识库相关注入留给后续 ability plugin / injection pipeline 实现。

**涉及文件:**
- 新建: `mothership/plugins/opencode/src/runtime/opencode-runtime-config.ts`
- 新建: `mothership/plugins/opencode/src/runtime/opencode-config-writer.ts`
- 新建: `mothership/plugins/opencode/src/__tests__/opencode-config-writer.test.ts`
- 修改: `mothership/plugins/opencode/src/index.ts`

**执行步骤:**
- [x] 在 `opencode-runtime-config.ts` 定义 opencode 私有运行时配置结构
  - 位置: 新文件 `mothership/plugins/opencode/src/runtime/opencode-runtime-config.ts`
  - 定义 `OpencodeRuntimeConfig`，显式包含 `default_agent`、`mcp`、skills 文件引用等字段；不要把该类型导出到 `packages/core`
  - 原因: `opencode.json` 是 provider 私有格式，必须封在插件包内部
- [x] 在 provider 私有翻译层中仅实现 `AgentRuntimeSpec -> opencode.mcp` 的 provider 配置映射
  - 位置: `mothership/plugins/opencode/src/runtime/`
  - 仅处理 `runtimeSpec.mcpServers` 到 `opencode` 私有 `mcp` 配置的转换；不要在 provider 插件内解释 `knowledgeBindings` 或生成固定 `kb` 配置
  - 原因: 知识库属于跨 provider 能力，应由后续 ability plugin / injection pipeline 注入，而不是继续固化到 `plugins/opencode`
- [x] 在 `opencode-config-writer.ts` 实现 workspace 注入器
  - 位置: 新文件 `mothership/plugins/opencode/src/runtime/opencode-config-writer.ts`
  - 固定写入 `<workspace>/.opencode/opencode.json`；读取已有 JSON 后 merge `default_agent` 与 `mcp`，保留未知字段并统一以 2 空格格式重写
  - 原因: 经代码分析确认 legacy 已存在“读取旧文件再覆盖 default_agent”的兼容写法，新插件需要延续这一行为
- [x] 在 `plugins/opencode/src/index.ts` 暴露运行时翻译与注入入口
  - 位置: `mothership/plugins/opencode/src/index.ts`
  - 导出 `createOpencodeRuntimeConfig()`、`writeOpencodeRuntimeConfig()`，但不要导出内部测试 helper
  - 原因: 阶段二 Task 7 的 provider runtime 会直接调用这些函数
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `mothership/plugins/opencode/src/__tests__/opencode-config-writer.test.ts`
  - 测试场景:
    - `writeOpencodeRuntimeConfig`: 目录不存在 → 自动创建 `.opencode/` 并写入 `opencode.json`
    - `writeOpencodeRuntimeConfig`: 已有旧配置文件 → 保留未知字段，仅更新 `default_agent` 与 `mcp`
    - provider 私有 `mcp` 映射: 仅保留 `runtimeSpec.mcpServers`，不消费 `knowledgeBindings`
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test plugins/opencode/src/__tests__/opencode-config-writer.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 opencode 私有配置类型只存在于插件包
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "OpencodeRuntimeConfig" mothership/plugins/opencode mothership/packages/core`
  - 预期: 仅在 `plugins/opencode` 下有结果，`packages/core` 无匹配
- [x] 检查 `.opencode/opencode.json` 写入路径已固定
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "\\.opencode/opencode\\.json|default_agent|mcp" mothership/plugins/opencode/src/runtime`
  - 预期: `opencode-config-writer.ts` 中存在明确写入逻辑
- [x] 检查本 Task 单测通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test plugins/opencode/src/__tests__/opencode-config-writer.test.ts`
  - 预期: 测试文件通过，且 provider 私有注入层不再承接知识库能力

---

### Task 7: 实现 opencode ProviderRuntime、进程管理与 Relay 适配

**背景:**
经代码分析确认，legacy `src/services/instance.ts` 负责端口分配、`acp-link` 子进程启动、本地 token 捕获和 stop 行为；`src/transport/acp-relay-handler.ts` 负责本地 WS keep_alive、过滤 `keep_alive` 消息、维护 relay 生命周期。这些都是 opencode / acp-link 私有行为，必须整体迁入插件，而不是拆一半留在 Core。

**涉及文件:**
- 新建: `mothership/plugins/opencode/src/opencode-plugin.ts`
- 新建: `mothership/plugins/opencode/src/process/port-allocator.ts`
- 新建: `mothership/plugins/opencode/src/process/acp-link-process-manager.ts`
- 新建: `mothership/plugins/opencode/src/relay/opencode-relay-handle.ts`
- 新建: `mothership/plugins/opencode/src/session/opencode-session-source.ts`
- 新建: `mothership/plugins/opencode/src/__tests__/acp-link-process-manager.test.ts`
- 新建: `mothership/plugins/opencode/src/__tests__/opencode-relay-handle.test.ts`
- 修改: `mothership/plugins/opencode/src/index.ts`

**执行步骤:**
- [x] 在 `port-allocator.ts` 与 `acp-link-process-manager.ts` 迁移端口分配、token 捕获和子进程管理
  - 位置: `mothership/plugins/opencode/src/process/port-allocator.ts`、`acp-link-process-manager.ts`
  - 参考 legacy `src/services/instance.ts` 的 `PORT_MIN` / `PORT_MAX`、`probePort()`、`Token:\\s*([a-f0-9]{64})` 正则和 `SIGTERM -> 5s 后 SIGKILL` 停止逻辑，封装为 `start()` / `stop()` / `getProcessState()`
  - 原因: 这些都是 `acp-link + opencode` 私有实现，不应继续出现在 Core
- [x] 在 `opencode-relay-handle.ts` 实现本地 WS relay 适配
  - 位置: 新文件 `mothership/plugins/opencode/src/relay/opencode-relay-handle.ts`
  - 迁移 legacy `src/transport/acp-relay-handler.ts` 的本地 WS 逻辑：连接 `ws://127.0.0.1:${port}/ws?token=...`、每 20 秒发送 `keep_alive`、过滤上游 `keep_alive` 与 keep_alive 错误、前端断连时不主动杀掉进程
  - 原因: 设计文档要求 Core 只消费统一 `ProviderRelayHandle`
- [x] 在 `opencode-plugin.ts` 实现完整 `ProviderPlugin`
  - 位置: 新文件 `mothership/plugins/opencode/src/opencode-plugin.ts`
  - `createRuntime()` 返回的 runtime 需要实现 `prepareEnvironment`、`injectRuntimeConfig`、`startInstance`、`stopInstance`、`connectRelay`、`listSessions?`；`injectRuntimeConfig` 调用 Task 6 的 config writer，`startInstance` 调用进程管理器，`connectRelay` 返回 `opencode-relay-handle`
  - 原因: 首个 provider plugin 必须把 legacy 私有行为完整收口
- [x] 在 `session/opencode-session-source.ts` 建立 `providerSessionId` 适配层
  - 位置: 新文件 `mothership/plugins/opencode/src/session/opencode-session-source.ts`
  - 负责把 ACP/opencode 的原生 session 摘要转换为 Core `ProviderSessionSummary`，明确区分 `sessionId` 与 `providerSessionId`
  - 原因: 设计文档已把“session ID 混用”列为必须修复的问题
- [x] 更新 `plugins/opencode/src/index.ts` 导出 plugin 主入口
  - 位置: `mothership/plugins/opencode/src/index.ts`
  - 导出 `createOpencodePlugin()` 与必要类型，隐藏具体进程管理器实现
  - 原因: 阶段三 server 只需要注册插件，不需要感知内部文件结构
- [x] 为本 Task 核心逻辑编写单元测试
  - 测试文件: `mothership/plugins/opencode/src/__tests__/acp-link-process-manager.test.ts`, `mothership/plugins/opencode/src/__tests__/opencode-relay-handle.test.ts`
  - 测试场景:
    - `start()`: mock stdout 输出 `Token: <64hex>` → 进程状态保存捕获到的 token
    - `stop()`: 已有 `pid` → 先发送 `SIGTERM`，再注册 5 秒超时的 `SIGKILL`
    - relay handle: 上游收到 `keep_alive` → 不向前端转发
    - relay handle: 前端断开 → 本地 WS 清理转发器但保持进程存活
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test plugins/opencode/src/__tests__/acp-link-process-manager.test.ts plugins/opencode/src/__tests__/opencode-relay-handle.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 `acp-link` 私有行为已迁入插件包
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "Token:\\\\s\\*\\(\\[a-f0-9\\]\\{64\\}\\)|SIGTERM|SIGKILL|keep_alive" mothership/plugins/opencode/src`
  - 预期: 相关实现仅出现在 `plugins/opencode` 下
- [x] 检查 `ProviderPlugin` 实现完整
  - `cd /Users/liyuan/Work/mothership-beta && rg -n "prepareEnvironment|injectRuntimeConfig|startInstance|stopInstance|connectRelay" mothership/plugins/opencode/src/opencode-plugin.ts`
  - 预期: `opencode-plugin.ts` 实现全部核心方法
- [x] 检查本 Task 单测通过
  - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test plugins/opencode/src/__tests__/acp-link-process-manager.test.ts plugins/opencode/src/__tests__/opencode-relay-handle.test.ts`
  - 预期: 两个测试文件全部通过

---

### Task 8: 阶段二验收

**前置条件:**
- 启动命令: 无需启动完整 server；使用单测和结构检查验收
- 测试数据准备: 所有子进程与 WebSocket 行为均通过 mock/fake 实现
- 其他环境准备: 已完成 `spec-plan-1.md` 与本文件 Task 0

**端到端验证:**

1. 运行阶段二完整测试套件确保无回归
   - `cd /Users/liyuan/Work/mothership-beta/mothership && bun test`
   - 预期: `packages/core` 与 `plugins/opencode` 的新增测试全部通过
   - 失败排查: 检查 Task 5、Task 6、Task 7 的测试步骤

2. 验证 Core 不再直接包含 opencode 私有配置结构
   - `cd /Users/liyuan/Work/mothership-beta && rg -n "opencode\\.json|Token:\\s*\\(|acp-link --host" mothership/packages/core mothership/apps/server`
   - 预期: 无匹配结果；这些字符串只出现在 `plugins/opencode`
   - 失败排查: 检查 Task 6、Task 7 的边界收敛步骤

3. 验证 Core 服务可通过 PluginRegistry 驱动插件启动链路
   - `cd /Users/liyuan/Work/mothership-beta && bun test mothership/packages/core/src/__tests__/instance-service.test.ts`
   - 预期: `startInstance` 相关测试通过，证明服务层通过 registry 调用插件
   - 失败排查: 检查 Task 5 的服务编排步骤

4. 验证 opencode relay 不向前端透传 `keep_alive`
   - `cd /Users/liyuan/Work/mothership-beta && bun test mothership/plugins/opencode/src/__tests__/opencode-relay-handle.test.ts`
   - 预期: `keep_alive` 过滤场景通过
   - 失败排查: 检查 Task 7 的 relay 过滤步骤
