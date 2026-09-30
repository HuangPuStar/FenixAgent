# ADR: 编排域独立包设计

- **日期**：2026-08-03
- **状态**：✅ 已确认

## 背景

当前 `src/` 中编排域相关代码散落在 8+ 个文件中（`services/instance.ts`、`services/launch-spec-builder.ts`、`transport/acp-ws-handler.ts`、`transport/relay/relay-handler.ts`、`transport/relay/yjs-frontend/`、`services/acp-idle-monitor.ts`、`routes/acp/`、`services/config/`），存在以下问题：

- 23 个 service 直连 `db/schema`，绕过 repository 层
- 5 个 route 直接 import `db/schema`
- `services/ ↔ transport/` 存在双向循环依赖
- 22 个文件超过 500 行
- 核心域（agentConfig、instance、machine、engine）缺少独立的 repository

目标：将编排域逻辑从混乱的 `src/` 中抽离为独立 `packages/orchestration/`，通过统一 controller 接口隔离依赖。

## 决策

### 1. 包结构与模块划分

```
packages/orchestration/
├── index.ts                         # 对外入口
├── agent-controller/
│   ├── index.ts                     # AgentController 主逻辑
│   └── agent-controller.test.ts
├── agent-node/
│   ├── agent-node.ts                # 远端连接，持有 WS，暴露 send/close
│   ├── agent-node-service.ts        # 生命周期管理，引用计数，空闲回收
│   ├── agent-node-service.test.ts
│   ├── agent-node-fsm.ts            # 状态机（connecting/connected/disconnected/closing/closed/destroyed）
│   └── types.ts
├── instance/
│   ├── instance.ts                  # 运行时载体，懒查询状态，提供 send()
│   └── types.ts
├── launch-spec/
│   ├── launch-spec-builder.ts       # LaunchSpec 全量构建
│   └── types.ts
├── types/
│   ├── deps.ts                      # 4 个 Repo 接口
│   ├── domain.ts                    # 公开领域类型
│   └── index.ts
└── errors.ts                        # 分层异常
```

### 2. 依赖注入方案：构造函数注入（方案 A）

```ts
// Package 对外暴露
export { AgentController } from './agent-controller';

// src/ 侧注入
const controller = new AgentController({
  agentConfigRepo: new AgentConfigRepoImpl(),
  environmentRepo: new EnvironmentRepoImpl(),
  agentMachineRepo: new AgentMachineRepoImpl(),
  agentEngineRepo: new AgentEngineRepoImpl(),
});
```

### 3. 外部依赖接口（4 个 Repo）

| 接口 | 职责 | 数据形态 |
|------|------|---------|
| `AgentConfigRepo` | 获取完整 Agent 配置 | 扁平聚合（A 方案），包含 skills/mcp/kb 的 {id, name} 摘要 |
| `EnvironmentRepo` | 查询环境元数据 | agentConfigId、machineId、并发限制、autoStart |
| `AgentMachineRepo` | 查询远端 Machine 连接信息 | host、port |
| `AgentEngineRepo` | 查询引擎类型信息 | type、version |

关联表（skill_to_agent_config 等）通过 `AgentConfigRepo` 一并返回，不单独暴露。

### 4. 领域模型定义

| 概念 | 定义 |
|------|------|
| **AgentConfig** | Agent 的配置蓝图，编排域只读。全量数据传递给 LaunchSpecBuilder |
| **Environment** | 资源管理层，调度 Instance 生命周期，持有 agentConfigId 而非 agentConfigName |
| **Instance** | 纯运行时类，无 DB 记录，N:1 绑定 AgentNode。提供 `status()`（懒查询）和 `send()` |
| **AgentNode** | 远端 Machine 在本侧的连接生命周期管理，持有 WS 信道。被动连接（Machine → AgentNodeService） |
| **AgentNodeService** | AgentNode 的生命周期管理，引用计数 + 空闲超时回收 |
| **Machine** | 远端运行面，由 AgentNode 抽象化，不再有独立实体 |
| **Session** | 下沉到 Agent 进程，不在编排域。`agent_session` 表已废弃 |

### 5. AgentNode 状态机

```
uninitialized → connecting → connected ←→ disconnected
                                    ↓
                                 closing
                                    ↓
                                 closed
                                    ↓
                               destroyed
```

关键规则：
- disconnected 期间 AgentNode 对象不销毁，标记状态，等待重连
- 重连策略：disconnected → connecting → connected
- AgentNodeService 通过引用计数 + 空闲超时决定是否 destroy
- Instance 只看到 available / unavailable，不感知具体连接状态

### 6. spawn 编排流程

```
controller.spawnInstance(envId, userId)
  │
  ├─ 1. 环境校验
  │   环境是否存在（EnvironmentRepo）
  │   并发数是否超限
  │
  ├─ 2. 构建 LaunchSpec
  │   agentConfigRepo.getConfig(configId) → 扁平数据
  │   agentEngineRepo.getEngine(engineId) → 引擎信息
  │   AgentController 聚合为 LaunchSpec
  │
  ├─ 3. 获取/创建 AgentNode
  │   AgentNodeService.ensureNode(machineId)
  │   如果不可用 → throw AgentNodeUnavailableError
  │
  ├─ 4. 创建 Instance
  │   agentNode.spawnInstance(launchSpec) → 异步
  │   Instance 注册到内存
  │
  └─ 5. 返回 Instance 引用
      调用方通过 instance.status() / instance.send() 操作
```

### 7. 错误处理：分层异常（方案 B）

```ts
class AgentNodeUnavailableError extends OrchestrationError {}
class ConcurrencyExceededError extends OrchestrationError {}
class MachineOfflineError extends OrchestrationError {}
// 调用方按需 catch 特定错误类型
```

### 8. 测试策略：单元测试 + Mock（方案 A）

所有外部 repo 和 AgentNode 通过 mock 注入，覆盖：
- 正常 spawn 流程
- 并发达限
- Machine 不可用
- AgentNode 重连场景
- 空闲回收

### 9. 旧代码迁移映射

| 目标 | 来源（吃哪些旧代码） |
|---------|-----------------|
| `agent-controller/index.ts` | `services/instance.ts` spawn 逻辑 + `transport/acp-ws-handler.ts` 连接管理 |
| `agent-node/agent-node.ts` | `transport/relay/relay-handler.ts` WS 持有、send、close |
| `agent-node/agent-node-service.ts` | `transport/relay/relay-handler.ts` relay handle 池管理 |
| `agent-node/agent-node-fsm.ts` | 新写 |
| `instance/instance.ts` | `services/instance.ts` 运行时部分 |
| `launch-spec/launch-spec-builder.ts` | `services/launch-spec-builder.ts` 近全量迁移 |
| 4 个 Repo 接口 | 新写，src/ 侧实现 |
| Chat 交接 | 不进入编排域，由 ChatChannelController 独立负责 |

## 考虑过的替代方案

| 方案 | 结论 |
|------|------|
| 全量重写 `src/` | ❌ 风险过大，没有增量验证 |
| 从底层往上推（先补 repo 再收拢 route） | ❌ 耗时过长，核心问题不解决 |
| 事件驱动 DI（方案 C） | ❌ 引入额外复杂性，调试困难 |
| 提供者/抽象工厂模式（方案 B） | ❌ 模板代码过多，不如构造函数注入直接 |
| Result 类型错误（方案 A） | ❌ TypeScript 生态不友好，调用方强制解包 |
| 统一异常类型（方案 C） | ❌ 调用方需要 code 匹配，不如分层 catch 直观 |

## 后果

### 积极后果

- 编排域逻辑不再散落在 `services/`、`transport/`、`routes/` 中
- 依赖方向清晰：`routes/services → AgentController ← Repo 实现`
- 新 Agent engine 类型接入只需实现 `AgentEngineRepo`
- 单元测试不再依赖数据库和 WebSocket

### 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 与 ChatChannelController 边界模糊 | Chat 侧通过 `instance.send()` 操作，不介入 AgentNode 创建 |
| 旧代码全部删除后可能遗漏隐式行为 | 在迁移映射表中对每个旧文件做全面审计后迁移 |
| YJS transport 强耦合 relay handler | YJS 逻辑不进入编排域，保留在 `src/transport/`，ChatChannelController 负责 |
| `agent_session` 表删除的兼容性 | 生成 Drizzle 迁移，确认无隐藏引用后再执行 |

## 相关文档

- `docs/arch/20-orchestration-management.md` — 编排域理想架构
- `docs/arch/02-user-org.md` — 用户与组织
- `docs/arch/04-agent-config.md` — Agent 配置
- `docs/arch/06-instance.md` — Agent 实例
- `docs/arch/changes.md` — 领域模型改动清单
