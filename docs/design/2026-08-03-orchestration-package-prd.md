# PRD: 编排域独立包重构

> 来源：grill-with-docs 面试 | 日期：2026-08-03 | 标签：`ready-for-agent`

## Problem Statement

当前 `src/` 中编排相关代码散落在 8+ 个文件中，存在严重的架构腐化：

- 23 个 service 直连 `db/schema`，绕过 repository 层
- `services/` ↔ `transport/` 存在双向循环依赖
- 5 个 route 直接 import `db/schema`
- 22 个文件超过 500 行上限
- 核心域（agentConfig、instance、machine、engine）缺少独立 repository

开发者每做一个改动都需要在 `services/`、`transport/`、`routes/` 之间跳转，新增 Agent engine 类型时不得不修改 5+ 个文件。维护成本持续增长，新人上手困难。

## Solution

将编排域逻辑从混乱的 `src/` 中抽离为独立 `packages/orchestration/`，通过**统一 AgentController 接口**隔离依赖。`src/` 侧通过构造函数注入 4 个 Repo 实现。

核心价值：
- 编排逻辑集中在一个 package，单次改动不跨边界
- 依赖方向清晰：`routes/services → AgentController ← Repo 实现`
- 新 engine 类型接入只需实现 `AgentEngineRepo`
- 单元测试不再依赖 DB 和 WebSocket

## User Stories

1. As a 开发者，我希望能在一处找到所有编排相关的逻辑，不再需要在 `services/`、`transport/`、`routes/` 三个目录之间跳转
2. As a 开发者，当我需要新增一个 Agent engine 类型（如 opencode、claude-code）时，我只应该修改 engine 相关的配置，不应涉及 instance 创建或 WebSocket 连接管理
3. As a 开发者，我希望编排域和 Chat 域的边界清晰——编排负责创建 Instance，Chat 负责在 Instance 上对话，互不越界
4. As a 测试维护者，我希望编排域可以完全通过 mock 进行单元测试，不需要启动真实 Agent 进程
5. As a 运维人员，当远端 Machine 断连时，我不希望 Agent 实例整体崩溃，而是能自动重连并恢复服务
6. As a 组织管理员，我希望控制每个 Environment 的并发 Agent 数，避免资源耗尽
7. As a 平台管理员，闲置的 AgentNode 应该在超时后自动回收，释放资源
8. As a 新加入的开发者，我希望阅读 `AgentController` 的接口就能理解整个编排域的能力边界

## Implementation Decisions

### 架构决策摘要

在 ADR `spec/global/adr/2026-08-03-orchestration-package-design.md` 中已确认 17 项决策，摘要如下：

| 决策 | 结论 |
|------|------|
| 包形式 | 独立 `packages/orchestration/`，Bun workspace |
| 依赖注入 | 构造函数注入，4 个 Repo 接口 |
| 对外入口 | `new AgentController(deps)` |
| 错误处理 | 分层异常（`AgentNodeUnavailableError` 等） |
| Instance | 纯运行时类，无 DB 记录，懒查询状态 |
| AgentNode | 被动连接，持有 WS 信道 |
| Session | `agent_session` 表废弃，不进入编排域 |
| Machine | 由 AgentNode 抽象化 |

### Package 结构

```
packages/orchestration/
├── index.ts                         # 对外入口：export AgentController + types
├── agent-controller/
│   ├── index.ts                     # spawnInstance / stopInstance / listInstances
│   └── agent-controller.test.ts
├── agent-node/
│   ├── agent-node.ts                # WS 持有、send/close、连接状态
│   ├── agent-node-service.ts        # 生命周期管理、引用计数、空闲回收
│   ├── agent-node-service.test.ts
│   ├── agent-node-fsm.ts            # 状态机实现
│   └── types.ts
├── instance/
│   ├── instance.ts                  # 运行时载体、status()、send()
│   └── types.ts
├── launch-spec/
│   ├── launch-spec-builder.ts       # 全量 LaunchSpec 构建
│   └── types.ts
├── types/
│   ├── deps.ts                      # AgentConfigRepo / EnvironmentRepo / AgentMachineRepo / AgentEngineRepo
│   ├── domain.ts                    # 公开领域类型
│   └── index.ts
└── errors.ts                        # OrchestrationError 基类 + 子类
```

### 4 个 Repo 接口规格

编排域通过接口消费外部数据，不直接访问 DB。

**AgentConfigRepo** → 返回扁平聚合配置：
```ts
interface AgentConfigData {
  id: string;
  name: string;
  systemPrompt: string | null;
  modelProviderId: string;
  modelName: string;
  skills: { skillId: string; name: string }[];
  mcpServers: { mcpServerId: string; name: string }[];
  knowledgeBases: { kbId: string; name: string }[];
}
```

**EnvironmentRepo** → 返回环境元数据：
```ts
interface EnvironmentData {
  id: string;
  agentConfigId: string;
  machineId: string | null;  // null = 本地
  autoStart: boolean;
}
```

**AgentMachineRepo** → 返回 Machine 连接信息：
```ts
interface AgentMachineData {
  id: string;
  host: string;
  port: number;
}
```

**AgentEngineRepo** → 返回引擎类型：
```ts
interface AgentEngineData {
  id: string;
  type: string;
  version: string;
}
```

### 核心流程：spawnInstance

```
controller.spawnInstance(envId, userId)
  ├─ 1. 环境校验（EnvironmentRepo → 存在性）
  ├─ 2. 构建 LaunchSpec（AgentConfigRepo + AgentEngineRepo 聚合）
  ├─ 3. 获取 AgentNode（AgentNodeService.ensureNode — 被动等待 Machine 连接）
  ├─ 4. 创建 Instance（agentNode.spawnInstance，异步）
  └─ 5. 返回 Instance 引用
```

### 错误类型

分层异常，调用方按需 catch：

- `AgentNodeUnavailableError` — Machine 未连接
- `MachineOfflineError` — Machine 连接断开
- `LaunchSpecBuildError` — LaunchSpec 构建失败

### AgentNode 状态机

状态定义：`uninitialized → connecting → connected ↔ disconnected → closing → closed → destroyed`

关键行为：
- `disconnected` 期间对象不销毁，自动重连
- AgentNodeService 通过引用计数 + 空闲超时决定回收时机
- Instance 只暴露 `available` / `unavailable`

### 旧代码迁移

| 新文件 | 来源代码 |
|--------|---------|
| `agent-controller/index.ts` | `services/instance.ts` spawn 逻辑 + `transport/acp-ws-handler.ts` 连接管理 |
| `agent-node/agent-node.ts` | `transport/relay/relay-handler.ts` WS 持有、send、close |
| `agent-node/agent-node-service.ts` | `transport/relay/relay-handler.ts` relay handle 池管理 |
| `agent-node/agent-node-fsm.ts` | 新写 |
| `instance/instance.ts` | `services/instance.ts` 运行时部分 |
| `launch-spec/launch-spec-builder.ts` | `services/launch-spec-builder.ts` 近全量迁移 |
| 4 个 Repo 接口 | 新写，`src/` 侧实现 |

### DB 变更

- **废弃**：`agent_session` 表（需生成 Drizzle 迁移删除）

### Package 依赖

编排域 package 的 `package.json` 只依赖：
- `drizzle-orm`（类型引用，不操作 DB）
- 无 Bun / Elysia / WebSocket 服务器依赖（AgentNode 使用标准 `ws` 库或抽象 WS 接口）

## Testing Decisions

### 测试策略

采用方案 A：**单元测试全覆盖，mock 所有外部依赖**。

- 4 个 Repo 通过 mock 注入，无需真实 DB
- AgentNodeService 通过 mock WS 注入，无需真实 Agent 进程
- 每个 `test()` 上方添加中文注释说明行为和业务意图

### 优秀测试的标准

- 只测试外部可观察行为（spawn 成功/失败、状态转换、并发检查），不测试内部实现细节
- 每个错误路径至少有一个对应测试用例
- AgentNode 状态机覆盖所有合法转换和非法转换

### 测试模块

| 测试文件 | 覆盖范围 | 已有先例 |
|---------|---------|---------|
| `agent-controller.test.ts` | spawnInstance 正常/异常、并发限制、stopInstance | `src/__tests__/instance-concurrency.test.ts` |
| `agent-node-service.test.ts` | 创建/回收/空闲超时/引用计数 | `src/__tests__/relay-handler-lifecycle`（如有） |
| `agent-node-fsm.test.ts` | 所有状态转换 | 新写 |
| `instance.test.ts` | status() 懒查询、send() | `src/__tests__/instance-registry.test.ts` |
| `launch-spec-builder.test.ts` | 聚合正确性、缺失字段报错 | `src/__tests__/launch-spec-builder-errors.test.ts` |

## Out of Scope

以下**明确不在**本次重构范围内：

- ❌ Chat 功能 — ChatChannelController 是独立域
- ❌ YJS transport — 保留在 `src/transport/`，ChatChannelController 负责
- ❌ 前端 UI 改动
- ❌ Workflow 编排
- ❌ Knowledge Base / MCP Server / Skill 的 service 层重构（只读，通过 AgentConfigRepo 聚合）
- ❌ Organization / User / Team 重构（改动 11）
- ❌ IM Channel 改动
- ❌ ACP 协议改动
- ❌ 除 `agent_session` 外的数据库 schema 变更

## Further Notes

### 验收标准

1. `bun test packages/orchestration/` 全绿
2. `bun run precheck` 全绿（orgestation 包已在 tsconfig 中引用）
3. 旧代码删除后 `src/` 不再包含编排域核心逻辑
4. 所有引用编排功能的外部代码（routes/api/openai-chat.ts 等）通过 `AgentController` 接口调用
5. `agent_session` 表已通过迁移安全删除

### 与现有文档的联动

- `docs/arch/20-orchestration-management.md` 是目标架构基线
- `docs/arch/changes.md` 的改动 1-4、12 与本 PRD 相关
- `docs/design/2026-07-08-system-default-machine-engine-design.md` 中 machine fallback 逻辑在实现 AgentNodeService 时参考

### 风险提示

- `transport/relay/relay-handler.ts` 是 YJS 和编排的耦合点。迁移 AgentNode 时需确保 YJS 侧不受影响，路径由 ChatChannelController 维护
- `services/instance.ts` 中的并发检查逻辑目前与 User 维度的并发混合。迁移时需明确只迁移 Environment 维度的并发控制
