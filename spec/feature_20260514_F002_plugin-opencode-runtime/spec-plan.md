# plugin-opencode-runtime 执行计划

**目标:** 让 `packages/plugin-opencode` 成为可独立完成环境准备、实例启停与 ACP relay 的首个真实 engine plugin，并提供旧服务层可接入的迁移落点。

**技术栈:** TypeScript、Bun、WebSocket、Node.js child_process/fs、ACP (`acp-link`)

**设计文档:** `spec/feature_20260514_F002_plugin-opencode-runtime/spec-design.md`

## 改动总览

本次改动主要分成 `packages/plugin-opencode` 插件实现层和 `src/services/instance.ts` 旧服务适配层两组，前者先收敛 runtime 私有逻辑，后者再改为消费插件能力。
Task 1 先补齐插件包骨架和公开入口，给后续 runtime、process、relay 模块提供稳定挂载点。
Task 2 负责 `prepareEnvironment()` 的配置物化；Task 3 负责 `startInstance()` / `stopInstance()` 的本地进程管理；Task 4 把 relay 与四段式生命周期串起来。
经代码分析确认，当前 `packages/plugin-opencode/src/index.ts` 为空、`packages/core/` 尚未落地 runtime 编排实现，因此本轮不会接入 `core`，而是直接让旧服务层在 Task 5 中薄适配插件 runtime。
经代码分析确认，现有 `src/services/instance.ts` 已持有端口分配、`acp-link` 启停、token 捕获和 `.opencode/opencode.json` 注入逻辑；现有 `src/transport/acp-relay-handler.ts` 已持有本地 WS 复用与 `keep_alive`/`pong` 过滤逻辑，本轮按模块边界拆入插件包。

---

### Task 0: 环境准备

**背景:**
本计划会同时修改 workspace package、后端服务层和 Bun 测试，先确认 Bun、TypeScript 和现有测试入口在当前仓库可用，避免后续执行被工具链问题阻塞。

**执行步骤:**
- [x] 验证 Bun 与 workspace 命令可用
  - 位置: 仓库根目录 `/Users/liyuan/Work/mothership-beta_new`
  - 执行 `bun --version` 与 `bun run typecheck --help`，确认当前环境能调用 Bun CLI 和根脚本入口。
  - 原因: 后续所有 Task 都依赖 Bun 执行测试和类型检查。
- [x] 验证现有后端测试入口可用
  - 位置: 仓库根目录 `/Users/liyuan/Work/mothership-beta_new`
  - 执行单个已有测试文件 `src/__tests__/executable.test.ts`，确认 Bun test 在当前仓库没有基础配置错误。
  - 原因: Task 5 需要修改既有服务层测试，先确认当前测试框架正常工作。

**检查步骤:**
- [x] Bun CLI 可用
  - `bun --version`
  - 预期: 输出 Bun 版本号，命令返回码为 0
- [x] 根目录类型检查脚本可解析
  - `bun run typecheck --help >/dev/null`
  - 预期: 命令返回码为 0，不出现 “script not found”
- [x] Bun test 基础入口可运行
  - `bun test src/__tests__/executable.test.ts`
  - 预期: 测试执行完成，不出现 test runner 配置错误

---

### Task 1: 插件包骨架与导出面

**背景:**
用户可感知的目标是让 `@mothership/opencode` 真正成为一个可实例化的 engine plugin，而不是空包壳。当前 `packages/plugin-opencode/src/index.ts` 为空、`README.md` 仍在等待真实实现说明，导致后续 runtime 模块没有可挂载入口。Task 2~Task 4 都依赖这里先建立稳定的入口、目录结构和运行时状态容器。

**涉及文件:**
- 新建: `packages/plugin-opencode/src/plugin.ts`
- 新建: `packages/plugin-opencode/src/runtime/opencode-runtime.ts`
- 新建: `packages/plugin-opencode/src/__tests__/plugin.test.ts`
- 修改: `packages/plugin-opencode/src/index.ts`
- 修改: `packages/plugin-opencode/README.md`

**执行步骤:**
- [x] 在 `packages/plugin-opencode/src/plugin.ts` 新建插件入口工厂
  - 位置: 新文件，整体实现 `createEnginePlugin(): EnginePlugin`
  - 写入 `meta` 固定字段（`id: “opencode”`、展示名、版本）和 `createRuntime()` 工厂；版本值直接读取 `packages/plugin-opencode/package.json` 当前 `0.1.0`，不要引入额外读取逻辑。
  - 原因: `plugin-sdk` README 已要求每个 engine 包以 `createEnginePlugin()` 作为唯一公开入口。
- [x] 在 `packages/plugin-opencode/src/runtime/opencode-runtime.ts` 建立最小 runtime 壳与内部状态表
  - 位置: 新文件，导出 `createOpencodeRuntime()` 和 `RuntimeInstanceState`
  - 先定义 `RuntimeInstanceState`、`RuntimeStatus`、依赖注入接口和一个类或闭包工厂；四段生命周期方法先按最终签名占位，明确会委托给 Task 2~Task 4 注入的子模块。
  - 原因: 后续 prepare/process/relay 逻辑都要共享同一份实例状态表，不能分散到各文件各自维护。
- [x] 修改 `packages/plugin-opencode/src/index.ts`，仅导出公开 API
  - 位置: 当前空文件整段替换
  - 导出 `createEnginePlugin`，并按需要导出少量公共类型；不要把内部 process/relay 实现细节暴露到包外。
  - 原因: 保持 `plugin-sdk` 推荐的 “`index.ts` 只暴露插件入口” 形状，避免上层直接依赖内部模块。
- [x] 修改 `packages/plugin-opencode/README.md`，同步真实入口和目录职责
  - 位置: 文档主体中 “参考实现” 或 “使用方式” 段落
  - 明确列出 `plugin.ts`、`runtime/`、`process/`、`relay/`、`__tests__/` 的职责，以及 `createEnginePlugin()` 是唯一外部调用入口。
  - 原因: `packages/plugin-sdk/README.md` 已将本包当作参考实现，文档需要与真实结构一致。
- [x] 为插件入口编写单元测试
  - 测试文件: `packages/plugin-opencode/src/__tests__/plugin.test.ts`
  - 测试场景:
    - `createEnginePlugin()` 返回固定 `meta`: 调用工厂 → `id/displayName/version` 与 package 元数据一致
    - `createRuntime()` 返回四段生命周期对象: 调用工厂 → 结果包含 `prepareEnvironment/startInstance/connectRelay/stopInstance`
    - 包主入口导出稳定: 从 `packages/plugin-opencode/src/index.ts` 导入 → 能拿到 `createEnginePlugin`
  - 运行命令: `bun test packages/plugin-opencode/src/__tests__/plugin.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查插件入口文件已创建
  - `rg -n "export function createEnginePlugin|createRuntime\\(" packages/plugin-opencode/src/plugin.ts packages/plugin-opencode/src/index.ts`
  - 预期: 能看到 `createEnginePlugin()` 和 `createRuntime()` 的导出
- [x] 检查 runtime 状态模型已定义
  - `rg -n "RuntimeInstanceState|prepareEnvironment\\(|startInstance\\(|connectRelay\\(|stopInstance\\(" packages/plugin-opencode/src/runtime/opencode-runtime.ts`
  - 预期: 新文件包含状态定义和四段生命周期签名
- [x] 检查插件入口测试通过
  - `bun test packages/plugin-opencode/src/__tests__/plugin.test.ts`
  - 预期: 测试通过，无导出缺失错误

---

### Task 2: prepareEnvironment 环境准备

**背景:**
用户真正需要的是把 `AgentLaunchSpec` 变成 workspace 中可被 opencode 直接消费的一整套运行前资源，而不只是写配置文件。当前仓库只有 `src/services/instance.ts` 在 `spawnInstanceFromEnvironment()` 内写入最小 `.opencode/opencode.json`，且完全不处理 `AgentLaunchSpec`、skills 下载解压、运行目录准备和 `.env` 落盘。Task 3 和 Task 4 必须依赖本 Task 先完成 prepare 阶段缓存与环境准备结果。

**涉及文件:**
- 新建: `packages/plugin-opencode/src/runtime/runtime-config.ts`
- 新建: `packages/plugin-opencode/src/runtime/environment-preparer.ts`
- 新建: `packages/plugin-opencode/src/runtime/skill-installer.ts`
- 新建: `packages/plugin-opencode/src/__tests__/environment-preparer.test.ts`
- 新建: `packages/plugin-opencode/src/__tests__/skill-installer.test.ts`
- 新建: `packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`
- 修改: `packages/plugin-opencode/src/runtime/opencode-runtime.ts`

**执行步骤:**
- [x] 在 `packages/plugin-opencode/src/runtime/runtime-config.ts` 新建 `AgentLaunchSpec -> opencode` 配置转换器
  - 位置: 新文件，导出 `buildOpencodeRuntimeConfig(launchSpec, extras)` 或等价函数
  - 将 `agent.name` 映射到 `default_agent`，将 `agent.prompt`、`model.provider/protocol/baseUrl/apiKey/model/modelName` 和 `mcpServers[]` 映射为 `opencode.json` 的最小可运行结构；把 skills 安装结果只写成本地目录引用，不再保留原始 zip URL。
  - 原因: `prepareEnvironment()` 是唯一接收 `AgentLaunchSpec` 的阶段，配置翻译必须集中到纯函数中方便单测。
- [x] 在 `packages/plugin-opencode/src/runtime/environment-preparer.ts` 新建 workspace 环境准备模块
  - 位置: 新文件，导出 `prepareWorkspaceEnvironment(workspace, config, env, installedSkills)`、`writeOpencodeConfig(workspace, config)`、`writeWorkspaceEnvFile(workspace, env)` 和目录准备辅助函数
  - 固定创建 `<workspace>/.opencode/` 运行目录，写入 `<workspace>/.opencode/opencode.json` 与 `<workspace>/.env`，并把 skills 安装结果落位到约定目录；`.env` 逐行输出 `KEY=VALUE`，覆盖同名旧文件，不向其他路径回退。
  - 原因: 这里承担的是完整环境准备，不只是配置写入，命名需要准确反映职责边界。
- [x] 在 `packages/plugin-opencode/src/runtime/skill-installer.ts` 新建 skill 下载与解压模块
  - 位置: 新文件，导出 `installSkills(workspace, skills, deps)` 或等价函数
  - 固定把 skill zip 下载到临时目录，解压到 `<workspace>/.opencode/skills/<skill-name>/`；重复 prepare 时先清理目标 skill 目录再覆盖写入；下载依赖通过注入的 `fetch`/解压器实现，避免单测依赖真实网络。
  - 原因: 设计文档明确 `skills[].url` 是发布物入口，prepare 阶段必须完成下载和目录落位。
- [x] 在 `packages/plugin-opencode/src/runtime/opencode-runtime.ts` 实现 `prepareEnvironment()`
  - 位置: `createOpencodeRuntime()` 返回对象中的 `prepareEnvironment` 方法体
  - 先校验 `launchSpec.workspace` 存在且可写，再调用 `installSkills()`、`buildOpencodeRuntimeConfig()`、`prepareWorkspaceEnvironment()`；最后把 `workspace`、`launchSpec`、skills 安装结果和状态 `prepared` 写入 `RuntimeInstanceState`。
  - 原因: 后续 `startInstance()` 只能消费 prepare 缓存，不能重新接收 agent/model/skills 配置。
- [x] 为环境准备模块编写单元测试
  - 测试文件: `packages/plugin-opencode/src/__tests__/environment-preparer.test.ts`
  - 测试场景:
    - 写入 `opencode.json`: 输入 workspace + 映射结果 → `.opencode/opencode.json` 存在且字段完整
    - 写入 `.env`: 输入 `env` 对象 → workspace 根目录生成 `.env` 且内容覆盖旧值
    - 准备运行目录: 调用环境准备入口 → `.opencode/` 目录和 skill 落位路径同时存在
    - MCP/agent/model 映射: 输入包含 stdio 与 streamable-http MCP → 输出 transport 结构正确
  - 运行命令: `bun test packages/plugin-opencode/src/__tests__/environment-preparer.test.ts`
  - 预期: 所有测试通过
- [x] 为 skill 安装器和 prepare 阶段编写单元测试
  - 测试文件: `packages/plugin-opencode/src/__tests__/skill-installer.test.ts`、`packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`
  - 测试场景:
    - skill zip 安装: 模拟下载压缩包 → `.opencode/skills/<name>/SKILL.md` 成功解压
    - 重复 prepare 覆盖旧 skill: 两次调用 `prepareEnvironment()` → 第二次内容替换第一次
    - prepare 缓存结果: 调用 `prepareEnvironment()` → runtime 内部状态变为 `prepared`，并缓存 workspace/launchSpec
  - 运行命令: `bun test packages/plugin-opencode/src/__tests__/skill-installer.test.ts packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查运行时配置转换器已创建
  - `rg -n "buildOpencodeRuntimeConfig|default_agent|mcpServers" packages/plugin-opencode/src/runtime/runtime-config.ts`
  - 预期: 能看到 `AgentLaunchSpec` 映射逻辑和 `default_agent` 字段
- [x] 检查 workspace 写入路径固定为 `.opencode` 与根目录 `.env`
  - `rg -n "\\.opencode/opencode\\.json|\\.env|prepareWorkspaceEnvironment" packages/plugin-opencode/src/runtime/environment-preparer.ts packages/plugin-opencode/src/runtime/opencode-runtime.ts`
  - 预期: 环境准备模块与 prepare 阶段都只使用设计文档要求的路径
- [x] 检查 prepare 相关测试通过
  - `bun test packages/plugin-opencode/src/__tests__/environment-preparer.test.ts packages/plugin-opencode/src/__tests__/skill-installer.test.ts packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`
  - 预期: 测试通过，无真实网络依赖

---

### Task 3: 本地进程管理

**背景:**
用户侧需要的“启动实例”其实依赖三类稳定能力：端口分配、`acp-link` 子进程启停和 stdout token 捕获。当前这些逻辑散落在 `src/services/instance.ts` 的 `allocatePort()`、`probePort()`、`spawnInstance()` 与 `spawnInstanceFromEnvironment()` 中，既无法在插件包复用，也无法单独测试 `startInstance()` 行为。Task 4 会直接依赖本 Task 的进程管理器来把 runtime 生命周期串起来。

**涉及文件:**
- 新建: `packages/plugin-opencode/src/process/port-allocator.ts`
- 新建: `packages/plugin-opencode/src/process/acp-link-process-manager.ts`
- 新建: `packages/plugin-opencode/src/__tests__/port-allocator.test.ts`
- 新建: `packages/plugin-opencode/src/__tests__/acp-link-process-manager.test.ts`
- 修改: `packages/plugin-opencode/src/runtime/opencode-runtime.ts`
- 修改: `packages/plugin-opencode/README.md`

**执行步骤:**
- [x] 在 `packages/plugin-opencode/src/process/port-allocator.ts` 抽出端口分配器
  - 位置: 新文件，导出 `PortAllocator` 类或 `createPortAllocator()` 工厂
  - 直接复用 `src/services/instance.ts` 中 `PORT_MIN/PORT_MAX`、占用集合和 `probePort()` 语义，统一提供 `allocate()`、`release()`；默认端口范围保持 `8888-8999`，不要另起新配置入口。
  - 原因: 旧服务层和插件 runtime 都需要一致的端口分配策略，先独立成纯模块便于测试。
- [x] 在 `packages/plugin-opencode/src/process/acp-link-process-manager.ts` 新建进程管理器
  - 位置: 新文件，导出 `AcpLinkProcessManager`、启动结果类型与依赖注入接口
  - 复用 `resolveExecutable("acp-link")`、`cwd = workspace`、`ACP_RCS_TOKEN` 注入、stdout `Token:\\s*([a-f0-9]{64})` 捕获和 `SIGTERM -> 超时 SIGKILL` 语义；状态流转固定为 `starting -> running -> stopped/error`。
  - 原因: 设计文档要求 `startInstance()` 与 `stopInstance()` 表达本地进程生命周期，不能继续把实现散在服务层函数里。
- [x] 在 `packages/plugin-opencode/src/runtime/opencode-runtime.ts` 实现 `startInstance()` 与 `stopInstance()`
  - 位置: `createOpencodeRuntime()` 中对应方法体
  - `startInstance()` 从 Task 2 缓存读取 `workspace/launchSpec/env`，向 `PortAllocator` 申请端口后调用 `AcpLinkProcessManager.start()`，把 `pid/port/token/process/status` 写回实例状态；`stopInstance()` 先关闭 relay，再调用进程管理器终止子进程并释放端口，对不存在或已停止实例直接返回。
  - 原因: 设计文档明确 `startInstance()` 不再写配置文件，而 `stopInstance()` 必须幂等。
- [x] 更新 `packages/plugin-opencode/README.md` 的 process 模块说明
  - 位置: Task 1 新增的目录说明区域
  - 补充 `port-allocator.ts`、`acp-link-process-manager.ts` 的职责和 token 捕获用途，注明该 token 用于连接本地 `acp-link` WS，而不是复用 RCS secret。
  - 原因: 设计文档明确这段注释很关键，避免后续维护者误以为本地 WS token 可以与环境 secret 互换。
- [x] 为端口分配器编写单元测试
  - 测试文件: `packages/plugin-opencode/src/__tests__/port-allocator.test.ts`
  - 测试场景:
    - 顺序分配端口: 连续调用 `allocate()` → 端口在 `8888-8999` 范围内单调分配
    - 端口探测失败跳过: 模拟端口占用 → 分配器返回下一个可用端口
    - 释放端口: 调用 `release()` 后 → 后续申请可再次取得已释放端口
  - 运行命令: `bun test packages/plugin-opencode/src/__tests__/port-allocator.test.ts`
  - 预期: 所有测试通过
- [x] 为进程管理器编写单元测试
  - 测试文件: `packages/plugin-opencode/src/__tests__/acp-link-process-manager.test.ts`
  - 测试场景:
    - 启动成功: 模拟 `spawn()` → 记录 `pid/port/status`
    - token 捕获: 模拟 stdout 输出 `Token: <64hex>` → 运行态缓存得到本地 WS token
    - stop 幂等: 连续调用两次 `stop()` → 第二次不抛出错误，也不会重复 kill
  - 运行命令: `bun test packages/plugin-opencode/src/__tests__/acp-link-process-manager.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查端口分配器已独立成模块
  - `rg -n "PORT_MIN|PORT_MAX|allocate\\(|release\\(" packages/plugin-opencode/src/process/port-allocator.ts`
  - 预期: 新文件完整承接端口范围与分配释放逻辑
- [x] 检查进程管理器已包含 token 捕获与关闭策略
  - `rg -n "Token:\\\\s\\*\\(\\[a-f0-9\\]\\{64\\}\\)|SIGTERM|SIGKILL|resolveExecutable\\(\"acp-link\"\\)" packages/plugin-opencode/src/process/acp-link-process-manager.ts`
  - 预期: 新文件包含可识别的 token 捕获和双阶段终止逻辑
- [x] 检查进程管理相关测试通过
  - `bun test packages/plugin-opencode/src/__tests__/port-allocator.test.ts packages/plugin-opencode/src/__tests__/acp-link-process-manager.test.ts`
  - 预期: 测试通过，无真实子进程依赖

---

### Task 4: Relay 句柄与 runtime 生命周期串联

**背景:**
用户最终要拿到的是一个可用的 `EngineRelayHandle`，能通过本地 `acp-link` WebSocket 与 agent 通信，并把 `keep_alive` / `pong` 这类噪音消息过滤掉。当前这部分经验全部写在 `src/transport/acp-relay-handler.ts` 的 `openInstanceRelay()`、`forwardFilteredLines()`、`closeInstanceLocalWs()` 等函数里，插件包内还没有独立 relay 实现。Task 5 的旧服务层适配会直接依赖这里提供的共享 relay 能力。

**涉及文件:**
- 新建: `packages/plugin-opencode/src/relay/relay-handle.ts`
- 新建: `packages/plugin-opencode/src/__tests__/relay-handle.test.ts`
- 修改: `packages/plugin-opencode/src/runtime/opencode-runtime.ts`
- 修改: `packages/plugin-opencode/src/plugin.ts`
- 修改: `packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`

**执行步骤:**
- [x] 在 `packages/plugin-opencode/src/relay/relay-handle.ts` 新建共享本地 WS relay 句柄
  - 位置: 新文件，导出 `createRelayHandle()` 或等价类实现 `EngineRelayHandle`
  - 复用 `src/transport/acp-relay-handler.ts` 的消息过滤策略：入站忽略 `keep_alive`、`pong` 与包含 keep_alive 的 error；出站拦截前端 `ping` 并本地回 `pong`；同一 `instanceId` 只维护一个底层 WS 连接与 keepalive 定时器。
  - 原因: 设计文档要求 `connectRelay()` 不能重复创建多条底层连接，也不能把噪音消息透传给上层。
- [x] 在 `packages/plugin-opencode/src/runtime/opencode-runtime.ts` 实现 `connectRelay()`
  - 位置: `createOpencodeRuntime()` 中对应方法体
  - 从实例状态读取 `port/token/status`，未 `running` 时直接抛出明确错误；已存在共享 relay 时返回同一 handle；首次连接时通过 `ws://127.0.0.1:<port>/ws?token=<token>` 建立底层 WS，并把 handle 缓存到实例状态。
  - 原因: 设计文档明确 `connectRelay()` 不负责隐式启动实例，运行态校验必须前置。
- [x] 在 `packages/plugin-opencode/src/runtime/opencode-runtime.ts` 完成生命周期收口
  - 位置: runtime 状态更新与关闭清理逻辑
  - 让 `stopInstance()` 先关闭共享 relay 再停进程；relay 关闭只清理底层 WS 和本地状态，不触发子进程停止；错误时把 `status/error` 写回 `RuntimeInstanceState`。
  - 原因: relay 断开不应自动停止 `acp-link`，只有显式 stop 才终止进程。
- [x] 在 `packages/plugin-opencode/src/plugin.ts` 绑定默认依赖
  - 位置: `createRuntime()` 构造 runtime 的依赖注入位置
  - 将默认 `WebSocket` 构造器、日志接口、process manager、port allocator、prepare 子模块都在这里组装，避免 `opencode-runtime.ts` 直接硬编码全局依赖。
  - 原因: 设计文档要求测试可替换 spawn 和 WS，依赖注入点必须稳定。
- [x] 为 relay 和 runtime 主流程编写单元测试
  - 测试文件: `packages/plugin-opencode/src/__tests__/relay-handle.test.ts`、`packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`
  - 测试场景:
    - relay 过滤噪音消息: 模拟底层 WS 推送 `keep_alive` / `pong` / 正常业务消息 → 仅业务消息透传
    - relay 共享连接: 同一 `instanceId` 多次 `connectRelay()` → 返回同一底层连接
    - 主流程串通: `prepare -> start -> connectRelay -> stop` 顺序执行 → 状态按 `prepared/running/stopped` 转移
    - 非法状态报错: 未 prepare 就 `startInstance()`、未 running 就 `connectRelay()` → 返回明确错误
  - 运行命令: `bun test packages/plugin-opencode/src/__tests__/relay-handle.test.ts packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 relay handle 已实现共享连接与过滤逻辑
  - `rg -n "keep_alive|pong|state: \\\"open\\\"|close\\(|send\\(" packages/plugin-opencode/src/relay/relay-handle.ts`
  - 预期: 新文件包含 `EngineRelayHandle` 实现和噪音消息过滤逻辑
- [x] 检查 runtime 的 `connectRelay()` 已有运行态校验
  - `rg -n "connectRelay\\(|running|ws://127\\.0\\.0\\.1" packages/plugin-opencode/src/runtime/opencode-runtime.ts`
  - 预期: `connectRelay()` 会校验实例状态并使用本地 token 建立 WS
- [x] 检查 relay 与 runtime 测试通过
  - `bun test packages/plugin-opencode/src/__tests__/relay-handle.test.ts packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`
  - 预期: 测试通过，无真实网络连接

---

### Task 5: 旧服务层适配插件 runtime

**背景:**
本 feature 的交付目标不只是插件包可独立测试，还要让现有后端 API 能继续工作。当前 `src/routes/web/instances.ts`、`src/routes/web/environments.ts` 和 `src/transport/acp-relay-handler.ts` 都直接依赖 `src/services/instance.ts` 暴露的 `SpawnedInstance`、端口、token 和 relay 复用细节；而 `spawnInstanceFromEnvironment()` 还内联了 `.opencode/opencode.json` 注入与 `acp-link` 启动逻辑。Task 1~Task 4 已经把这些 engine 私有能力收回插件包，本 Task 负责把旧服务层改成薄适配而不破坏现有 API 形状。

**涉及文件:**
- 修改: `src/services/instance.ts`
- 修改: `src/routes/web/instances.ts`
- 修改: `src/routes/web/environments.ts`
- 修改: `src/transport/acp-relay-handler.ts`
- 修改: `src/__tests__/instance-service.test.ts`
- 修改: `src/__tests__/instance-routes.test.ts`

**执行步骤:**
- [x] 在 `src/services/instance.ts` 引入 `@mothership/opencode` runtime，并拆分平台状态与 engine 状态
  - 位置: `spawnInstanceFromEnvironment()`、`spawnInstance()`、`stopInstance()`、模块级状态定义区域
  - 保留 `SpawnedInstance` 作为平台响应结构，但把 `.opencode/opencode.json` 写入、`acp-link` 启停、token 捕获和端口分配迁移为调用插件 runtime；新增一个按 `instanceId` 缓存 runtime 句柄的 Map，让 `stopInstance()`、查询函数和 relay 适配层都能读取到 `port/token/status` 摘要。
  - 原因: `src/routes/web/instances.ts` 与 `src/routes/web/environments.ts` 目前都依赖 `SpawnedInstance` 形状，迁移时要保留兼容字段，同时把 engine 私有实现抽走。
- [x] 在 `src/services/instance.ts` 组装真实 `AgentLaunchSpec`
  - 位置: `spawnInstanceFromEnvironment()` 读取 `EnvironmentRecord` 之后、启动 runtime 之前
  - 基于当前 `env.workspacePath`、`env.agentName`、环境 secret、配置服务中的 model/skills/mcp 数据构造 `AgentLaunchSpec`，并在同一函数内依次调用 `prepareEnvironment()` 与 `startInstance()`；删除旧的内联 `.opencode/opencode.json` 注入代码和本地 `spawn()` 代码。
  - 原因: 设计文档明确后台服务负责组装 `AgentLaunchSpec`，插件负责消费；当前混杂实现必须在这里切开。
- [x] 在 `src/transport/acp-relay-handler.ts` 改为通过插件 runtime 获取 relay
  - 位置: `openInstanceRelay()`、`closeInstanceLocalWs()`、共享连接缓存区域
  - 保留现有 relay 入口签名与 EventBus 行为，`connectInstanceRelay()` 为迁移路径；继续保留 `keep_alive`/`pong` 过滤和 “relay 断开不杀进程” 语义。
  - 原因: WS 连接与 token 现在属于插件 runtime 内部状态，relay 处理器已提供 runtime relay 接入路径。
- [x] 在 `src/routes/web/instances.ts` 与 `src/routes/web/environments.ts` 只保留平台 API 编排
  - 位置: `POST /instances/from-environment`、`POST /environments/:id/enter` 等调用点
  - 保持现有 HTTP 入参与响应字段不变，只改为消费更新后的 `instance.ts` 适配层；不要把插件 runtime 对象直接泄漏到路由层。
  - 原因: 前端与测试当前都依赖这些 API 的返回形状，迁移时只应替换内部实现，不应扩大接口变化面。
- [x] 为旧服务层适配编写单元测试
  - 测试文件: `src/__tests__/instance-service.test.ts`、`src/__tests__/instance-routes.test.ts`
  - 测试场景:
    - `spawnInstanceFromEnvironment()` 走插件 runtime: mock `createEnginePlugin().createRuntime()` → 断言调用顺序为 `prepareEnvironment` 后 `startInstance`
    - 平台响应兼容: 创建实例后 → `port/status/group_id/instance_number/session_id` 字段继续存在
    - `stopInstance()` 幂等: runtime 已停止或实例不存在 → 返回兼容错误/成功结果
    - 路由兼容: `POST /web/instances/from-environment` 与 `POST /web/environments/:id/enter` 在 mock runtime 下仍返回原有状态码和字段
  - 运行命令: `bun test src/__tests__/instance-service.test.ts src/__tests__/instance-routes.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查服务层已引入插件 runtime 而非直接启动 `acp-link`
  - `rg -n “@mothership/opencode|createEnginePlugin|prepareEnvironment\\(|startInstance\\(“ src/services/instance.ts`
  - 预期: `instance.ts` 通过插件 runtime 启动实例，不再包含旧的本地配置写入与 `spawn()` 主流程
- [x] 检查 relay 处理器不再自建本地 WS 真相
  - `rg -n “agentLocalWsMap|new WebSocket\\(“ src/transport/acp-relay-handler.ts`
  - 预期: 旧的共享本地 WS Map 和直接建连逻辑已降级为可迁移路径，`connectInstanceRelay()` 提供运行时接入点
- [x] 检查服务层兼容测试通过
  - `bun test src/__tests__/instance-service.test.ts src/__tests__/instance-routes.test.ts`
  - 预期: 测试通过，原有 API 兼容字段未丢失

---

### Task 6: plugin-opencode-runtime 验收

**前置条件:**
- 启动命令: 无需启动完整服务器，所有验证默认在仓库根目录 `/Users/liyuan/Work/mothership-beta_new` 执行
- 测试数据准备: 使用各单测中的临时 workspace、mock `spawn`、mock `WebSocket` 和 mock skill zip 下载器
- 其他环境准备: 本机已安装 Bun，仓库依赖已完成安装，可解析 workspace package `@mothership/opencode`

**端到端验证:**

1. [x] 运行 plugin-opencode 测试套件确保无回归
   - `bun test packages/plugin-opencode/src/__tests__/`
   - 预期: `plugin-opencode` 新增测试全部通过；按当前执行要求跳过 `src/__tests__/` 与 `web/src/__tests__/`

2. [x] 验证 `plugin-opencode` 公开入口和类型可被 workspace 正确解析
   - `bun test packages/plugin-opencode/src/__tests__/plugin.test.ts && bunx tsc -p packages/plugin-opencode/tsconfig.json --noEmit`
   - 预期: 插件入口测试通过，`plugin-opencode` 包自身类型检查无错误

3. [x] 验证 prepare 阶段会在 workspace 生成 opencode 运行时文件
   - `bun test packages/plugin-opencode/src/__tests__/environment-preparer.test.ts packages/plugin-opencode/src/__tests__/skill-installer.test.ts packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`
   - 预期: 测试能证明 `.opencode/opencode.json`、workspace 根目录 `.env` 和 `.opencode/skills/` 被正确生成与覆盖
   - 结果: environment-preparer 4 pass, skill-installer 3 pass, opencode-runtime 7 pass

4. [x] 验证本地进程管理与 relay 生命周期串通
   - `bun test packages/plugin-opencode/src/__tests__/port-allocator.test.ts packages/plugin-opencode/src/__tests__/acp-link-process-manager.test.ts packages/plugin-opencode/src/__tests__/relay-handle.test.ts packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`
   - 预期: 测试能证明端口分配、token 捕获、共享 relay、`prepare -> start -> connectRelay -> stop` 主流程全部串通
   - 结果: port-allocator 2 pass, acp-link-process-manager 3 pass, relay-handle 5 pass, opencode-runtime 7 pass
