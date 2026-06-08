# 双引擎支持（dual-engine-support）执行计划

**目标:** 实现 opencode 和 claude-code 双引擎共存，全面清理架构债务，将所有 engineType 硬编码替换为动态读取，重组 acp-link 为 bridge 调度器 + WS↔bridge 路由层。

**技术栈:** Elysia/Bun、Drizzle ORM（PostgreSQL）、@anthropic-ai/claude-agent-sdk@0.2.112、@agentclientprotocol/sdk、React 19、TanStack Router、Zod v4、Biome v2.4.15

**设计文档:** spec/feature_20260601_F001_dual-engine-support/spec-design.md

## 改动总览

本次改动围绕 opencode + claude-code 双引擎共存，按从底层到上层的依赖顺序分为 12 个 Task（Task 0 环境准备、Task 1-10 功能实现、Task 11 验收）。Task 0 环境准备，Task 1 创建 DB 字段，Task 2 扩展 plugin-sdk 接口，Task 3-5 新增 bridge/plugin 包，Task 6 适配 opencode plugin，Task 7-8 重构 RCS 服务端，Task 9 重组 acp-link（代码中已实现），Task 10 前端 UI，Task 11 验收。每个 Task 的输出被后续 Task 依赖（如 Task 1 的 engineType 字段是 Task 7 的 instance.ts 动态读取的前提）。经代码分析确认：agentConfig 表已有 engineType 字段，machine 表已有 supportedEngineTypes 字段，AGENT_SETTABLE_FIELDS 已包含 "engineType"，registry 服务注册 machine 时已接收 supportedEngineTypes 参数，acp-link 已完成 bridge 模块重组（instance-manager/session-manager 已删除）。前端 AgentFormDialog/AgentSidebarTree/types/config/agent-utils 尚未包含 engineType，i18n 尚未添加引擎翻译 key。

---

### Task 0: 环境准备

**背景:**
确保构建和测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**
- [x] 验证构建工具可用
  - `bun run build:web 2>&1 | tail -5`
  - 验证前端构建成功
  - `bunx tsc --noEmit 2>&1 | tail -10`
  - 验证 TypeScript 编译无错误
- [x] 验证测试工具可用
  - `bun test src/__tests__/ 2>&1 | tail -10`
  - 验证后端测试框架可用
  - `bun test packages/plugin-opencode/src/__tests__/ 2>&1 | tail -5`
  - 验证 workspace 包测试可用
- [x] 安装新依赖 @anthropic-ai/claude-agent-sdk
  - `bun add @anthropic-ai/claude-agent-sdk@0.2.112`
  - 验证 claude-agent-sdk 安装成功
  - `bun -e "import { query } from '@anthropic-ai/claude-agent-sdk'; console.log('SDK loaded')" 2>&1`
  - 预期: 输出 "SDK loaded"

**检查步骤:**
- [x] 构建命令执行成功
  - `bun run build:web 2>&1 | grep "built in"`
  - 预期: 构建成功，无错误
- [x] 测试命令可用
  - `bun test src/__tests__/agent-config-build-set.test.ts 2>&1 | tail -5`
  - 预期: 测试框架可用，无配置错误

---

### Task 1: DB Schema 变更 + 数据库迁移

**背景:**
业务需求 — 每个 Agent 配置需要选择执行引擎类型（opencode / claude-code），每台远端 machine 需声明支持的引擎列表，以实现双引擎共存和动态路由。
修改原因 — 当前 agentConfig 表无 engineType 字段（代码中 6 处硬编码 `"opencode"`），machine 表无 supportedEngineTypes 字段（远端 node 注册时 engineTypes 硬编码为 `["opencode"]`）。新增这两个字段为后续 Task 7 的 instance.ts 动态读取 engineType、Task 7 的 core-bootstrap.ts 动态读取 machine.supportedEngineTypes 提供数据基础。
上下游影响 — Task 1 的输出被 Task 7（instance.ts 从 AgentConfig.engineType 动态读取、core-bootstrap.ts 从 machine.supportedEngineTypes 动态注册 node）和 Task 10（前端 Agent 配置表单的 engineType 下拉）直接依赖。本 Task 无前置依赖。

**涉及文件:**
- 修改: `src/db/schema.ts`
- 修改: `src/services/config/agent-config.ts`（AGENT_SETTABLE_FIELDS 追加 "engineType"、validateAgentData 新增校验）
- 修改: `src/services/config/types.ts`（新增 EngineType 类型常量）
- 修改: `src/schemas/registry.schema.ts`（MachineSchema 新增 supportedEngineTypes 字段）
- 修改: `src/schemas/config.schema.ts`（AgentDetailSchema 新增 engineType 字段）
- 修改: `src/services/registry.ts`（registerMachine 新增 supportedEngineTypes 参数、registerRemoteNode 传 engineTypes）
- 修改: `src/transport/acp-ws-handler.ts`（handleMachineRegister 解析 supported_engine_types）
- 修改: `src/routes/web/config/agents.ts`（handleGet/handleSet/handleCreate 输出和接收 engineType）
- 新建: `drizzle/0002_add-engine-type-fields.sql`（迁移 SQL）
- 新建: `drizzle/meta/0002_snapshot.json`（drizzle-kit 生成的快照）
- 修改: `drizzle/meta/_journal.json`（drizzle-kit 追加 entry）

**执行步骤:**

- [x] 在 `src/services/config/types.ts` 中新增引擎类型常量
  - 位置: `src/services/config/types.ts` 文件末尾追加
  - 新增 `ENGINE_TYPES` 常量和 `EngineType` 类型：
    ```typescript
    export const ENGINE_TYPES = ["opencode", "claude-code"] as const;
    export type EngineType = (typeof ENGINE_TYPES)[number];
    ```
  - 原因: 统一引擎类型枚举，供 schema 校验、配置服务和前端共用

- [x] 在 `src/db/schema.ts` 的 agentConfig 表定义中新增 engineType 字段
  - 位置: `src/db/schema.ts` 的 agentConfig 表定义中，`machineId` 字段之后（~L512 处）
  - 新增列定义：
    ```typescript
    engineType: varchar("engine_type", { length: 32 }).default("opencode"),
    ```
  - 原因: 默认值 `"opencode"` 保证现有 Agent 数据向后兼容，无需迁移存量数据

- [x] 在 `src/db/schema.ts` 的 machine 表定义中新增 supportedEngineTypes 字段
  - 位置: `src/db/schema.ts` 的 machine 表定义中，`labels` 字段之后（~L831 处）
  - 新增列定义：
    ```typescript
    supportedEngineTypes: jsonb("supported_engine_types").default([{ type: "opencode" }]),
    ```
  - 原因: 默认值 `[{"type":"opencode"}]` 保证现有 machine 数据向后兼容，远端 machine 仅支持 opencode 时无需显式配置

- [x] 在 `src/services/config/agent-config.ts` 中将 "engineType" 加入 AGENT_SETTABLE_FIELDS 并新增校验
  - 位置: `src/services/config/agent-config.ts` ~L12 的 AGENT_SETTABLE_FIELDS 数组末尾追加 `"engineType"`
  - 修改后数组为：
    ```typescript
    const AGENT_SETTABLE_FIELDS = [
      "model", "prompt", "steps", "mode", "permission", "variant",
      "temperature", "topP", "top_p", "disable", "hidden", "color",
      "description", "machineId", "knowledge", "engineType",
    ] as const;
    ```
  - 位置: `src/services/config/agent-config.ts` 的 `validateAgentData()` 函数中，knowledge 校验之后追加 engineType 校验（~L157 之后）
  - 新增校验逻辑：
    ```typescript
    if (data.engineType !== undefined) {
      if (typeof data.engineType !== "string" || !ENGINE_TYPES.includes(data.engineType as EngineType)) {
        return "INVALID_ENGINE_TYPE";
      }
    }
    ```
  - 需在文件顶部新增 import: `import { ENGINE_TYPES, type EngineType } from "./types";`
  - 原因: engineType 必须限制为合法引擎类型字符串，防止前端传入非法值

- [x] 在 `src/schemas/config.schema.ts` 的 AgentDetailSchema 中新增 engineType 字段
  - 位置: `src/schemas/config.schema.ts` ~L101 AgentDetailSchema 的 `knowledge` 字段之后
  - 新增字段：
    ```typescript
    engineType: z.string().nullable(),
    ```
  - 原因: 前端获取 Agent 详情时需要知道该 Agent 的引擎类型

- [x] 在 `src/schemas/registry.schema.ts` 的 MachineSchema 中新增 supportedEngineTypes 字段
  - 位置: `src/schemas/registry.schema.ts` ~L9 MachineSchema 的 `machineInfo` 字段之后
  - 新增字段：
    ```typescript
    supportedEngineTypes: z.array(z.object({ type: z.string(), cliPath: z.string().optional() })).nullable(),
    ```
  - 原因: machine 列表 API 需返回每台 machine 支持的引擎类型，前端据此过滤可用的 machine

- [x] 在 `src/services/registry.ts` 的 registerMachine 参数中新增 supportedEngineTypes
  - 位置: `src/services/registry.ts` ~L123 的 registerMachine 函数参数类型
  - 新增参数：
    ```typescript
    supportedEngineTypes: { type: string; cliPath?: string }[];
    ```
  - 位置: `src/services/registry.ts` ~L155 的 machine UPDATE set 中追加 `supportedEngineTypes`
    ```typescript
    supportedEngineTypes: params.supportedEngineTypes,
    ```
  - 位置: `src/services/registry.ts` ~L175 的 machine INSERT values 中追加 `supportedEngineTypes`
    ```typescript
    supportedEngineTypes: params.supportedEngineTypes,
    ```
  - 位置: `src/services/registry.ts` 的 `registerRemoteNode()` 调用前，需从 `params.supportedEngineTypes` 提取 engineTypes 数组传给 `runtime.registerNode()`
  - 在 `src/services/registry.ts` ~L147（`registerRemoteNode(result.id, entry.ws, entry)` 调用之前），修改 core-bootstrap.ts 的 registerRemoteNode 使其接收 engineTypes 参数。但 registerRemoteNode 在 core-bootstrap.ts 中定义，此处先在 registry.ts 中提取 engineTypes 传给 registerRemoteNode：
    ```typescript
    const engineTypes = params.supportedEngineTypes.map(e => e.type);
    registerRemoteNode(result.id, entry.ws, entry, engineTypes);
    ```
  - 原因: machine 注册时需持久化支持的引擎类型，远端 node 注册时需动态传递 engineTypes

- [x] 在 `src/transport/acp-ws-handler.ts` 的 handleMachineRegister 中解析 supported_engine_types
  - 位置: `src/transport/acp-ws-handler.ts` ~L126 的 `handleMachineRegister` 函数中，`heartbeatIntervalMs` 之后新增解析：
    ```typescript
    const supportedEngineTypes = Array.isArray(msg.supported_engine_types)
      ? (msg.supported_engine_types as { type: string; cliPath?: string }[])
      : [{ type: "opencode" }];
    ```
  - 位置: 同函数中 `registerMachine()` 调用（~L134）追加 `supportedEngineTypes` 参数：
    ```typescript
    const result = await registerMachine({
      agentName,
      machineInfo: machineInfo ?? null,
      labels,
      heartbeatIntervalMs,
      tenantId,
      userId,
      supportedEngineTypes,
    });
    ```
  - 原因: acp-link WS 注册消息携带 supported_engine_types，解析后传给 registerMachine 持久化

- [x] 修改 `src/services/core-bootstrap.ts` 的 registerRemoteNode 接收 engineTypes 参数
  - 位置: `src/services/core-bootstrap.ts` ~L84 的 `registerRemoteNode` 函数签名
  - 新增参数 `engineTypes?: string[]`，默认 `["opencode"]`：
    ```typescript
    export function registerRemoteNode(
      machineId: string, ws: WsConnection, acpEntry: AcpConnectionEntry,
      engineTypes?: string[],
    ): void {
    ```
  - 位置: 同函数中 `runtime.registerNode()` 调用（~L98），将硬编码 `engineTypes: ["opencode"]` 替换为参数：
    ```typescript
    engineTypes: engineTypes ?? ["opencode"],
    ```
  - 原因: 远端 machine 的 engineTypes 应来自 DB 的 supportedEngineTypes 字段，而非硬编码

- [x] 在 `src/routes/web/config/agents.ts` 的 handleGet/handleCreate/handleSet 中输出和接收 engineType
  - 位置: `src/routes/web/config/agents.ts` ~L70 的 `handleGet` 函数返回对象中追加 `engineType`
    ```typescript
    engineType: agent.engineType ?? "opencode",
    ```
  - 位置: `src/routes/web/config/agents.ts` ~L50 的 `handleList` 函数中，agent 列表项追加 `engineType`
    ```typescript
    engineType: a.engineType ?? "opencode",
    ```
  - 位置: `src/routes/web/config/agents.ts` ~L104 的 `handleSet` 函数中，白名单已通过 AGENT_SETTABLE_FIELDS 覆盖 engineType，无需额外处理（`filtered` 循环已包含）
  - 位置: `src/routes/web/config/agents.ts` ~L149 的 `handleCreate` 函数中，同上白名单已覆盖
  - 原因: 前端需要读取和写入 Agent 的引擎类型，config 路由必须透传该字段

- [x] 生成迁移 SQL 文件
  - 执行命令: `bunx drizzle-kit generate --name add-engine-type-fields`
  - 预期生成: `drizzle/0002_add-engine-type-fields.sql` + `drizzle/meta/0002_snapshot.json` + `drizzle/meta/_journal.json` 更新
  - 迁移 SQL 应包含：
    ```sql
    ALTER TABLE "agent_config" ADD COLUMN "engine_type" varchar(32) DEFAULT 'opencode';--> statement-breakpoint
    ALTER TABLE "machine" ADD COLUMN "supported_engine_types" jsonb DEFAULT '[{"type":"opencode"}]';
    ```
  - 原因: 生产环境必须通过 migrate.js 执行迁移，禁止 db:push

- [x] 为 engineType 字段校验和 schema 变更编写单元测试
  - 测试文件: `src/__tests__/engine-type-schema.test.ts`
  - 测试场景:
    - engineType 合法值 "opencode" 通过 validateAgentData: `{ engineType: "opencode" }` → 返回 null
    - engineType 合法值 "claude-code" 通过 validateAgentData: `{ engineType: "claude-code" }` → 返回 null
    - engineType 非法值被拒绝: `{ engineType: "unknown-engine" }` → 返回 "INVALID_ENGINE_TYPE"
    - engineType 类型错误被拒绝: `{ engineType: 123 }` → 返回 "INVALID_ENGINE_TYPE"
    - engineType undefined/null 时通过校验（向后兼容）: `{ }` 或 `{ engineType: null }` → 返回 null
    - AGENT_SETTABLE_FIELDS 包含 "engineType": `AGENT_SETTABLE_FIELDS.includes("engineType")` → true
    - ENGINE_TYPES 常量包含 "opencode" 和 "claude-code": `ENGINE_TYPES` → ["opencode", "claude-code"]
    - AgentDetailSchema 支持 engineType 字段: `AgentDetailSchema.safeParse({ ..., engineType: "opencode" })` → success
    - AgentDetailSchema engineType 为 null 时通过: `AgentDetailSchema.safeParse({ ..., engineType: null })` → success
    - MachineSchema 支持 supportedEngineTypes 字段: `MachineSchema.safeParse({ ..., supportedEngineTypes: [{ type: "opencode" }] })` → success
    - MachineSchema supportedEngineTypes 为 null 时通过: `MachineSchema.safeParse({ ..., supportedEngineTypes: null })` → success
    - MachineSchema supportedEngineTypes 含 cliPath 时通过: `MachineSchema.safeParse({ ..., supportedEngineTypes: [{ type: "claude-code", cliPath: "/usr/bin/claude" }] })` → success
  - 运行命令: `bun test src/__tests__/engine-type-schema.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 schema.ts 新增字段存在
  - `grep -n "engineType\|engine_type" src/db/schema.ts`
  - 预期: 输出包含 `engineType: varchar("engine_type", { length: 32 }).default("opencode")` 和 `supportedEngineTypes: jsonb("supported_engine_types").default([{ type: "opencode" }])`

- [x] 验证 AGENT_SETTABLE_FIELDS 包含 engineType
  - `grep "engineType" src/services/config/agent-config.ts | head -5`
  - 预期: 输出包含 `"engineType"` 在 AGENT_SETTABLE_FIELDS 数组中

- [x] 验证 ENGINE_TYPES 常量导出
  - `grep "ENGINE_TYPES" src/services/config/types.ts`
  - 预期: 输出包含 `export const ENGINE_TYPES = ["opencode", "claude-code"] as const`

- [x] 验证 registry schema 新增 supportedEngineTypes
  - `grep "supportedEngineTypes" src/schemas/registry.schema.ts`
  - 预期: 输出包含 `supportedEngineTypes` 字段定义

- [x] 验证 config schema 新增 engineType
  - `grep "engineType" src/schemas/config.schema.ts`
  - 预期: 输出包含 `engineType` 字段定义

- [x] 验证迁移 SQL 文件生成
  - `ls drizzle/0002_add-engine-type-fields.sql`
  - 预期: 文件存在

- [x] 验证迁移 SQL 包含 ALTER TABLE 语句
  - `cat drizzle/0002_add-engine-type-fields.sql | grep "engine_type\|supported_engine_types"`
  - 预期: 包含 agent_config 的 engine_type 列和 machine 的 supported_engine_types 列

- [x] 验证 journal.json 追加了新 entry
  - `grep "0002_add-engine-type-fields" drizzle/meta/_journal.json`
  - 预期: 输出包含 tag `"0002_add-engine-type-fields"`

- [x] 验证单元测试通过
  - `bun test src/__tests__/engine-type-schema.test.ts`
  - 预期: 所有测试通过，无错误

- [x] 验证 TypeScript 类型检查通过
  - `cd /Users/zhongym29/FenixAgent && bunx tsc --noEmit 2>&1 | tail -20`
  - 预期: 无类型错误（新增字段有默认值，不影响现有类型推断）

- [x] 验证已有测试不受影响
  - `bun test src/__tests__/agent-config-build-set.test.ts`
  - 预期: 测试通过（AGENT_SETTABLE_FIELDS 从 15 变为 16，现有 test 的 "数量稳定" 断言需更新为 16）

---

### Task 2: plugin-sdk EngineRelayHandle 接口扩展

**背景:**
业务需求 — 双引擎架构下，relay 通道的 `onMessage`/`ready` 是所有引擎 relay handle 的通用能力（opencode 的 `OpencodeRelayHandle` 已实现，claude-code 的 relay handle 也需要），不应作为 opencode 专有扩展存在于各个消费方。
修改原因 — 当前 `EngineRelayHandle` 接口（`packages/plugin-sdk/src/engine-relay.ts`）只定义了 `state`/`send`/`close` 三个方法，`onMessage`/`ready` 由 `relay-handler.ts` 通过本地 `FullRelayHandle` 类型别名补充，`workflow/index.ts` 通过 duck-typing 检测 `("onMessage" in handle)` 访问。这导致每新增一个引擎 plugin，消费方都要做类型转换，违反引擎无关抽象原则。
上下游影响 — 本 Task 的输出被 Task 4（claude-bridge 的 relay handle 实现 `onMessage/ready`）、Task 8（relay-handler.ts 和 workflow/index.ts 消费标准化接口）和 Task 6（opencode plugin 的 relay-handle.ts 简化类型）直接依赖。本 Task 无前置依赖。

**涉及文件:**
- 修改: `packages/plugin-sdk/src/engine-relay.ts`（接口新增 `onMessage?`/`ready?` 属性）
- 修改: `packages/plugin-opencode/src/relay/relay-handle.ts`（`OpencodeRelayHandle` 改为直接实现扩展属性）
- 修改: `packages/plugin-opencode/src/runtime/opencode-runtime.ts`（移除 `as Partial<OpencodeRelayHandle>` 转换）
- 修改: `src/transport/relay/relay-handler.ts`（移除 `FullRelayHandle` 类型别名）
- 修改: `src/services/workflow/index.ts`（移除 duck-typing 检测，直接使用 `handle.onMessage`）

**执行步骤:**

- [x] 在 `packages/plugin-sdk/src/engine-relay.ts` 的 `EngineRelayHandle` 接口中新增两个可选属性
  - 位置: `packages/plugin-sdk/src/engine-relay.ts` ~L18 `close()` 方法声明之后
  - 新增属性：
    ```typescript
    /** 监听 engine 侧推送的实时消息。返回 unsub 函数。 */
    onMessage?(listener: (message: EngineRelayMessage) => void): () => void;
    /** relay 连接就绪后的 resolve Promise（WS open / bridge 模块初始化完成）。 */
    ready?: Promise<void>;
    ```
  - 原因: 这两个属性是所有引擎 relay handle 的通用能力，提升到基接口后消费方不再需要类型转换

- [x] 在 `packages/plugin-opencode/src/relay/relay-handle.ts` 中简化 `OpencodeRelayHandle` 类型
  - 位置: `packages/plugin-opencode/src/relay/relay-handle.ts` ~L26 `OpencodeRelayHandle` 接口定义
  - 修改后：
    ```typescript
    export interface OpencodeRelayHandle extends EngineRelayHandle {
      readonly url: string;
      // onMessage/ready 已在 EngineRelayHandle 中声明为可选，此处不再重复声明
    }
    ```
  - 原因: `onMessage`/`ready` 已是 `EngineRelayHandle` 的可选属性，`OpencodeRelayHandle` 只需声明自身专有的 `url` 属性

- [x] 在 `packages/plugin-opencode/src/runtime/opencode-runtime.ts` 中移除类型转换
  - 位置: `packages/plugin-opencode/src/runtime/opencode-runtime.ts` 的 `connectRelay()` 方法中，`as Partial<OpencodeRelayHandle>` 转换处
  - 用 grep 确认：`grep -n "as Partial" packages/plugin-opencode/src/runtime/opencode-runtime.ts`
  - 修改：移除 `as Partial<OpencodeRelayHandle>` 转换，`OpencodeRelayHandle` 现在已满足 `EngineRelayHandle` 接口（含可选 `onMessage`/`ready`），无需类型断言
  - 原因: `onMessage`/`ready` 已提升到 `EngineRelayHandle` 基接口，类型系统自动兼容

- [x] 在 `src/transport/relay/relay-handler.ts` 中移除 `FullRelayHandle` 类型别名
  - 位置: `src/transport/relay/relay-handler.ts` ~L12-15
  - 删除以下代码：
    ```typescript
    /** OpencodeRelayHandle extends EngineRelayHandle with onMessage/ready */
    type FullRelayHandle = EngineRelayHandle & {
      onMessage?: (listener: (message: { type: string; payload?: unknown }) => void) => () => void;
      ready?: Promise<void>;
    };
    ```
  - 位置: 同文件 ~L91 `const full = handle as FullRelayHandle` → 改为 `handle`
  - 位置: 同文件 ~L142 `const full = handle as FullRelayHandle` → 改为 `handle`
  - 位置: 同文件 `full.ready` → 改为 `handle.ready`
  - 位置: 同文件 `full.onMessage` → 改为 `handle.onMessage`
  - 原因: `onMessage`/`ready` 已在 `EngineRelayHandle` 基接口中声明，无需额外类型别名和类型断言

- [x] 在 `src/services/workflow/index.ts` 中移除 duck-typing 检测
  - 位置: `src/services/workflow/index.ts` ~L69-83 `onMessage` 处理块
  - 修改前：
    ```typescript
    onMessage: (handler: (msg: Record<string, unknown>) => void) => {
      if ("onMessage" in handle && typeof (handle as { onMessage?: unknown }).onMessage === "function") {
        const opencodeHandle = handle as { onMessage: (listener: ...) => () => void };
        return opencodeHandle.onMessage(handler);
      }
      return () => {};
    },
    ```
  - 修改后：
    ```typescript
    onMessage: (handler: (msg: Record<string, unknown>) => void) => {
      if (handle.onMessage) {
        return handle.onMessage(handler as (message: EngineRelayMessage) => void);
      }
      return () => {};
    },
    ```
  - 原因: `onMessage` 已是 `EngineRelayHandle` 的可选属性，可直接通过 `handle.onMessage` 访问，无需 duck-typing 检测和类型转换

- [x] 为 EngineRelayHandle 接口扩展编写单元测试
  - 测试文件: `packages/plugin-sdk/src/__tests__/engine-relay.test.ts`（新建）
  - 测试场景:
    - `onMessage`/`ready` 为可选属性：不实现这两个属性的 handle 仍满足 `EngineRelayHandle` 接口（TypeScript 编译通过）
    - `onMessage`/`ready` 实现后：实现了这两个属性的 handle 也满足 `EngineRelayHandle` 接口
    - relay-handler.ts 无 `FullRelayHandle` 类型别名：grep 验证文件中不含 `FullRelayHandle` 字符串
    - workflow/index.ts 无 `opencodeHandle` 类型转换：grep 验证文件中不含 `opencodeHandle` 字符串
  - 运行命令: `bun test packages/plugin-sdk/src/__tests__/engine-relay.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 EngineRelayHandle 接口包含 onMessage/ready 可选属性
  - `grep -n "onMessage\?" packages/plugin-sdk/src/engine-relay.ts`
  - 预期: 输出包含 `onMessage?` 和 `ready?` 属性声明行

- [x] 验证 relay-handler.ts 无 FullRelayHandle 类型别名
  - `grep -c "FullRelayHandle" src/transport/relay/relay-handler.ts`
  - 预期: 输出为 0

- [x] 验证 workflow/index.ts 无 opencodeHandle 类型转换
  - `grep -c "opencodeHandle" src/services/workflow/index.ts`
  - 预期: 输出为 0

- [x] 验证 TypeScript 编译无错误
  - `bun run tsc --noEmit 2>&1 | tail -5`
  - 预期: 无类型错误（EngineRelayHandle 扩展后所有消费方兼容）

---

### Task 3: opencode-bridge 包创建

**背景:**
业务需求 — 双引擎架构下，acp-link 中混杂了 opencode 专有的适配逻辑（workspace 配置准备、ACP session 创建行为、系统提示注入、权限硬编码），但未作为显式适配层封装。opencode-bridge 作为 acp-link 进程内的代码模块，封装 opencode 的 ACP 桥接逻辑，使 acp-link 从"做所有事"变为"调度 + 路由"。
修改原因 — 当前 acp-link 的 `instance-manager.ts` 直接 import `@fenix/opencode` 的 `buildOpencodeRuntimeConfig/installSkills/writeOpencodeConfig`，`session-manager.ts` 包含 ACP ClientSideConnection 管理、系统提示注入、权限硬编码等 opencode 专有逻辑。这些逻辑需抽取为独立的 `@fenix/opencode-bridge` 包，实现 `BridgeModule` 接口（prepare/start/sendData/stop/on），为 claude-bridge（Task 4）提供同构接口参考，为 acp-link 代码重组（Task 9）提供 bridge 模块替代。
上下游影响 — 本 Task 的输出被 Task 9（acp-link 代码重组，移除 instance-manager/session-manager，改为 import opencode-bridge）和 Task 4（claude-bridge 包创建，参考 BridgeModule 接口定义和包结构）直接依赖。本 Task 依赖 Task 2（plugin-sdk 的 EngineRelayHandle.onMessage/ready 标准化）和 Task 6（opencode plugin 适配 bridge 模块概念）无代码交集，但 BridgeModule 接口定义需与 EngineRelayHandle 对齐。本 Task 不修改 acp-link 的现有文件（仅创建新包），acp-link 的代码重组在 Task 9 执行。

**涉及文件:**
- 新建: `packages/opencode-bridge/package.json`
- 新建: `packages/opencode-bridge/tsconfig.json`
- 新建: `packages/opencode-bridge/src/index.ts`（包入口，导出 BridgeModule 接口 + createOpencodeBridge 工厂）
- 新建: `packages/opencode-bridge/src/bridge-module.ts`（BridgeModule 接口定义）
- 新建: `packages/opencode-bridge/src/workspace-preparer.ts`（从 @fenix/opencode 和 instance-manager.ts 抽取的 workspace 配置准备逻辑）
- 新建: `packages/opencode-bridge/src/agent-spawner.ts`（从 instance-manager.ts 抽取的 spawn + ACP 连接建立逻辑）
- 新建: `packages/opencode-bridge/src/session-handler.ts`（从 session-manager.ts 抽取的 ACP session 管理、系统提示注入、权限处理逻辑）
- 新建: `packages/opencode-bridge/src/acp-adapter.ts`（AcpDispatcher 的 opencode-bridge 内部副本，消息分发）
- 新建: `packages/opencode-bridge/src/__tests__/opencode-bridge.test.ts`（opencode-bridge 单元测试）
- 修改: `tsconfig.base.json`（新增 `@fenix/opencode-bridge` 路径映射）

**执行步骤:**

- [x] 创建 `packages/opencode-bridge/package.json`
  - 位置: `packages/opencode-bridge/package.json`（新建）
  - 内容:
    ```json
    {
      "name": "@fenix/opencode-bridge",
      "version": "0.1.0",
      "private": true,
      "type": "module",
      "exports": {
        ".": {
          "types": "./src/index.ts",
          "default": "./src/index.ts"
        }
      },
      "dependencies": {
        "@agentclientprotocol/sdk": "^0.21.1",
        "@fenix/opencode": "workspace:*",
        "@fenix/plugin-sdk": "workspace:*"
      },
      "scripts": {
        "build": "bun build src/index.ts --outdir dist --format esm",
        "typecheck": "tsc -p tsconfig.json --noEmit",
        "test": "bun test"
      }
    }
    ```
  - 原因: 与其他 workspace 包（plugin-sdk/plugin-opencode）结构一致，`@agentclientprotocol/sdk` 是 ACP 通信的基础依赖，`@fenix/opencode` 提供 buildOpencodeRuntimeConfig/installSkills/writeOpencodeConfig，`@fenix/plugin-sdk` 提供 AgentLaunchSpec 类型

- [x] 创建 `packages/opencode-bridge/tsconfig.json`
  - 位置: `packages/opencode-bridge/tsconfig.json`（新建）
  - 内容:
    ```json
    {
      "extends": "../../tsconfig.base.json",
      "compilerOptions": {
        "lib": ["ES2022"],
        "types": ["bun"],
        "noEmit": true
      },
      "include": ["src/**/*.ts"]
    }
    ```
  - 原因: 与 plugin-opencode 的 tsconfig.json 结构一致，继承 tsconfig.base.json 的路径别名

- [x] 在 `tsconfig.base.json` 中新增 `@fenix/opencode-bridge` 路径映射
  - 位置: `tsconfig.base.json` ~L4 的 `paths` 对象中，`"@fenix/opencode"` 之后追加
  - 新增映射:
    ```json
    "@fenix/opencode-bridge": ["./packages/opencode-bridge/src/index.ts"]
    ```
  - 原因: workspace 包必须注册路径别名才能通过 TypeScript 编译，与其他 workspace 包（plugin-sdk/core/opencode/workflow-engine/sdk/remote-runtime）一致

- [x] 创建 `packages/opencode-bridge/src/bridge-module.ts` 定义 BridgeModule 接口
  - 位置: `packages/opencode-bridge/src/bridge-module.ts`（新建）
  - 内容:
    ```typescript
    import type { AgentLaunchSpec } from "@fenix/plugin-sdk";

    /** bridge 模块的启动选项 */
    export interface BridgeStartOptions {
      /** workspace 绝对路径 */
      cwd: string;
      /** 环境变量覆盖 */
      env?: Record<string, string>;
      /** 系统提示词（从 session_start.agent_prompt 传入） */
      systemPrompt?: string;
      /** 引擎特定配置（从 session_start.engine_config 传入） */
      engineConfig?: Record<string, unknown>;
    }

    /**
     * acp-link 进程内的 bridge 模块接口。
     * 每个 engine 类型实现此接口，封装该引擎特有的环境准备、子进程 spawn、
     * ACP 协议使用方式和消息路由。acp-link 根据 engine_type 选择对应 bridge 模块。
     */
    export interface BridgeModule {
      /** 环境准备：创建配置目录、写入配置文件、安装 skills */
      prepare(workspace: string, launchSpec: AgentLaunchSpec): Promise<void>;

      /** spawn 子进程 + 建立通信，返回 capabilities */
      start(sessionId: string, options: BridgeStartOptions): Promise<{ capabilities: Record<string, unknown> }>;

      /** 发送 ACP 消息到子进程 */
      sendData(sessionId: string, acpMessage: unknown): Promise<boolean>;

      /** 终止子进程 */
      stop(sessionId: string): Promise<void>;

      /** 事件监听（子进程输出 → ACP 事件） */
      on(event: string, callback: (sessionId: string, payload: unknown) => void): void;
    }
    ```
  - 原因: BridgeModule 接口是双桥接层架构的核心契约，opencode-bridge 和 claude-bridge（Task 4）都实现此接口。接口方法与 spec-design.md 中定义的 prepare/start/sendData/stop/on 完全一致。BridgeStartOptions 包含 cwd/env/systemPrompt/engineConfig，覆盖 acp-link 通过 session_start 传递的所有参数

- [x] 创建 `packages/opencode-bridge/src/workspace-preparer.ts` 抽取 workspace 配置准备逻辑
  - 位置: `packages/opencode-bridge/src/workspace-preparer.ts`（新建）
  - 从 `packages/acp-link/src/client/instance-manager.ts` 的 `prepare()` 方法和 `resolveWorkspace()` 方法抽取，同时从 `packages/plugin-opencode/src/runtime/environment-preparer.ts`、`runtime-config.ts`、`skill-installer.ts` 引用
  - 内容:
    ```typescript
    import { join } from "node:path";
    import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
    import {
      buildOpencodeRuntimeConfig,
      ensureWorkspaceRuntimeDirs,
      installSkills,
      writeOpencodeConfig,
      type InstalledSkillReference,
      type OpencodeRuntimeConfig,
    } from "@fenix/opencode";

    /** workspace 准备结果 */
    export interface PreparedWorkspace {
      workspace: string;
      runtimeConfig: OpencodeRuntimeConfig;
      installedSkills: InstalledSkillReference[];
    }

    /**
     * 解析 workspace 路径。
     * 逻辑与 instance-manager.ts 的 resolveWorkspace 一致。
     */
    export function resolveWorkspace(workspaceRoot: string, launchSpec: AgentLaunchSpec): string {
      if (launchSpec.environmentId) {
        return join(workspaceRoot, launchSpec.organizationId, launchSpec.userId, launchSpec.environmentId);
      }
      return join(workspaceRoot, launchSpec.organizationId, launchSpec.userId);
    }

    /**
     * opencode workspace 环境准备。
     * 从 instance-manager.ts 的 prepare() 方法抽取：
     * 1. resolveWorkspace → 计算路径
     * 2. installSkills → 安装技能
     * 3. buildOpencodeRuntimeConfig → 构建配置
     * 4. writeOpencodeConfig → 写入 .opencode/opencode.json
     */
    export async function prepareWorkspace(
      workspaceRoot: string,
      launchSpec: AgentLaunchSpec,
    ): Promise<PreparedWorkspace> {
      const workspace = resolveWorkspace(workspaceRoot, launchSpec);
      const installedSkills = await installSkills(workspace, launchSpec.skills);
      const runtimeConfig = buildOpencodeRuntimeConfig(launchSpec, installedSkills);
      await writeOpencodeConfig(workspace, runtimeConfig);
      return { workspace, runtimeConfig, installedSkills };
    }
    ```
  - 原因: 将 instance-manager.ts 中 import `@fenix/opencode` 的配置准备逻辑抽取为 opencode-bridge 的 workspace-preparer 模块。不删除 acp-link 的原代码（Task 9 处理），仅在新包中创建抽取版本。`resolveWorkspace` 和 `prepareWorkspace` 逻辑与 instance-manager.ts 的 `resolveWorkspace()` 和 `prepare()` 完全一致

- [x] 创建 `packages/opencode-bridge/src/agent-spawner.ts` 抽取 spawn + ACP 连接建立逻辑
  - 位置: `packages/opencode-bridge/src/agent-spawner.ts`（新建）
  - 从 `packages/acp-link/src/client/instance-manager.ts` 的 `start()` 方法抽取 spawn opencode acp 子进程 + ACP ClientSideConnection 初始化逻辑
  - 内容:
    ```typescript
    import { type ChildProcess, spawn } from "node:child_process";
    import { Readable, Writable } from "node:stream";
    import * as acp from "@agentclientprotocol/sdk";

    /** spawn 结果 */
    export interface SpawnResult {
      process: ChildProcess;
      connection: acp.ClientSideConnection;
      capabilities: Record<string, unknown>;
    }

    /** spawn 配置 */
    export interface SpawnConfig {
      /** 可执行文件名或路径 */
      command: string;
      /** 工作目录 */
      cwd: string;
      /** 环境变量 */
      env?: Record<string, string>;
    }

    /**
     * spawn opencode acp 子进程 + 建立 ACP 连接。
     * 从 instance-manager.ts 的 start() 方法抽取：
     * 1. resolveExecutable → 查找 opencode 路径
     * 2. spawn(command, ["acp"]) → 创建子进程
     * 3. acp.ndJsonStream → 建立 NDJSON 流
     * 4. new ClientSideConnection → 创建 ACP 客户端连接
     * 5. connection.initialize → 完成握手
     * 6. 返回 process + connection + capabilities
     *
     * 权限策略：requestPermission → always allow（与 instance-manager.ts 一致）
     */
    export async function spawnOpencodeAgent(config: SpawnConfig): Promise<SpawnResult> {
      const spawnEnv = config.env ? { ...process.env, ...config.env } : { ...process.env };

      const proc = spawn(config.command, ["acp"], {
        cwd: config.cwd,
        stdio: ["pipe", "pipe", "inherit"],
        env: spawnEnv,
      });

      const input = Writable.toWeb(proc.stdin!) as unknown as WritableStream<Uint8Array>;
      const output = Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(input, output);

      const connection = new acp.ClientSideConnection(
        () => ({
          requestPermission: async () => ({ outcome: { outcome: "selected" as const, optionId: "allow" } }),
          sessionUpdate: async () => {},
          readTextFile: async () => ({ content: "" }),
          writeTextFile: async () => ({}),
        }),
        stream,
      );

      const initResult = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "rcs-remote", version: "1.0.0" },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });

      return {
        process: proc,
        connection,
        capabilities: (initResult.agentCapabilities as Record<string, unknown>) ?? {},
      };
    }
    ```
  - 原因: 将 instance-manager.ts 的 start() 中 spawn + initialize 拳手逻辑抽取为 agent-spawner 模块。权限策略 `requestPermission → always allow` 与原代码一致。`resolveExecutable` 不在此模块中——opencode-bridge 的 createOpencodeBridge 工厂接收 command 参数（由 acp-link 从 session_start.engine_config 或 acp-link 配置传入），不再需要 resolveExecutable（该函数留在 acp-link 中，Task 9 处理）

- [x] 创建 `packages/opencode-bridge/src/acp-adapter.ts` 抽取 AcpDispatcher
  - 位置: `packages/opencode-bridge/src/acp-adapter.ts`（新建）
  - 从 `packages/acp-link/src/acp-dispatcher.ts` 的 `AcpDispatcher` 类和 `AcpSessionState/createAcpSessionState` 抽取，作为 opencode-bridge 内部的 ACP 消息分发层
  - 内容: 复制 `acp-dispatcher.ts` 的核心内容（`AcpSessionState` 接口、`createAcpSessionState` 函数、`AcpDispatcher` 类），修改 import 路径（从 `"./types.js"` 改为从 `"./acp-types.js"` 引用本地类型）
  - 原因: AcpDispatcher 是 opencode 专有的 ACP 消息分发逻辑（将 ProxyMessage 翻译为 ClientSideConnection SDK 调用），需要留在 opencode-bridge 中。acp-link 原文件不删除（Task 9 处理），opencode-bridge 使用自己的副本。claude-bridge（Task 4）有自己的 ProtocolAdapter，不使用 AcpDispatcher

- [x] 创建 `packages/opencode-bridge/src/acp-types.ts` 定义 opencode-bridge 需要的 ACP 类型
  - 位置: `packages/opencode-bridge/src/acp-types.ts`（新建）
  - 从 `packages/acp-link/src/types.ts` 中抽取 opencode-bridge 需要的类型定义
  - 内容: 抽取 ProxyMessage、ContentBlock、PermissionResponsePayload、AgentCapabilities、PromptCapabilities、SessionModelState、SessionModeState 等类型，这些类型是 AcpDispatcher 和 session-handler 所需的
  - 原因: opencode-bridge 需要自己的类型定义副本，不依赖 acp-link 的 types.ts（acp-link 原文件在 Task 9 重组后才移除依赖）。抽取的类型与原文件完全一致

- [x] 创建 `packages/opencode-bridge/src/session-handler.ts` 抽取 ACP session 管理、系统提示注入、权限处理逻辑
  - 位置: `packages/opencode-bridge/src/session-handler.ts`（新建）
  - 从 `packages/acp-link/src/client/session-manager.ts` 的核心逻辑抽取：ACP session 生命周期（auto newSession）、系统提示注入、权限处理、sendData 消息路由
  - 内容:
    ```typescript
    import * as acp from "@agentclientprotocol/sdk";
    import type { ContentBlock, ProxyMessage } from "./acp-types.js";
    import { AcpDispatcher, type AcpSessionState, createAcpSessionState } from "./acp-adapter.js";

    // biome-ignore lint/suspicious/noExplicitAny: event callback signatures vary by event type
    type SessionEventCallback = (...args: any[]) => void;

    /**
     * opencode ACP session 处理器。
     * 从 session-manager.ts 抽取的核心逻辑：
     * - ACP session 创建和生命周期管理
     * - 系统提示注入（blocks.unshift）
     * - 权限策略（requestPermission → always allow）
     * - sendData 消息路由（prompt/cancel/new_session/list_sessions/load_session/resume_session/set_session_model/set_session_mode）
     */
    export class SessionHandler {
      private listeners = new Map<string, SessionEventCallback[]>();
      private systemPrompt: string | null = null;
      private currentAcpSessionId: string | null = null;
      private sessionState: AcpSessionState;

      constructor(
        private connection: acp.ClientSideConnection,
        private cwd: string,
        capabilities: Record<string, unknown>,
        private send: (type: string, payload?: unknown) => void,
      ) {
        this.sessionState = createAcpSessionState();
        this.sessionState.connection = connection;
        this.sessionState.agentCapabilities = capabilities as any;
        // 创建 dispatcher，绑定 send 回调
        // dispatcher 用于 relay 消息分发（InstanceManager 模式）
      }

      setSystemPrompt(prompt: string): void {
        this.systemPrompt = prompt;
        console.log("[opencode-bridge] system prompt set:", prompt.substring(0, 50));
      }

      /**
       * 自动创建 ACP session（初始化后的 bootstrap 行为）。
       * 从 session-manager.ts 的 startSession 中 "auto-created" 逻辑抽取。
       */
      async autoCreateSession(sessionId: string): Promise<void> {
        try {
          const autoSession = await this.connection.newSession({ cwd: this.cwd, mcpServers: [] });
          this.currentAcpSessionId = autoSession.sessionId;
          this.sessionState.sessionId = autoSession.sessionId;
          console.log("[opencode-bridge] auto-created:", autoSession.sessionId);
          this.emit(sessionId, "session_data", { type: "session_created", payload: autoSession });
        } catch (err) {
          console.error("[opencode-bridge] auto newSession failed:", err);
        }
      }

      /**
       * 处理 ACP 消息路由。
       * 从 session-manager.ts 的 sendData 方法抽取，
       * 覆盖 prompt（含系统提示注入）、cancel、new_session、list_sessions、
       * load_session、resume_session、set_session_model、set_session_mode。
       */
      async sendData(sessionId: string, rawPayload: unknown): Promise<boolean> {
        const msg = rawPayload as Record<string, unknown>;
        const type = msg.type as string;
        const payload = (msg.payload ?? {}) as Record<string, unknown>;

        try {
          switch (type) {
            case "connect":
              break;
            case "new_session":
              await this.handleNewSession(sessionId, payload);
              break;
            case "prompt":
              await this.handlePrompt(sessionId, payload);
              break;
            case "cancel":
              await this.handleCancel(sessionId);
              break;
            case "set_session_model":
              await this.handleSetSessionModel(sessionId, payload);
              break;
            case "set_session_mode":
              await this.handleSetSessionMode(sessionId, payload);
              break;
            case "resume_session":
              await this.handleResumeSession(sessionId, payload);
              break;
            case "list_sessions":
              await this.handleListSessions(sessionId);
              break;
            case "load_session":
              await this.handleLoadSession(sessionId, payload);
              break;
            default:
              console.log("[opencode-bridge] unknown:", type);
          }
        } catch (err) {
          console.error("[opencode-bridge] sendData error:", err);
          this.emit(sessionId, "session_error", String(err));
        }
        return true;
      }

      /**
       * 获取 dispatcher（供 InstanceManager 模式使用）。
       */
      getDispatcher(): AcpDispatcher {
        if (!this.sessionState.dispatcher) {
          this.sessionState.dispatcher = new AcpDispatcher(this.sessionState, this.send);
        }
        return this.sessionState.dispatcher;
      }

      on(event: string, cb: SessionEventCallback): void {
        const arr = this.listeners.get(event) ?? [];
        arr.push(cb);
        this.listeners.set(event, arr);
      }

      private emit(sessionId: string, event: string, payload: unknown): void {
        for (const cb of this.listeners.get(event) ?? []) {
          cb(sessionId, payload);
        }
      }

      // --- 各 ACP 消息类型的处理方法（从 session-manager.ts 抽取） ---
      // 逻辑与 session-manager.ts 中 sendData 的各 case 完全一致

      private async handleNewSession(sessionId: string, payload: Record<string, unknown>): Promise<void> {
        try {
          const r = await this.connection.newSession({
            cwd: (payload.cwd as string) ?? this.cwd,
            mcpServers: [],
          });
          this.currentAcpSessionId = r.sessionId;
          this.emit(sessionId, "session_data", { type: "session_created", payload: r });
        } catch (err) {
          this.emit(sessionId, "session_error", String(err));
        }
      }

      private async handlePrompt(sessionId: string, payload: Record<string, unknown>): Promise<void> {
        if (!this.currentAcpSessionId) {
          const r = await this.connection.newSession({ cwd: this.cwd, mcpServers: [] });
          this.currentAcpSessionId = r.sessionId;
          this.emit(sessionId, "session_data", { type: "session_created", payload: r });
        }
        const blocks = (payload.content as ContentBlock[]) ?? [];
        // 注入系统提示词（从 session-manager.ts 抽取的核心逻辑）
        if (this.systemPrompt) {
          blocks.unshift({ type: "text" as const, text: this.systemPrompt });
          this.systemPrompt = null;
          console.log("[opencode-bridge] injected system prompt");
        }
        this.connection
          .prompt({ sessionId: this.currentAcpSessionId!, prompt: blocks })
          .then((result) => {
            this.emit(sessionId, "session_data", { type: "prompt_complete", payload: result });
          })
          .catch((err) => {
            console.error("[opencode-bridge] prompt failed:", err);
            this.emit(sessionId, "session_error", String(err));
          });
      }

      private async handleCancel(sessionId: string): Promise<void> {
        if (this.currentAcpSessionId) {
          this.connection.cancel({ sessionId: this.currentAcpSessionId }).catch(() => {});
        }
      }

      private async handleSetSessionModel(sessionId: string, payload: Record<string, unknown>): Promise<void> {
        if (!this.currentAcpSessionId) {
          this.emit(sessionId, "session_error", "No active session");
          return;
        }
        this.connection
          .unstable_setSessionModel({
            sessionId: this.currentAcpSessionId,
            modelId: (payload.modelId as string) ?? "",
          })
          .then(() =>
            this.emit(sessionId, "session_data", { type: "model_changed", payload: { modelId: payload.modelId } }),
          )
          .catch(() => {});
      }

      private async handleSetSessionMode(sessionId: string, payload: Record<string, unknown>): Promise<void> {
        if (!this.currentAcpSessionId) {
          this.emit(sessionId, "session_error", "No active session");
          return;
        }
        this.connection
          .setSessionMode({ sessionId: this.currentAcpSessionId, modeId: (payload.modeId as string) ?? "" })
          .then(() =>
            this.emit(sessionId, "session_data", { type: "mode_changed", payload: { modeId: payload.modeId } }),
          )
          .catch(() => {});
      }

      private async handleResumeSession(sessionId: string, payload: Record<string, unknown>): Promise<void> {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: unstable_resumeSession not in SDK types
          const r = await (this.connection as any).unstable_resumeSession({
            sessionId: (payload.sessionId as string) ?? "",
            cwd: this.cwd,
          });
          this.currentAcpSessionId = r.sessionId ?? (payload.sessionId as string);
          this.emit(sessionId, "session_data", { type: "session_resumed", payload: r });
        } catch (err) {
          console.error("[opencode-bridge] resumeSession failed:", String(err));
          this.emit(sessionId, "session_error", String(err));
        }
      }

      private async handleListSessions(sessionId: string): Promise<void> {
        try {
          const r = await this.connection.listSessions({});
          this.emit(sessionId, "session_data", { type: "session_list", payload: r });
        } catch (err) {
          this.emit(sessionId, "session_error", String(err));
        }
      }

      private async handleLoadSession(sessionId: string, payload: Record<string, unknown>): Promise<void> {
        try {
          const targetSid = (payload.sessionId as string) ?? "";
          const r = await this.connection.loadSession({
            sessionId: targetSid,
            cwd: this.cwd,
            mcpServers: [],
          });
          this.currentAcpSessionId = targetSid;
          this.emit(sessionId, "session_data", { type: "session_loaded", payload: r });
        } catch (err) {
          console.error("[opencode-bridge] loadSession failed:", String(err));
          this.emit(sessionId, "session_error", String(err));
        }
      }
    }
    ```
  - 原因: SessionHandler 封装了 session-manager.ts 的核心逻辑——系统提示注入、权限处理、ACP 消息路由。SessionHandler 是 BridgeModule.sendData 的内部实现。与原 session-manager.ts 的关键差异：(1) 不再管理子进程 spawn（由 agent-spawner 模块负责）；(2) 不再有 sharedProc/sharedConnection 的全局单例模式（每个 instance 有独立的 SessionHandler）；(3) 接收 connection 和 send 回调作为构造参数，不再在内部 spawn 进程

- [x] 创建 `packages/opencode-bridge/src/index.ts` 包入口，导出 BridgeModule 接口 + createOpencodeBridge 工厂函数
  - 位置: `packages/opencode-bridge/src/index.ts`（新建）
  - 内容:
    ```typescript
    export type { BridgeModule, BridgeStartOptions } from "./bridge-module.js";
    export { createOpencodeBridge } from "./opencode-bridge-factory.js";
    ```
  - 原因: 包入口仅导出 BridgeModule 接口和工厂函数，与 plugin-opencode 的 index.ts 导出模式一致（接口 + 工厂函数）。内部模块（workspace-preparer/agent-spawner/session-handler/acp-adapter）不导出，仅在 createOpencodeBridge 内部使用

- [x] 创建 `packages/opencode-bridge/src/opencode-bridge-factory.ts` 实现 createOpencodeBridge 工厂函数
  - 位置: `packages/opencode-bridge/src/opencode-bridge-factory.ts`（新建）
  - 内容:
    ```typescript
    import { type ChildProcess } from "node:child_process";
    import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
    import type { BridgeModule, BridgeStartOptions } from "./bridge-module.js";
    import { prepareWorkspace, type PreparedWorkspace } from "./workspace-preparer.js";
    import { spawnOpencodeAgent, type SpawnResult } from "./agent-spawner.js";
    import { SessionHandler } from "./session-handler.js";

    interface InstanceState {
      sessionId: string;
      prepared: PreparedWorkspace | null;
      spawnResult: SpawnResult | null;
      sessionHandler: SessionHandler | null;
    }

    /**
     * 创建 opencode-bridge 模块实例。
     * 实现 BridgeModule 接口，封装 opencode 的 ACP 桥接逻辑。
     * 在 acp-link 进程内运行，根据 engine_type 选择使用。
     *
     * @param workspaceRoot - workspace 根目录路径
     * @param command - opencode 可执行文件名或路径（默认 "opencode"）
     */
    export function createOpencodeBridge(workspaceRoot: string, command = "opencode"): BridgeModule {
      const instances = new Map<string, InstanceState>();

      const bridge: BridgeModule = {
        async prepare(workspace, launchSpec) {
          const prepared = await prepareWorkspace(workspaceRoot, launchSpec);
          instances.set(launchSpec.environmentId ?? "default", {
            sessionId: "",
            prepared,
            spawnResult: null,
            sessionHandler: null,
          });
          console.log(`[opencode-bridge] prepared: workspace=${prepared.workspace}`);
        },

        async start(sessionId, options) {
          // 查找已 prepare 的 instance，或使用 sessionId 作为 fallback key
          const stateKey = sessionId;
          let state = instances.get(stateKey);
          if (!state?.prepared) {
            throw new Error(`Instance not prepared for session ${sessionId}`);
          }

          const spawnResult = await spawnOpencodeAgent({
            command,
            cwd: options.cwd ?? state.prepared.workspace,
            env: options.env,
          });

          spawnResult.process.on("exit", (code) => {
            console.log(`[opencode-bridge] opencode exited: sessionId=${sessionId}, code=${code}`);
            const s = instances.get(stateKey);
            if (s) {
              s.spawnResult = null;
              s.sessionHandler = null;
            }
          });

          // 创建 send 回调（将 ACP 事件 emit 给 acp-link 的 WS 路由层）
          const send = (type: string, payload?: unknown) => {
            bridge._emit(sessionId, type, payload);
          };

          const sessionHandler = new SessionHandler(
            spawnResult.connection,
            options.cwd ?? state.prepared.workspace,
            spawnResult.capabilities,
            send,
          );

          // 设置系统提示词
          if (options.systemPrompt) {
            sessionHandler.setSystemPrompt(options.systemPrompt);
          }

          // 首次初始化时自动创建 session（从 session-manager.ts 抽取的 bootstrap 行为）
          await sessionHandler.autoCreateSession(sessionId);

          state.spawnResult = spawnResult;
          state.sessionHandler = sessionHandler;
          console.log(`[opencode-bridge] started: sessionId=${sessionId}`);

          return { capabilities: spawnResult.capabilities };
        },

        async sendData(sessionId, acpMessage) {
          const state = instances.get(sessionId);
          if (state?.sessionHandler) {
            return state.sessionHandler.sendData(sessionId, acpMessage);
          }
          console.warn(`[opencode-bridge] sendData: no session handler for ${sessionId}`);
          return false;
        },

        async stop(sessionId) {
          const state = instances.get(sessionId);
          if (!state) return;

          if (state.spawnResult?.process && !state.spawnResult.process.killed) {
            state.spawnResult.process.kill("SIGTERM");
          }
          instances.delete(sessionId);
          console.log(`[opencode-bridge] stopped: sessionId=${sessionId}`);
        },

        on(event, callback) {
          // 事件监听由内部 _emit 机制实现
          // SessionHandler 的 emit → 通过 listeners Map 传递
          // 这里需要将 SessionHandler 的 on() 注册桥接到 BridgeModule 的 on()
          // 实际实现中，start() 创建的 SessionHandler 已通过 send 回调间接 emit
          // BridgeModule 的 on() 在 factory 层维护独立的 listeners Map
          // ...
        },
      };

      // BridgeModule 级别的事件 listeners（SessionHandler emit → send 回调 → BridgeModule emit）
      const bridgeListeners = new Map<string, Array<(sessionId: string, payload: unknown) => void>>();

      // 扩展 on 方法使用 bridgeListeners
      bridge.on = (event: string, callback: (sessionId: string, payload: unknown) => void) => {
        const arr = bridgeListeners.get(event) ?? [];
        arr.push(callback);
        bridgeListeners.set(event, arr);
      };

      // 内部 emit 方法（SessionHandler 的 send 回调调用此方法）
      (bridge as any)._emit = (sessionId: string, type: string, payload?: unknown) => {
        for (const cb of bridgeListeners.get(type) ?? []) {
          cb(sessionId, payload);
        }
      };

      return bridge;
    }
    ```
  - 原因: createOpencodeBridge 工厂函数实现 BridgeModule 接口的完整生命周期：prepare → start → sendData → stop。事件监听通过双层机制实现：SessionHandler 的 emit → send 回调 → BridgeModule 的 _emit → bridgeListeners。acp-link 在 Task 9 中通过 `createOpencodeBridge(workspaceRoot, command)` 创建 bridge 模块实例，根据 `session_start.engine_type === "opencode"` 选择使用

- [x] 为 opencode-bridge 的核心模块编写单元测试
  - 测试文件: `packages/opencode-bridge/src/__tests__/opencode-bridge.test.ts`
  - 测试场景:
    - resolveWorkspace 有 environmentId 时正确拼接路径: `resolveWorkspace("/root", { organizationId: "org1", userId: "user1", environmentId: "env1", ... })` → 返回 `"/root/org1/user1/env1"`
    - resolveWorkspace 无 environmentId 时跳过 env1 层级: `resolveWorkspace("/root", { organizationId: "org1", userId: "user1", ... })` → 返回 `"/root/org1/user1"`
    - spawnOpencodeAgent 返回 SpawnResult 结构: mock spawn + connection.initialize → 返回 `{ process, connection, capabilities }` 对象，capabilities 来自 initResult.agentCapabilities
    - spawnOpencodeAgent 的权限策略为 always allow: mock ClientSideConnection 构造参数中的 requestPermission → 返回 `{ outcome: "selected", optionId: "allow" }`
    - SessionHandler.setSystemPrompt 存储提示词: `handler.setSystemPrompt("test prompt")` → 内部 systemPrompt 为 "test prompt"
    - SessionHandler 系统提示注入: `handler.handlePrompt(sessionId, { content: [{ type: "text", text: "user msg" }] })` → blocks.unshift 系统提示后变为 `[{ type: "text", text: "test prompt" }, { type: "text", text: "user msg" }]`，systemPrompt 被清空为 null
    - SessionHandler 系统提示仅注入一次: 第二次 prompt 时 systemPrompt 为 null → 不再注入
    - SessionHandler autoCreateSession 调用 connection.newSession: mock connection.newSession → 返回 session 对象，currentAcpSessionId 被设置
    - SessionHandler sendData 处理 cancel: `handler.sendData(sid, { type: "cancel" })` → connection.cancel 被调用
    - createOpencodeBridge 工厂返回 BridgeModule 接口对象: `createOpencodeBridge("/root")` → 返回对象包含 prepare/start/sendData/stop/on 五个方法
    - BridgeModule.on 注册回调后事件能触发: `bridge.on("session_data", cb)` → 内部 _emit("sid", "session_data", payload) → cb 被调用
    - BridgeModule.prepare 调用 prepareWorkspace（mock @fenix/opencode 的函数）
    - BridgeModule.stop 清理 instance state: `bridge.stop(sid)` → instances Map 中 sid 被删除
  - 运行命令: `bun test packages/opencode-bridge/src/__tests__/opencode-bridge.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 opencode-bridge 包结构完整
  - `ls packages/opencode-bridge/src/`
  - 预期: 输出包含 `index.ts`、`bridge-module.ts`、`workspace-preparer.ts`、`agent-spawner.ts`、`session-handler.ts`、`acp-adapter.ts`、`acp-types.ts`、`opencode-bridge-factory.ts`、`__tests__/`

- [x] 验证 package.json 正确配置
  - `cat packages/opencode-bridge/package.json | grep -E '"name"|"dependencies"|"@fenix/opencode"|"@fenix/plugin-sdk"|"@agentclientprotocol/sdk"'`
  - 预期: name 为 `@fenix/opencode-bridge`，dependencies 包含三个 workspace/外部依赖

- [x] 验证 tsconfig.json 配置正确
  - `cat packages/opencode-bridge/tsconfig.json | grep -E '"extends"|"include"'`
  - 预期: extends `../../tsconfig.base.json`，include 包含 `src/**/*.ts`

- [x] 验证 tsconfig.base.json 新增路径映射
  - `grep "opencode-bridge" tsconfig.base.json`
  - 预期: 输出包含 `"@fenix/opencode-bridge": ["./packages/opencode-bridge/src/index.ts"]`

- [x] 验证 BridgeModule 接口定义完整
  - `grep -n "prepare\|start\|sendData\|stop\|on" packages/opencode-bridge/src/bridge-module.ts`
  - 预期: 输出包含 5 个方法签名（prepare/start/sendData/stop/on）和 BridgeStartOptions 接口

- [x] 验证 workspace-preparer 从 @fenix/opencode 正确引用
  - `grep "from \"@fenix/opencode\"" packages/opencode-bridge/src/workspace-preparer.ts`
  - 预期: 输出包含 buildOpencodeRuntimeConfig/installSkills/writeOpencodeConfig 的 import

- [x] 验证 agent-spawner 使用 ACP SDK
  - `grep "@agentclientprotocol/sdk" packages/opencode-bridge/src/agent-spawner.ts`
  - 预期: 输出包含 `import * as acp from "@agentclientprotocol/sdk"`

- [x] 验证 session-handler 包含系统提示注入逻辑
  - `grep "unshift" packages/opencode-bridge/src/session-handler.ts`
  - 预期: 输出包含 `blocks.unshift({ type: "text" as const, text: this.systemPrompt })`

- [x] 验证 session-handler 包含权限 always allow 逻辑
  - `grep "optionId.*allow" packages/opencode-bridge/src/session-handler.ts`
  - 预期: 无输出（权限逻辑在 agent-spawner 的 spawnOpencodeAgent 中，session-handler 不直接处理 requestPermission）

- [x] 验证 agent-spawner 包含权限 always allow 逻辑
  - `grep "optionId.*allow" packages/opencode-bridge/src/agent-spawner.ts`
  - 预期: 输出包含 `{ outcome: { outcome: "selected" as const, optionId: "allow" } }`

- [x] 验证包入口导出 BridgeModule 和 createOpencodeBridge
  - `cat packages/opencode-bridge/src/index.ts`
  - 预期: 导出 `BridgeModule`、`BridgeStartOptions` 类型 和 `createOpencodeBridge` 工厂函数

- [x] 验证 opencode-bridge 单元测试通过
  - `bun test packages/opencode-bridge/src/__tests__/opencode-bridge.test.ts`
  - 预期: 所有测试通过

- [x] 验证 TypeScript 类型检查通过
  - `cd /Users/zhongym29/FenixAgent && bunx tsc --noEmit 2>&1 | tail -20`
  - 预期: 无类型错误（新增包继承 tsconfig.base.json 路径映射，所有 import 路径正确）

- [x] 验证 acp-link 原文件未被修改
  - `git diff packages/acp-link/src/client/instance-manager.ts packages/acp-link/src/client/session-manager.ts packages/acp-link/src/acp-dispatcher.ts`
  - 预期: 无 diff（原文件在本 Task 中不修改，Task 9 处理重组）
---

### Task 4: claude-bridge 包创建

**背景:**
业务需求 — 双引擎架构下，Claude Code CLI 需要一个独立的桥接模块作为 acp-link 进程内的代码模块运行，封装 Claude Code 的 ACP 桥接逻辑（workspace 配置准备、Claude Code CLI spawn、ACP ↔ stream-json 双向协议转换、RCS permission 三态 → SDK 六态映射）。
修改原因 — 当前 acp-link 只有 opencode 的桥接逻辑（instance-manager/session-manager），没有 Claude Code 的对应模块。Claude Code CLI 使用 `@anthropic-ai/claude-agent-sdk@0.2.112` 的 `query()` 函数 spawn 子进程，其通信协议是 stream-json（而非 ACP NDJSON），需要 ProtocolAdapter 做 ACP ↔ stream-json 双向转换。
上下游影响 — 本 Task 的输出被 Task 5（@fenix/plugin-claude-code 的 relay handle 创建）和 Task 9（acp-link 代码重组，import claude-bridge 模块）直接依赖。本 Task 依赖 Task 2（EngineRelayHandle.onMessage/ready 标准化）和 Task 3（BridgeModule 接口定义参考）。

**涉及文件:**
- 新建: `packages/claude-bridge/package.json`
- 新建: `packages/claude-bridge/tsconfig.json`
- 新建: `packages/claude-bridge/src/index.ts`（包入口，导出 BridgeModule 接口 + createClaudeBridge 工厂）
- 新建: `packages/claude-bridge/src/bridge-module.ts`（BridgeModule 接口定义）
- 新建: `packages/claude-bridge/src/workspace-preparer.ts`（workspace 配置准备：创建 .claude/ 目录、写 settings.json）
- 新建: `packages/claude-bridge/src/agent-spawner.ts`（使用 SDK query() spawn Claude Code CLI 子进程）
- 新建: `packages/claude-bridge/src/protocol-adapter.ts`（ACP ↔ stream-json 双向协议转换核心）
- 新建: `packages/claude-bridge/src/permission-mapper.ts`（RCS permission 三态 → SDK 六态映射）
- 新建: `packages/claude-bridge/src/mcp-config-mapper.ts`（DB MCP 配置 → SDK McpServerConfig 格式转换）
- 新建: `packages/claude-bridge/src/claude-bridge-factory.ts`（createClaudeBridge 工厂函数）
- 新建: `packages/claude-bridge/src/__tests__/protocol-adapter.test.ts`
- 新建: `packages/claude-bridge/src/__tests__/permission-mapper.test.ts`
- 修改: `tsconfig.base.json`（新增 `@fenix/claude-bridge` 路径映射）

**执行步骤:**

- [x] 创建 `packages/claude-bridge/package.json`
  - 位置: 新建文件 `packages/claude-bridge/package.json`
  - 内容：
    ```json
    {
      "name": "@fenix/claude-bridge",
      "version": "0.1.0",
      "private": true,
      "type": "module",
      "main": "./src/index.ts",
      "exports": { ".": { "import": "./src/index.ts", "types": "./src/index.ts" } },
      "dependencies": {
        "@anthropic-ai/claude-agent-sdk": "0.2.112",
        "@fenix/plugin-sdk": "workspace:*"
      }
    }
    ```
  - 原因: workspace 包声明，依赖 claude-agent-sdk 和 plugin-sdk

- [x] 创建 `packages/claude-bridge/tsconfig.json`
  - 位置: 新建文件 `packages/claude-bridge/tsconfig.json`
  - 内容: 与 `packages/opencode-bridge/tsconfig.json` 同构，extends `../../tsconfig.base.json`

- [x] 在 `tsconfig.base.json` 中新增 `@fenix/claude-bridge` 路径映射
  - 位置: `tsconfig.base.json` 的 `compilerOptions.paths` 中，在 `"@fenix/opencode-bridge/*"` 之后追加
  - 新增: `"@fenix/claude-bridge": ["./packages/claude-bridge/src/index.ts"]`
  - 原因: workspace 包需要 TypeScript 路径别名支持

- [x] 创建 `packages/claude-bridge/src/bridge-module.ts` — BridgeModule 接口定义
  - 位置: 新建文件
  - 定义 BridgeModule 接口（与 Task 3 的 opencode-bridge 同构）：
    ```typescript
    export interface BridgeModule {
      prepare(workspace: string, launchSpec: AgentLaunchSpec): Promise<void>;
      start(sessionId: string, options: BridgeStartOptions): Promise<{ capabilities: Record<string, unknown> }>;
      sendData(sessionId: string, acpMessage: unknown): Promise<boolean>;
      stop(sessionId: string): Promise<void>;
      on(event: string, callback: (sessionId: string, payload: unknown) => void): void;
    }
    export interface BridgeStartOptions {
      send: (type: string, payload?: unknown) => void;
      engineConfig?: Record<string, string>;
    }
    ```
  - 原因: acp-link 通过此接口调度 claude-bridge 模块

- [x] 创建 `packages/claude-bridge/src/workspace-preparer.ts`
  - 位置: 新建文件
  - 关键逻辑：
    ```typescript
    export async function prepareClaudeWorkspace(workspace: string, launchSpec: AgentLaunchSpec): Promise<void> {
      const claudeDir = join(workspace, ".claude");
      await mkdir(claudeDir, { recursive: true });
      const settings = buildClaudeSettings(launchSpec);
      await writeFile(join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2));
    }
    function buildClaudeSettings(launchSpec: AgentLaunchSpec): ClaudeSettings {
      return {
        permissions: mapPermissionsToClaudeSettings(launchSpec),
        mcpServers: mapMcpServers(launchSpec),
      };
    }
    ```
  - 原因: Claude Code CLI 读取 `.claude/settings.json` 获取 permissions 和 MCP 配置

- [x] 创建 `packages/claude-bridge/src/permission-mapper.ts` — RCS 三态 → SDK 六态映射
  - 位置: 新建文件
  - 关键逻辑（基于 spec-design.md 的映射表）：
    ```typescript
    export function mapPermissionToSdkMode(permission: string): string {
      switch (permission) {
        case "ask": return "default";
        case "allow": return "acceptEdits";
        case "deny": return "dontAsk";
        default: return "default";
      }
    }
    export function mapPermissionRulesToAllowedTools(permission: unknown): string[] {
      const rules = parsePermissionRules(permission);
      return rules
        .filter(r => r.permission === "allow")
        .map(r => r.rule ? `${r.tool}(${r.rule.replace(/ /g, ":").replace(/\*/g, "*")})` : r.tool);
    }
    ```
  - 原因: Claude SDK 使用六态 permission 模式 + allowedTools 数组，与 RCS 三态 + 规则型 permission 不同

- [x] 创建 `packages/claude-bridge/src/mcp-config-mapper.ts` — DB MCP → SDK MCP 格式转换
  - 位置: 新建文件
  - 关键逻辑：
    ```typescript
    export function mapMcpServersToSdkFormat(mcpServers: McpServerConfig[]): Record<string, SdkMcpServerConfig> {
      const result: Record<string, SdkMcpServerConfig> = {};
      for (const server of mcpServers) {
        if (server.type === "stdio") {
          result[server.name] = { type: "stdio", command: server.command, args: server.args, env: server.env };
        } else if (server.type === "streamable-http") {
          result[server.name] = { type: "sse", url: server.url };
        }
      }
      return result;
    }
    ```
  - 原因: Claude SDK MCP 配置格式与 ACP SDK 格式有细微差异（如 `sse` vs `streamable-http`）

- [x] 创建 `packages/claude-bridge/src/protocol-adapter.ts` — ACP ↔ stream-json 双向协议转换核心
  - 位置: 新建文件，这是 claude-bridge 的核心创新
  - 关键逻辑（基于 spec-design.md 的协议映射表）：
    ```typescript
    export class ProtocolAdapter {
      private sdkStream: AsyncIterable<SDKMessage> | null = null;
      private send: (type: string, payload?: unknown) => void;
      constructor(send: (type: string, payload?: unknown) => void) { this.send = send; }

      async handleAcpMessage(acpMessage: Record<string, unknown>): Promise<void> {
        switch (acpMessage.type) {
          case "new_session":
            this.send("session_created", { sessionId: "auto" });
            break;
          case "prompt":
            const blocks = (acpMessage.payload?.content ?? []) as ContentBlock[];
            const input = blocks.map(b => b.type === "text" ? b.text : "").join("\n");
            await this.sendPrompt(input);
            break;
          case "cancel":
            this.cancelCurrentPrompt();
            break;
          case "list_sessions":
            this.send("session_list", { sessions: [] });
            break;
        }
      }

      private handleSdkOutput(message: SDKMessage): void {
        if (message.type === "assistant") {
          for (const block of message.content) {
            if (block.type === "text") this.send("assistant", { type: "text", text: block.text });
            else if (block.type === "tool_use") this.send("tool_call", { type: "tool_use", ...block });
          }
        } else if (message.type === "result") {
          this.send("prompt_complete", { stopReason: message.stopReason });
        }
      }
    }
    ```
  - 原因: Claude Code CLI 使用 stream-json 协议（而非 ACP NDJSON），ProtocolAdapter 是 ACP ↔ stream-json 的双向转换桥梁

- [x] 创建 `packages/claude-bridge/src/agent-spawner.ts` — 使用 SDK query() spawn Claude Code CLI
  - 位置: 新建文件
  - 关键逻辑：
    ```typescript
    import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
    export class ClaudeAgentSpawner {
      private currentQuery: ReturnType<typeof query> | null = null;
      async spawn(options: { cwd: string; model?: string; systemPrompt?: string;
        permissionMode?: string; allowedTools?: string[]; mcpServers?: Record<string, unknown>;
        maxTurns?: number; cliPath?: string; }): AsyncIterable<SDKMessage> {
        this.currentQuery = query({
          model: options.model ?? "claude-sonnet-4-6",
          systemPrompt: options.systemPrompt,
          permissionMode: options.permissionMode ?? "default",
          allowedTools: options.allowedTools ?? [],
          mcpServers: options.mcpServers ?? {},
          cwd: options.cwd,
          maxTurns: options.maxTurns ?? 200,
          pathToClaudeCodeExecutable: options.cliPath ?? process.env.CLAUDE_CODE_CLI_PATH,
        });
        return this.currentQuery;
      }
      cancel(): void { /* abort signal */ }
    }
    ```
  - 原因: 使用 claude-agent-sdk 的 query() 管理子进程生命周期和流式输出

- [x] 创建 `packages/claude-bridge/src/claude-bridge-factory.ts` — createClaudeBridge 工厂
  - 位置: 新建文件
  - 组装 workspace-preparer、agent-spawner、protocol-adapter、permission-mapper、mcp-config-mapper 为一个 BridgeModule 实例
  - `createClaudeBridge()` 返回实现 `BridgeModule` 接口的对象

- [x] 创建 `packages/claude-bridge/src/index.ts` — 包入口导出
  - 导出: `BridgeModule`, `BridgeStartOptions`, `createClaudeBridge`, `ProtocolAdapter`, `mapPermissionToSdkMode`, `mapMcpServersToSdkFormat`

- [x] 为 ProtocolAdapter 和 permission-mapper 编写单元测试
  - 测试文件: `packages/claude-bridge/src/__tests__/protocol-adapter.test.ts`
  - 测试场景:
    - ACP "prompt" → SDK input 转换: `{ type: "prompt", payload: { content: [{ type: "text", text: "hello" }] } }` → sendPrompt("hello")
    - SDK "result" → ACP "prompt_complete": `{ type: "result", stopReason: "end_turn" }` → send("prompt_complete", { stopReason: "end_turn" })
    - ACP "cancel" → 中断当前 query
  - 测试文件: `packages/claude-bridge/src/__tests__/permission-mapper.test.ts`
  - 测试场景:
    - RCS "ask" → SDK "default"; "allow" → SDK "acceptEdits"; "deny" → SDK "dontAsk"
    - 规则型 `{ tool: "Bash", permission: "allow", rule: "git *" }` → `["Bash(git:*)"]`
  - 运行命令: `bun test packages/claude-bridge/src/__tests__/`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 claude-bridge 包结构完整
  - `ls packages/claude-bridge/src/`
  - 预期: 包含 index.ts, bridge-module.ts, workspace-preparer.ts, agent-spawner.ts, protocol-adapter.ts, permission-mapper.ts, mcp-config-mapper.ts, claude-bridge-factory.ts, __tests__/ 目录

- [x] 验证 tsconfig.base.json 包含 claude-bridge 路径映射
  - `grep "@fenix/claude-bridge" tsconfig.base.json`
  - 预期: 输出包含路径映射行

- [x] 验证单元测试通过
  - `bun test packages/claude-bridge/src/__tests__/`
  - 预期: 所有测试通过

---

### Task 5: @fenix/plugin-claude-code 包创建

**背景:**
业务需求 — RCS 侧需要一个 Claude Code 引擎插件，在 CoreRuntimeFacade 中注册，使 `facade.launchInstance({ engineType: "claude-code" })` 能找到对应 runtime 实现。
修改原因 — 当前 core-bootstrap.ts 只注册 opencode 插件，facade 只支持 opencode。新增 claude-code 插件后，core 能按 engineType 分发到对应 runtime。
上下游影响 — 本 Task 的输出被 Task 7（core-bootstrap 注册双插件）直接依赖。本 Task 依赖 Task 4（claude-bridge 包）和 Task 2（EngineRelayHandle.onMessage/ready 标准化）。

**涉及文件:**
- 新建: `packages/plugin-claude-code/package.json`
- 新建: `packages/plugin-claude-code/tsconfig.json`
- 新建: `packages/plugin-claude-code/src/index.ts`（包入口）
- 新建: `packages/plugin-claude-code/src/plugin.ts`（createClaudeCodePlugin 工厂）
- 新建: `packages/plugin-claude-code/src/runtime/claude-code-runtime.ts`（EngineRuntime 实现）
- 新建: `packages/plugin-claude-code/src/runtime/claude-code-runtime-config.ts`（buildClaudeCodeRuntimeConfig）
- 新建: `packages/plugin-claude-code/src/process/acp-link-process-manager.ts`（复用 AcpLinkProcessManager 逻辑）
- 新建: `packages/plugin-claude-code/src/relay/relay-handle.ts`（复用 createRelayHandle）
- 新建: `packages/plugin-claude-code/src/__tests__/claude-code-runtime.test.ts`
- 修改: `tsconfig.base.json`（新增 `@fenix/plugin-claude-code` 路径映射）

**执行步骤:**

- [x] 创建 `packages/plugin-claude-code/package.json`
  - 内容：
    ```json
    {
      "name": "@fenix/plugin-claude-code",
      "version": "0.1.0",
      "private": true,
      "type": "module",
      "main": "./src/index.ts",
      "exports": { ".": { "import": "./src/index.ts", "types": "./src/index.ts" } },
      "dependencies": {
        "@fenix/core": "workspace:*",
        "@fenix/plugin-sdk": "workspace:*"
      }
    }
    ```

- [x] 创建 `packages/plugin-claude-code/tsconfig.json` — 与 plugin-opencode 同构

- [x] 在 `tsconfig.base.json` 中新增 `@fenix/plugin-claude-code` 路径映射
  - 新增: `"@fenix/plugin-claude-code": ["./packages/plugin-claude-code/src/index.ts"]`

- [x] 创建 `packages/plugin-claude-code/src/plugin.ts`
  - 关键逻辑：
    ```typescript
    export function createClaudeCodePlugin(): EnginePlugin {
      return {
        meta: { id: "claude-code", displayName: "Claude Code Engine", version: "0.1.0" },
        createRuntime() { return createClaudeCodeRuntime(); },
      };
    }
    ```
  - 原因: meta.id 为 `"claude-code"`，与 core 按 engineType 查找逻辑对齐

- [x] 创建 `packages/plugin-claude-code/src/runtime/claude-code-runtime.ts`
  - 实现 `EngineRuntime` 接口四个方法：
    - `prepareEnvironment(input)` — 创建 workspace，写 `.claude/settings.json`
    - `startInstance(input)` — spawn acp-link 进程（传入 `ACP_ENGINE_TYPE=claude-code` 环境变量）
    - `connectRelay(input)` — 连接 acp-link 的本地 WS，返回 EngineRelayHandle
    - `stopInstance(input)` — 关闭 relay → 停止 acp-link 进程 → 释放端口

- [x] 创建 `packages/plugin-claude-code/src/runtime/claude-code-runtime-config.ts`
  - `buildClaudeCodeRuntimeConfig(launchSpec)` — 将 AgentLaunchSpec 转为 `.claude/settings.json` 格式
  - 关键逻辑：
    ```typescript
    export function buildClaudeCodeRuntimeConfig(launchSpec: AgentLaunchSpec): ClaudeCodeRuntimeConfig {
      return {
        model: launchSpec.model.model,
        systemPrompt: launchSpec.agent.prompt ?? "",
        permissionMode: mapPermissionToSdkMode(/* from launchSpec */),
        allowedTools: mapPermissionRulesToAllowedTools(/* from launchSpec */),
        mcpServers: mapMcpServersToSdkFormat(launchSpec.mcpServers),
        cwd: /* workspace path */,
        maxTurns: launchSpec.agent.steps ?? 200,
        pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_CLI_PATH,
      };
    }
    ```

- [x] 创建 `packages/plugin-claude-code/src/index.ts`
  - 导出: `createClaudeCodePlugin`, `ClaudeCodeRuntime`, `ClaudeCodeRuntimeConfig`, `buildClaudeCodeRuntimeConfig`

- [x] 为 claude-code runtime 编写单元测试
  - 测试文件: `packages/plugin-claude-code/src/__tests__/claude-code-runtime.test.ts`
  - 测试场景:
    - `createClaudeCodePlugin()` 返回的 meta.id 为 `"claude-code"`
    - `prepareEnvironment` 创建 `.claude/settings.json`
    - `buildClaudeCodeRuntimeConfig` 映射 RCS permission → SDK permissionMode
  - 运行命令: `bun test packages/plugin-claude-code/src/__tests__/`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 plugin-claude-code 包结构完整
  - `ls packages/plugin-claude-code/src/`
  - 预期: 包含 index.ts, plugin.ts, runtime/ 目录

- [x] 验证 tsconfig.base.json 包含路径映射
  - `grep "@fenix/plugin-claude-code" tsconfig.base.json`
  - 预期: 输出包含路径映射行

- [x] 验证 meta.id 为 "claude-code"
  - `grep "id.*claude-code" packages/plugin-claude-code/src/plugin.ts`
  - 预期: 输出包含 `id: "claude-code"`

---

### Task 6: @fenix/plugin-opencode 适配改造

**背景:**
业务需求 — opencode plugin 需适配双引擎架构：spawn acp-link 时传入引擎标识。
修改原因 — 当前 opencode plugin 的 startInstance spawn acp-link 不传入引擎标识。改造后 spawn 时传入 `ACP_ENGINE_TYPE=opencode` 环境变量。connectRelay 的类型转换移除已在 Task 2 完成。
上下游影响 — 本 Task 依赖 Task 2（EngineRelayHandle 标准化，opencode-runtime.ts 类型转换移除已在 Task 2 完成）。输出被 Task 7 和 Task 9 使用。

**涉及文件:**
- 修改: `packages/plugin-opencode/src/process/acp-link-process-manager.ts`（spawn 参数新增 ACP_ENGINE_TYPE）

**执行步骤:**

- [x] 修改 `packages/plugin-opencode/src/process/acp-link-process-manager.ts` 的 spawn 参数
  - 位置: `start()` 方法中 spawn 调用的 env 参数
  - 新增 `ACP_ENGINE_TYPE: "opencode"` 到 spawn 环境变量：
    ```typescript
    env: { ...process.env, ...env, ACP_ENGINE_TYPE: "opencode" },
    ```
  - 原因: acp-link 需知道使用哪个 bridge 模块

- [x] 为 opencode plugin 适配改造编写增量测试
  - 测试文件: `packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`（追加场景）
  - 测试场景:
    - spawn env 包含 `ACP_ENGINE_TYPE=opencode`
  - 运行命令: `bun test packages/plugin-opencode/src/__tests__/`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 spawn 参数包含引擎标识
  - `grep "ACP_ENGINE_TYPE" packages/plugin-opencode/src/process/acp-link-process-manager.ts`
  - 预期: 输出包含引擎标识配置

---

### Task 7: RCS 服务端重构 — core-bootstrap + instance + launch-spec-builder

**背景:**
业务需求 — RCS 服务端需要支持双引擎调度：core-bootstrap 注册双插件使 core 按 engineType 分发，instance.ts 从 AgentConfig.engineType 动态读取，launch-spec-builder 支持双引擎 LaunchSpec 格式。
修改原因 — 当前 core-bootstrap.ts 只注册 opencode 插件，instance.ts 硬编码 `engineType: "opencode"`，launch-spec-builder 只生成 opencode 格式。三者均需支持双引擎动态选择。
上下游影响 — 本 Task 依赖 Task 1（DB engineType 字段）、Task 5（plugin-claude-code）、Task 6（plugin-opencode 适配）。输出被 Task 8 和前端 Task 10 依赖。

**涉及文件:**
- 修改: `src/services/core-bootstrap.ts`（注册双插件、本地 node engineTypes 参数化、移除 OpencodeRuntime 类型转换。注意：远端 node registerRemoteNode 的 engineTypes 参数已在 Task 1 添加，本 Task 不再重复）
- 修改: `src/services/instance.ts`（engineType 从 AgentConfig.engineType 读取）
- 修改: `src/services/launch-spec-builder.ts`（新增 engineType 参数，根据引擎类型分支）

**执行步骤:**

- [x] 修改 `src/services/core-bootstrap.ts` 注册双插件
  - 位置: ~L1 import 区域
  - 新增 import: `import { createClaudeCodePlugin } from "@fenix/plugin-claude-code";`
  - 位置: ~L19 `plugins` 数组
  - 修改为: `plugins: [createEnginePlugin(), createClaudeCodePlugin()]`

- [x] 修改 `src/services/core-bootstrap.ts` 本地 node engineTypes 参数化
  - 位置: ~L24 `engineTypes: ["opencode"]`
  - 修改为: `engineTypes: ["opencode", "claude-code"]`

- [x] 确认 `src/services/core-bootstrap.ts` 远端 node engineTypes 已在 Task 1 动态化
  - Task 1 已将 registerRemoteNode 的 engineTypes 参数从硬编码 `["opencode"]` 改为从 machine.supportedEngineTypes 动态读取，本步骤仅确认该改动已存在
  - 确认命令: `grep "engineTypes.*engineTypes" src/services/core-bootstrap.ts`
  - 预期: 输出包含 `engineTypes: engineTypes ?? ["opencode"]`

- [x] 修改 `src/services/core-bootstrap.ts` 移除 OpencodeRuntime 类型转换
  - 位置: ~L29 `onInstanceStarted` 回调中 `(runtime as OpencodeRuntime).getInstanceState`
  - 修改策略: port/token/pid 由 AcpLinkProcessManager 写入 pluginMetadata，onInstanceStarted 不需要额外读取 runtime 内部状态
  - 修改后回调为空或仅做日志
  - 移除 import: `import { type OpencodeRuntime } from "@fenix/opencode";`

- [x] 修改 `src/services/instance.ts` engineType 动态化
  - 位置: ~L180 `facade.launchInstance()` 调用
  - 修改为：
    ```typescript
    const engineType = agentConfig.engineType ?? "opencode";
    const snapshot = await facade.launchInstance({
      instanceId, engineType, nodeId, launchSpec,
    });
    ```
  - 位置: spawnInstanceFromEnvironment 中需从 fullConfig.agentConfig 读取 engineType

- [x] 修改 `src/services/launch-spec-builder.ts` 支持双引擎 LaunchSpec
  - 位置: `BuildLaunchSpecInput` 接口
  - 新增字段: `engineType?: string`
  - 位置: `buildLaunchSpec` 函数中 MCP 配置转换
  - 根据 engineType 分支：
    - `engineType === "opencode"`（默认）→ 现有 toSdkMcpConfig 格式
    - `engineType === "claude-code"` → claude-bridge 的 MCP 格式（`sse` vs `streamable-http`）

- [x] 为 core-bootstrap 和 instance 双引擎改造编写单元测试
  - 测试文件: `src/__tests__/core-bootstrap-dual-engine.test.ts`（新建）
  - 测试场景:
    - defaultCreateFacade 注册双插件
    - 本地 node engineTypes 包含 `["opencode", "claude-code"]`
    - registerRemoteNode 接收 engineTypes 参数
  - 测试文件: `src/__tests__/instance-dual-engine.test.ts`（新建或追加场景）
  - 测试场景:
    - engineType="claude-code" 时 facade.launchInstance 传入 "claude-code"
    - engineType 未设置时默认 "opencode"
  - 运行命令: `bun test src/__tests__/core-bootstrap-dual-engine.test.ts src/__tests__/instance-dual-engine.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 core-bootstrap 注册双插件
  - `grep "createClaudeCodePlugin" src/services/core-bootstrap.ts`
  - 预期: 包含 import 和 plugins 引用

- [x] 验证 instance.ts engineType 不硬编码
  - `grep "engineType" src/services/instance.ts`
  - 预期: 包含从 agentConfig 读取的逻辑，不含硬编码 `"opencode"`（仅默认值）

- [x] 验证 OpencodeRuntime 类型已移除
  - `grep -c "OpencodeRuntime" src/services/core-bootstrap.ts`
  - 预期: 0

---

### Task 8: RCS 服务端重构 — relay + workspace-fs + workflow + agent-task-runner + index.ts

**背景:**
业务需求 — RCS 服务端多个模块需适配双引擎：workspace-fs 参数化引擎配置目录过滤，agent-task-runner 支持双引擎执行，index.ts 通用化日志和 pkill。
修改原因 — workspace-fs.ts 硬编码 `.opencode` 过滤需改为支持 `.claude`，agent-task-runner 硬编码 `.opencode` 配置目录和 opencode 路径需支持 claude-code，index.ts 的 pkill 和日志限定了 opencode。
上下游影响 — 依赖 Task 1（DB engineType）和 Task 2（EngineRelayHandle 标准化）。

**涉及文件:**
- 修改: `src/services/workspace-fs.ts`（参数化引擎配置目录过滤）
- 修改: `src/services/agent-task-runner.ts`（双引擎执行 + 参数化配置目录）
- 修改: `src/index.ts`（通用化日志 + pkill 命令）
- 确认: `src/transport/relay/relay-handler.ts` 和 `src/services/workflow/index.ts`（Task 2 已处理，此处仅确认）

**执行步骤:**

- [x] 修改 `src/services/workspace-fs.ts` 参数化引擎配置目录过滤
  - 位置: ~L159 `shouldHideWorkspaceEntry` 函数
  - 修改前: `return entryPath.endsWith("/.opencode") || entryPath.endsWith("/.opencode/")`
  - 修改后：
    ```typescript
    const ENGINE_CONFIG_DIRS = [".opencode", ".claude"];
    function shouldHideWorkspaceEntry(entryPath: string, userDir: string): boolean {
      const inUserDir = entryPath.startsWith(`${userDir}/`) || entryPath === userDir;
      if (inUserDir) return false;
      return ENGINE_CONFIG_DIRS.some(dir =>
        entryPath.endsWith(`/${dir}`) || entryPath.endsWith(`/${dir}/`)
      );
    }
    ```

- [x] 修改 `src/services/agent-task-runner.ts` 支持双引擎执行
  - 位置: `RunAgentTaskInput` 接口，新增 `engineType?: string`
  - 位置: `prepareRunWorkspace()` 函数，根据 engineType 选择配置目录
    ```typescript
    const configDirName = engineType === "claude-code" ? ".claude" : ".opencode";
    const configFileName = engineType === "claude-code" ? "settings.json" : "config.json";
    ```
  - 位置: `runAgentTask()` 函数 spawn 命令，根据 engineType 分支
    ```typescript
    const engineType = input.engineType ?? "opencode";
    if (engineType === "claude-code") {
      const claudePath = resolveExecutable("claude-bridge");
      const proc = doSpawn(claudePath, ["--task", input.taskText], { cwd: runDir, ... });
    } else {
      const opencodePath = resolveExecutable("opencode");
      const proc = doSpawn(opencodePath, ["run", input.taskText], { cwd: runDir, ... });
    }
    ```

- [x] 修改 `src/index.ts` 通用化日志和 pkill 命令
  - 位置: ~L48 日志
  - 修改为: `"Core runtime initialized (dual engine: opencode + claude-code)"`
  - 位置: ~L61 pkill
  - 修改为: `"pkill -f 'acp-link' || true"`

- [x] 为 workspace-fs 和 agent-task-runner 编写单元测试
  - 测试文件: `src/__tests__/workspace-fs-engine-dirs.test.ts`
  - 测试场景:
    - shouldHideWorkspaceEntry 过滤 `.claude` 和 `.opencode`
    - 不过滤用户目录内的配置目录
  - 测试文件: `src/__tests__/agent-task-runner-dual-engine.test.ts`
  - 测试场景:
    - prepareRunWorkspace engineType="opencode" → `.opencode/config.json`
    - prepareRunWorkspace engineType="claude-code" → `.claude/settings.json`
  - 运行命令: `bun test src/__tests__/workspace-fs-engine-dirs.test.ts src/__tests__/agent-task-runner-dual-engine.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 workspace-fs 参数化过滤
  - `grep "ENGINE_CONFIG_DIRS" src/services/workspace-fs.ts`
  - 预期: 包含 `[".opencode", ".claude"]`

- [x] 验证 agent-task-runner 支持 engineType
  - `grep "engineType" src/services/agent-task-runner.ts`
  - 预期: 包含字段定义和分支逻辑

- [x] 验证 index.ts 通用化
  - `grep "dual engine" src/index.ts`
  - 预期: 包含 "dual engine" 日志

---

### Task 9: acp-link 代码重组

**背景:**
业务需求 — acp-link 需从"做所有事"变为"调度 + 路由"：移除 instance-manager/session-manager，改为 import bridge 模块，根据 engine_type 选择对应 bridge 模块管理 agent 子进程。
修改原因 — 当前 acp-link 的 server.ts/client 模式直接使用 InstanceManager 和 SessionManager，包含 opencode 专有逻辑。重组后 acp-link 只负责 WS ↔ bridge 模块的消息路由。
上下游影响 — 依赖 Task 3（opencode-bridge）、Task 4（claude-bridge）、Task 6（opencode plugin 传入 engine_type 参数）。

**涉及文件:**
- 修改: `packages/acp-link/src/server.ts`（移除 InstanceManager/SessionManager，改为 bridge 模块调度）
- 修改: `packages/acp-link/package.json`（新增 bridge 包依赖，移除 @fenix/opencode 依赖）
- 删除: `packages/acp-link/src/client/instance-manager.ts`
- 删除: `packages/acp-link/src/client/session-manager.ts`
- 修改: `packages/acp-link/src/client/index.ts`（移除旧导出）

**执行步骤:**

- [x] 在 `packages/acp-link/package.json` 中新增 bridge 包依赖
  - 新增: `"@fenix/opencode-bridge": "workspace:*"` 和 `"@fenix/claude-bridge": "workspace:*"`
  - 移除: `"@fenix/opencode"` 依赖

- [x] 修改 `packages/acp-link/src/server.ts` 的 createAcpClient — 使用 bridge 模块调度
  - 替换 import: `InstanceManager`/`SessionManager` → `createOpencodeBridge`/`createClaudeBridge`
  - 新增 bridge 模块选择逻辑：
    ```typescript
    const bridges = {
      opencode: createOpencodeBridge(agentName, workspaceRoot),
      "claude-code": createClaudeBridge(agentName, workspaceRoot),
    };
    function selectBridge(engineType?: string): BridgeModule {
      return bridges[engineType ?? "opencode"] ?? bridges.opencode;
    }
    ```
  - 修改 session_start 消息处理，根据 `msg.engine_type` 选择 bridge 模块

- [x] 删除 `packages/acp-link/src/client/instance-manager.ts`
  - 逻辑已迁移到 opencode-bridge 包

- [x] 删除 `packages/acp-link/src/client/session-manager.ts`
  - 逻辑已迁移到 opencode-bridge 包

- [x] 修改 `packages/acp-link/src/client/index.ts` — 移除旧导出，新增 bridge 类型导出

- [x] 为 acp-link 代码重组编写单元测试
  - 测试文件: `packages/acp-link/src/__tests__/bridge-dispatch.test.ts`
  - 测试场景:
    - engine_type="opencode" → 选择 opencode-bridge
    - engine_type="claude-code" → 选择 claude-bridge
    - engine_type 未指定 → 默认 opencode-bridge
  - 运行命令: `bun test packages/acp-link/src/__tests__/bridge-dispatch.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 acp-link package.json 包含 bridge 包依赖
  - `grep "opencode-bridge\|claude-bridge" packages/acp-link/package.json`
  - 预期: 包含两个 workspace 依赖

- [x] 验证 instance-manager.ts 已删除
  - `test -f packages/acp-link/src/client/instance-manager.ts && echo "EXISTS" || echo "DELETED"`
  - 预期: DELETED

- [x] 验证 session-manager.ts 已删除
  - `test -f packages/acp-link/src/client/session-manager.ts && echo "EXISTS" || echo "DELETED"`
  - 预期: DELETED

- [x] 验证 server.ts 使用 bridge 模块
  - `grep "createOpencodeBridge\|createClaudeBridge\|selectBridge" packages/acp-link/src/server.ts`
  - 预期: 包含 bridge 模块引用

---

### Task 10: 前端改动 — Agent 配置表单引擎类型 + 侧边栏引擎标识

**背景:**
业务需求 — 前端需让用户创建/编辑 Agent 时选择引擎类型（opencode / claude-code），并在 Agent 侧边栏卡片上显示引擎标签。选择 claude-code 时需过滤 machine 下拉只显示支持 claude-code 的远端 machine。
修改原因 — 当前 AgentFormDialog.tsx 无 engineType 字段（后端 API 已支持读写 engineType，前端类型和 UI 缺失），AgentSidebarTree.tsx 的 AgentConfigItem 无 engineType 属性（无法在侧边栏卡片上区分引擎），AgentInfo/AgentDetail 类型无 engineType 字段，buildAgentPayload 不含 engineType。
上下游影响 — 依赖 Task 1（DB engineType 字段 + 后端 config API 已输出 engineType）。Chat 面板无需改动（bridge 模块在 acp-link 进程内完成适配）。

**涉及文件:**
- 修改: `web/src/types/config.ts`（AgentInfo 和 AgentDetail 新增 engineType 字段）
- 修改: `web/src/pages/agent-panel/AgentFormDialog.tsx`（新增 engineType 状态 + 下拉选择 + machine 过滤逻辑 + buildAgentPayload 传 engineType）
- 修改: `web/src/pages/agent-panel/AgentSidebarTree.tsx`（AgentConfigItem 新增 engineType，卡片名称旁显示引擎 Badge）
- 修改: `web/src/lib/agent-utils.ts`（buildAgentPayload 新增 engineType 参数）
- 修改: `web/src/i18n/locales/en/agents.json`（追加 engineType 翻译 key）
- 修改: `web/src/i18n/locales/zh/agents.json`（追加 engineType 翻译 key）

**执行步骤:**

- [x] 在 `web/src/types/config.ts` 的 AgentInfo 接口新增 engineType 字段
  - 位置: `web/src/types/config.ts` ~L183 `AgentInfo` 接口的 `color` 字段之后
  - 新增字段:
    ```typescript
    engineType?: string;
    ```
  - 位置: `web/src/types/config.ts` ~L194 `AgentDetail` 接口的 `knowledge` 字段之后
  - 新增字段:
    ```typescript
    engineType?: string | null;
    ```
  - 原因: 后端 config API 已返回 engineType（`src/routes/web/config/agents.ts` 的 handleGet/handleList），前端类型需对齐

- [x] 在 `web/src/lib/agent-utils.ts` 的 buildAgentPayload 函数新增 engineType 参数
  - 位置: `web/src/lib/agent-utils.ts` ~L78 `buildAgentPayload` 函数的 input 参数类型
  - 新增参数: `engineType: string`
  - 位置: 返回对象中追加:
    ```typescript
    engineType: input.engineType || undefined,
    ```
  - 原因: 创建/更新 Agent 时需将 engineType 传给后端 API，buildAgentPayload 是 payload 构建的唯一入口

- [x] 在 `web/src/i18n/locales/en/agents.json` 追加 engineType 翻译 key
  - 位置: `web/src/i18n/locales/en/agents.json` 的 `form` 对象中，`machineLocal` 之后追加
  - 新增 key:
    ```json
    "engineType": "Engine Type",
    "engineTypePlaceholder": "Select engine type",
    "engineOpencode": "OpenCode",
    "engineClaudeCode": "Claude Code"
    ```
  - 原因: i18n 翻译 key 必须在 UI 组件使用前添加，禁止 JSX 硬编码字符串

- [x] 在 `web/src/i18n/locales/zh/agents.json` 追加 engineType 翻译 key
  - 位置: `web/src/i18n/locales/zh/agents.json` 的 `form` 对象中，`machineLocal` 之后追加
  - 新增 key:
    ```json
    "engineType": "引擎类型",
    "engineTypePlaceholder": "选择引擎类型",
    "engineOpencode": "OpenCode",
    "engineClaudeCode": "Claude Code"
    ```
  - 原因: 中英双语翻译 key 同步添加

- [x] 在 `web/src/pages/agent-panel/AgentFormDialog.tsx` 新增 engineType 状态和下拉选择
  - 位置: `web/src/pages/agent-panel/AgentFormDialog.tsx` ~L71 `const [formMachineId` 之后
  - 新增状态:
    ```typescript
    const [formEngineType, setFormEngineType] = useState("opencode");
    ```
  - 位置: 编辑模式加载（~L123 `setFormMachineId` 之后）追加:
    ```typescript
    setFormEngineType((d.engineType as string) || "opencode");
    ```
  - 位置: 创建模式重置逻辑（~L173 `setFormDisable(false)` 之后）追加:
    ```typescript
    setFormEngineType("opencode");
    ```
  - 位置: `handleSave` 的 buildAgentPayload 调用（~L254 和 ~L286 两处）追加 `engineType: formEngineType` 参数:
    ```typescript
    ...buildAgentPayload({
      model: formModel,
      mode: formMode,
      steps: formSteps,
      prompt: formPrompt,
      description: formDescription,
      variant: formVariant,
      temperature: formTemperature,
      topP: formTopP,
      color: formColor,
      hidden: formHidden,
      disable: formDisable,
      permission: formPermission,
      knowledge: {
        knowledgeBaseIds: validKnowledgeBaseIds,
        searchFirst: formKnowledgeSearchFirst,
        maxResults: formKnowledgeMaxResults,
      },
      engineType: formEngineType,  // ← 新增
    }),
    ```
  - 位置: `handleSave` 的 `useCallback` deps 数组（~L347）追加 `formEngineType`
  - 位置: basic tab 的 JSX 中，model 下拉之前（~L458 `<div><Label>{t("form.model")}</Label>` 之前）插入 engineType 下拉:
    ```tsx
    <div>
      <Label>{t("form.engineType")}</Label>
      <Select value={formEngineType} onValueChange={setFormEngineType}>
        <SelectTrigger className="mt-1">
          <SelectValue placeholder={t("form.engineTypePlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="opencode">{t("form.engineOpencode")}</SelectItem>
          <SelectItem value="claude-code">{t("form.engineClaudeCode")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    ```
  - 原因: Agent 配置表单需让用户选择引擎类型，位于 model 选择之前（引擎类型决定可用 model 范围）

- [x] 在 `web/src/pages/agent-panel/AgentFormDialog.tsx` 实现 machine 下拉按 engineType 过滤
  - 位置: `web/src/pages/agent-panel/AgentFormDialog.tsx` ~L92 `registryApi.list` 调用
  - 当前加载 machine 列表后存储完整列表。需在 `machineOptions` 的基础上根据 `formEngineType` 过滤显示的 machine:
  - 修改 machineOptions 的类型定义（~L51），增加 `supportedEngineTypes` 字段:
    ```typescript
    const [machineOptions, setMachineOptions] = useState<
      { id: string; agentName: string; hostname: string; supportedEngineTypes?: { type: string; cliPath?: string }[] }[]
    >([]);
    ```
  - 位置: `registryApi.list` 回调中（~L95），从 machine 数据提取 `supportedEngineTypes`:
    ```typescript
    machines.map((m) => ({
      id: m.id,
      agentName: m.agentName,
      hostname: m.machineInfo?.hostname ?? "",
      supportedEngineTypes: m.supportedEngineTypes ?? [{ type: "opencode" }],
    })),
    ```
  - 位置: basic tab 中 machine SelectContent（~L479 `{machineOptions.map}`），改为使用过滤后的列表:
    ```tsx
    {machineOptions
      .filter((m) => m.supportedEngineTypes?.some((e) => e.type === formEngineType))
      .map((m) => (
        <SelectItem key={m.id} value={m.id}>
          {m.hostname || m.agentName} ({m.id.slice(0, 8)})
        </SelectItem>
      ))}
    ```
  - 原因: 选择 claude-code 时只显示支持 claude-code 的远端 machine，opencode 时所有 machine 都可选（兼容现有数据）

- [x] 在 `web/src/pages/agent-panel/AgentSidebarTree.tsx` 的 AgentConfigItem 新增 engineType 并在卡片上显示引擎 Badge
  - 位置: `web/src/pages/agent-panel/AgentSidebarTree.tsx` ~L22 `AgentConfigItem` 接口，`color` 字段之后追加:
    ```typescript
    engineType?: string;
    ```
  - 位置: `loadData` 的 `rawAgents` 处理（~L67），从 agent 数据提取 engineType:
    ```typescript
    const agents = Array.isArray(rawAgents) ? rawAgents : [];
    ```
    已有的 agents 每项需包含 engineType（后端 handleList 已返回 `engineType` 字段，前端 AgentInfo 类型已添加）
  - 位置: 卡片 JSX 中名称行（~L370 `<div className="text-[13px] font-semibold text-text-primary truncate">{agent.name}</div>`）之后追加引擎 Badge:
    ```tsx
    <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-2 text-text-dim border border-border-subtle">
      {agent.engineType === "claude-code" ? "CC" : "OC"}
    </span>
    ```
  - 原因: Agent 侧边栏卡片需区分引擎类型，"OC"/"CC" 是简洁的标识。不使用独立 Badge 组件（shadcn Badge 太重），使用内联 span 样式保持卡片紧凑

- [x] 为前端 engineType UI 编写单元测试
  - 测试文件: `web/src/__tests__/agent-engine-type-flow.test.ts`
  - 测试场景:
    - AgentInfo 类型包含 engineType: `{ name: "test", builtIn: false, engineType: "claude-code" }` → TypeScript 编译通过
    - AgentDetail 类型包含 engineType: `{ name: "test", builtIn: false, engineType: "opencode" }` → TypeScript 编译通过
    - buildAgentPayload 传 engineType="claude-code": `buildAgentPayload({ ..., engineType: "claude-code" })` → 返回对象包含 `engineType: "claude-code"`
    - buildAgentPayload 传 engineType="" (空字符串): 返回对象 `engineType` 为 undefined（`|| undefined` 逻辑）
    - en/agents.json 包含 engineType/engineOpencode/engineClaudeCode key: JSON.parse + hasOwnProperty 验证
    - zh/agents.json 包含 engineType/engineOpencode/engineClaudeCode key: 同上
  - 运行命令: `bun test web/src/__tests__/agent-engine-type-flow.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 AgentInfo/AgentDetail 类型包含 engineType
  - `grep "engineType" web/src/types/config.ts`
  - 预期: 包含两处 engineType 字段声明（AgentInfo 和 AgentDetail）

- [x] 验证 buildAgentPayload 支持 engineType
  - `grep "engineType" web/src/lib/agent-utils.ts`
  - 预期: 包含 engineType 参数和返回值

- [x] 验证 AgentFormDialog 包含 engineType 下拉
  - `grep "formEngineType\|engineType" web/src/pages/agent-panel/AgentFormDialog.tsx`
  - 预期: 包含 useState、onValueChange、SelectItem 引用

- [x] 验证 AgentSidebarTree 包含引擎标识
  - `grep "engineType\|OC\|CC" web/src/pages/agent-panel/AgentSidebarTree.tsx`
  - 预期: 包含 AgentConfigItem.engineType 字段和 Badge 渲染逻辑

- [x] 验证 machine 下拉过滤逻辑
  - `grep "supportedEngineTypes\|formEngineType" web/src/pages/agent-panel/AgentFormDialog.tsx | head -5`
  - 预期: 包含 machineOptions 类型扩展和 filter 逻辑

- [x] 验证 i18n 翻译 key 存在
  - `grep "engineType\|engineOpencode\|engineClaudeCode" web/src/i18n/locales/en/agents.json`
  - 预期: 包含四个翻译 key（engineType, engineTypePlaceholder, engineOpencode, engineClaudeCode）

- [x] 验证中文翻译 key 存在
  - `grep "engineType\|engineOpencode\|engineClaudeCode" web/src/i18n/locales/zh/agents.json`
  - 预期: 包含四个中文翻译 key

- [x] 验证前端构建无错误
  - `bun run build:web 2>&1 | tail -5`
  - 预期: 输出包含 "built in" 且无 error

---

### Task 11: 双引擎支持 验收

**前置条件:**
- 启动命令: `bun run dev`（后端开发模式）
- 前端构建: `bun run build:web`
- 测试数据准备: 确保 PostgreSQL 数据库已同步 schema（`bun run db:push`），admin@test.com / admin123456 测试账号可用
- Docker 可用：需运行两个 acp-link 容器作为远端 machine
- Chrome 浏览器可用：端到端验收步骤 #20 需通过 Chrome 浏览器模拟人类操作

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `bun test src/__tests__/ 2>&1 | tail -20`
   - 预期: 全部测试通过
   - 失败排查: 检查各 Task 的测试步骤，逐个 Task 运行定位失败点

2. 验证 DB Schema 变更生效
   - `bun run db:push 2>&1 | tail -5`
   - 预期: 数据库同步成功，agentConfig 表有 engine_type 列，machine 表有 supported_engine_types 列
   - 失败排查: 检查 Task 1 的迁移 SQL

3. 验证 engineType 字段可通过 API 读写
   - `curl -s http://localhost:3000/web/config/agents -X POST -H 'Content-Type: application/json' -H 'Cookie: session=xxx' -d '{"action":"set","name":"general","engineType":"opencode"}' | jq .data.engineType`
   - 预期: 返回 "opencode"
   - 失败排查: 检查 Task 1 的 agent-config.ts 和 config/agents.ts 路由

4. 验证 core-bootstrap 注册双插件
   - `grep "createClaudeCodePlugin" src/services/core-bootstrap.ts`
   - 预期: 包含 claude-code plugin import 和注册
   - 失败排查: 检查 Task 7 的 core-bootstrap.ts 修改

5. 验证 instance.ts engineType 动态化
   - `grep "agentConfig.engineType" src/services/instance.ts`
   - 预期: 包含从 agentConfig 读取 engineType 的逻辑
   - 失败排查: 检查 Task 7 的 instance.ts 修改

6. 验证 workspace-fs 参数化过滤
   - `grep "ENGINE_CONFIG_DIRS" src/services/workspace-fs.ts`
   - 预期: 包含 `[".opencode", ".claude"]`
   - 失败排查: 检查 Task 8 的 workspace-fs.ts 修改

7. 验证 acp-link 代码重组完成
   - `test -f packages/acp-link/src/client/instance-manager.ts && echo "EXISTS" || echo "DELETED"`
   - 预期: DELETED
   - `test -f packages/acp-link/src/client/session-manager.ts && echo "EXISTS" || echo "DELETED"`
   - 预期: DELETED
   - 失败排查: 检查 Task 9 的 acp-link 代码重组

8. 验证前端 Agent 配置表单有 engineType 下拉（Task 10）
   - `grep "formEngineType" web/src/pages/agent-panel/AgentFormDialog.tsx`
   - 预期: 包含 formEngineType useState 和 Select 组件引用
   - 失败排查: 检查 Task 10 的 AgentFormDialog 改动

9. 验证前端 Agent 侧边栏卡片有引擎标识（Task 10）
   - `grep "engineType.*CC\|OC" web/src/pages/agent-panel/AgentSidebarTree.tsx`
   - 预期: 包含引擎 Badge 渲染逻辑
   - 失败排查: 检查 Task 10 的 AgentSidebarTree 改动

10. 验证前端 buildAgentPayload 支持 engineType（Task 10）
    - `grep "engineType" web/src/lib/agent-utils.ts`
    - 预期: 包含 engineType 参数传递
    - 失败排查: 检查 Task 10 的 agent-utils.ts 改动

11. 验证前端 i18n 翻译 key 存在（Task 10）
    - `grep "engineType" web/src/i18n/locales/en/agents.json && grep "engineType" web/src/i18n/locales/zh/agents.json`
    - 预期: 两文件均包含 engineType 翻译 key
    - 失败排查: 检查 Task 10 的 i18n 改动

12. 验证前端构建无错误（Task 10）
    - `bun run build:web 2>&1 | tail -5`
    - 预期: 输出包含 "built in" 且无 error
    - 失败排查: 检查 Task 10 的前端类型和组件改动

13. 验证 EngineRelayHandle 接口包含 onMessage/ready（Task 2）
   - `grep -n "onMessage\?" packages/plugin-sdk/src/engine-relay.ts`
   - 预期: 输出包含 `onMessage?` 和 `ready?` 属性声明行
   - `grep -c "FullRelayHandle" src/transport/relay/relay-handler.ts`
   - 预期: 输出为 0（Task 2 移除了 FullRelayHandle 类型别名）
   - 失败排查: 检查 Task 2 的 EngineRelayHandle 接口扩展

14. 验证 opencode-bridge 包结构完整（Task 3）
    - `ls packages/opencode-bridge/src/`
    - 预期: 输出包含 `index.ts`、`bridge-module.ts`、`workspace-preparer.ts`、`agent-spawner.ts`、`session-handler.ts`、`opencode-bridge-factory.ts`
    - `bun test packages/opencode-bridge/src/__tests__/opencode-bridge.test.ts`
    - 预期: 所有测试通过
    - 失败排查: 检查 Task 3 的 opencode-bridge 包创建

15. 验证 claude-bridge 包结构完整（Task 4）
    - `ls packages/claude-bridge/src/`
    - 预期: 输出包含 `index.ts`、`bridge-module.ts`、`protocol-adapter.ts`、`permission-mapper.ts`、`claude-bridge-factory.ts`
    - `bun test packages/claude-bridge/src/__tests__/`
    - 预期: 所有测试通过
    - 失败排查: 检查 Task 4 的 claude-bridge 包创建

16. 验证 plugin-claude-code 包结构完整（Task 5）
    - `grep "id.*claude-code" packages/plugin-claude-code/src/plugin.ts`
    - 预期: 输出包含 `id: "claude-code"`
    - `bun test packages/plugin-claude-code/src/__tests__/`
    - 预期: 所有测试通过
    - 失败排查: 检查 Task 5 的 plugin-claude-code 包创建

17. 验证 opencode plugin spawn 参数包含引擎标识（Task 6）
    - `grep "ACP_ENGINE_TYPE" packages/plugin-opencode/src/process/acp-link-process-manager.ts`
    - 预期: 输出包含 `ACP_ENGINE_TYPE: "opencode"` 配置
    - 失败排查: 检查 Task 6 的 opencode plugin 适配

18. 验证 TypeScript 全项目编译无错误
    - `bunx tsc --noEmit 2>&1 | tail -10`
    - 预期: 无类型错误
    - 失败排查: 检查 Task 2（EngineRelayHandle 扩展）、Task 4（claude-bridge 包）、Task 5（plugin-claude-code 包）

19. 验证 precheck 通过
    - `bun run precheck 2>&1 | tail -20`
    - 预期: 格式化 + import 排序 + tsc + biome check 全部通过
    - 失败排查: 运行 `bun run biome check --write --linter-enabled=false` 先修复 import 排序，再逐步排查类型和 lint 错误

20. 端到端浏览器验收 — 模拟人类全链路操作（**核心验收步骤**）
    本步骤模拟真实用户从浏览器完成双引擎全链路操作，禁止绕过前端界面直接调用 API。所有操作必须通过浏览器 UI 交互完成。

    **环境搭建（CLI 命令）**:
    - 启动 RCS 后端: `bun run dev`（确保 `http://localhost:3000` 可访问）
    - 构建前端: `bun run build:web`
    - 同步数据库: `bun run db:push`
    - 创建 workspace 目录: `mkdir -p data/workspaces`
    - 启动 Machine A（opencode 容器）:
      ```bash
      docker run -d --name machine-opencode \
        -e RCS_URL=http://host.docker.internal:3000 \
        -e RCS_SECRET=<从 DB 或 config 获取的 secret> \
        -v $(pwd)/data/workspaces:/workspaces \
        <acp-link 镜像或本地构建> \
        --command opencode --labels opencode-test
      ```
    - 启动 Machine B（claude-code 容器）:
      ```bash
      docker run -d --name machine-claude-code \
        -e RCS_URL=http://host.docker.internal:3000 \
        -e RCS_SECRET=<从 DB 或 config 获取的 secret> \
        -e CLAUDE_CODE_CLI_PATH=/usr/local/bin/claude \
        -v $(pwd)/data/workspaces:/workspaces \
        <acp-link 镜像或本地构建> \
        --command claude-code --labels claude-code-test \
        --supported-engine-types '[{"type":"opencode"},{"type":"claude-code","cliPath":"/usr/local/bin/claude"}]'
      ```
    - 确认两台 machine 注册成功: 等待 30 秒后检查 `curl http://localhost:3000/web/registry/machines` 返回两台 online machine

    **浏览器操作（通过 Chrome 浏览器模拟人类操作）**:
    使用 `/agent-browser` skill 打开 Chrome 浏览器，所有交互模拟真实用户点击、输入、滚动行为，禁止绕过前端界面直接调用 API。

    **A. 登录系统**
    - 打开浏览器访问 `http://localhost:3000/ctrl/`
    - 在登录页面输入邮箱 `admin@test.com`、密码 `admin123456`
    - 点击"登录"按钮
    - 验证: 登录成功后跳转到控制面板首页

    **B. 创建 opencode Agent 并绑定 Machine A**
    - 在左侧 Sidebar 点击"智能体"或进入 Agent 配置页面
    - 点击"新建智能体模板"按钮
    - 在弹出的表单中依次填写:
      1. **名称**: 输入 `test-opencode-agent`
      2. **引擎类型下拉**: 选择 "OpenCode"
      3. **模型**: 选择任意可用模型
      4. **机器下拉**: 选择 Machine A（应显示 hostname 或 agentName，因为 opencode 引擎下所有 machine 都可选）
    5. 点击"创建"按钮
    - 验证: Agent 创建成功，toast 提示 "Agent已创建"

    **C. 创建 claude-code Agent 并绑定 Machine B**
    - 再次点击"新建智能体模板"按钮
    - 在弹出的表单中依次填写:
      1. **名称**: 输入 `test-claude-agent`
      2. **引擎类型下拉**: 选择 "Claude Code"
      3. **模型**: 选择任意可用 Claude 模型
      4. **机器下拉**: 验证下拉列表中只显示 Machine B（claude-code 引擎过滤了不支持 claude-code 的 machine）
    5. 点击"创建"按钮
    - 验证: Agent 创建成功，toast 提示 "Agent已创建"

    **D. 进入 opencode Agent 并发起对话**
    - 在侧边栏 Agent 列表中找到 `test-opencode-agent`
    - 点击该 Agent 卡片进入对话面板
    - 等待 Agent 实例启动（状态变为 running）
    - 在 Chat 输入框中输入: "你好，请介绍一下你自己"
    - 点击发送按钮或按 Enter
    - 验证: Agent 返回了回复文本（非空，非错误消息）
    - 继续输入第二轮: "请帮我写一个简单的 hello world 函数"
    - 验证: Agent 返回了包含代码的回复
    - 继续输入第三轮: "请解释一下你刚才写的代码"
    - 验证: Agent 返回了解释文本，至此 opencode 引擎完成 3 轮对话

    **E. 进入 claude-code Agent 并发起对话**
    - 点击侧边栏返回 Agent 列表
    - 找到 `test-claude-agent`
    - 点击该 Agent 卡片进入对话面板
    - 等待 Agent 实例启动（状态变为 running）
    - 在 Chat 输入框中输入: "你好，你是 Claude Code 吗？"
    - 点击发送按钮或按 Enter
    - 验证: Agent 返回了回复文本（非空，非错误消息）
    - 继续输入第二轮: "请帮我用 Python 实现一个快速排序算法"
    - 验证: Agent 返回了包含代码的回复
    - 继续输入第三轮: "这个算法的时间复杂度是多少？"
    - 验证: Agent 返回了正确的复杂度分析文本，至此 claude-code 引擎完成 3 轮对话

    **F. 验证侧边栏引擎标识**
    - 观察 Agent 侧边栏列表中两个 Agent 卡片
    - 验证: `test-opencode-agent` 卡片名称旁显示 "OC" 标签
    - 验证: `test-claude-agent` 卡片名称旁显示 "CC" 标签

    **G. 清理**
    - 停止并删除两个 Docker 容器: `docker stop machine-opencode machine-claude-code && docker rm machine-opencode machine-claude-code`
    - 在浏览器中删除两个测试 Agent

    **失败排查**:
    - Machine 注册失败: 检查 Docker 网络 + RCS_SECRET + acp-link 进程日志 (`docker logs machine-opencode`)
    - Agent 创建失败: 检查 engineType 下拉是否渲染、i18n key 是否存在（Task 10）
    - Machine 下拉过滤异常: 检查 registryApi.list 返回的 supportedEngineTypes 字段是否完整（Task 1 + Task 10）
    - Agent 实例启动失败: 检查 acp-link bridge 模块日志、ACP_ENGINE_TYPE 环境变量（Task 9 + Task 6）
    - 对话无回复: 检查 relay-handler.ts 的 onMessage 转发、bridge 模块的 sendData 逻辑、ACP WS 连接状态
    - 引擎标签不显示: 检查 AgentSidebarTree.tsx 的 AgentConfigItem.engineType 字段（Task 10）
