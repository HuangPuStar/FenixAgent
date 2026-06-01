# 注册中心架构修复：恢复本地 Machine 能力

> 日期：2026-05-30
> 状态：Draft

## 背景

commit `bfdc7c9` (Feat/registry center #14) 引入了 Phase 2 注册中心架构，核心变更是将 acp-link 从"RCS 本地 spawn 的子进程"改为"独立运行、主动注册到 RCS 的远端 machine"。

这个变更删除了整个 `instance.ts`（403 行），导致：

1. **本地 spawn 能力完全丢失**——RCS 无法再在本机启动 agent
2. **auto-start 逻辑被移除**——RCS 启动时不再自动为 environment 启动实例
3. **graceful shutdown 不再清理实例**——`stopAllInstances()` 被删除
4. **relay 只走远端 machine 路径**——没有 machineId 就直接报错关闭
5. **environment-web.ts 核心函数变成空 stub**——`groupActiveInstancesByEnvironment()` 返回空 Map
6. **hooks 路由被删除**——webhook 触发器入口丢失

本地开发环境和单机部署场景完全不可用。

## 设计原则

1. **Machine 只提供运行时**——注册到 RCS，表示"我有能力运行 agent"，不决定何时启动、启动什么
2. **RCS 拥有完整控制权**——environment 决定用哪个 agent，RCS 负责指示 machine 去启动
3. **RCS 自身是默认 machine**——本地 spawn 不需要 machine 表记录，直接通过 CoreRuntimeFacade 管理
4. **远端 machine 与本地对等**——都跑 opencode plugin，都有完整 runtime 能力
5. **两条路径，统一入口**——relay 连接时根据 machineId 决定走哪条路径

## 架构

### Relay 统一入口

```
前端 relay WS 连接 /acp/relay/:agentId
        │
        ▼
  handleRelayOpen(agentId)
        │
        ├─ 查 environment → agentConfig
        │
        ├─ agentConfig.machineId 有值？
        │     │
        │     ├── YES → 远端路径
        │     │         找 machine WS 连接
        │     │         buildLaunchSpec() → session_start(完整 spec)
        │     │         machine 用 opencode plugin 执行
        │     │
        │     └── NO  → 本地路径（默认 machine）
        │               ensureRunning(userId, envId)
        │               spawnInstanceFromEnvironment()
        │               acp-link 回连 /acp/ws
        │
        ▼
  建立 relay 双向转发
```

### 两条路径的对比

| | 本地路径（默认 machine） | 远端路径 |
|---|---|---|
| **触发条件** | agentConfig.machineId 为空 | agentConfig.machineId 有值 |
| **spawn 执行者** | RCS 自身（CoreRuntimeFacade） | 远端 machine |
| **launch spec 传递** | 直接内存调用 facade.launchInstance() | 通过 WS session_start 消息发送 |
| **acp-link 生命周期** | RCS 进程管理（pid、stop） | machine 本地管理 |
| **WS 连接** | acp-link 回连 /acp/ws | machine 已有 WS 连接 |
| **workspace 路径** | RCS 本机文件系统 | machine 本机文件系统 |

### 本地 Machine 路径（恢复旧架构）

完整恢复 `instance.ts` 的能力：

- `spawnInstanceFromEnvironment(userId, environmentId)` — 组装 launchSpec → facade.launchInstance()
- `ensureRunning(userId, environmentId)` — 按需 spawn，含并发安全检查
- `findRunningInstanceByEnvironment(envId)` — 查找已运行实例
- `stopInstance(id, orgId)` — 停止实例
- `stopAllInstances()` — 优雅关闭时调用
- `listInstances(orgId)` — 列出组织下的实例
- `groupActiveInstancesByEnvironment()` — 按 environmentId 分组

**index.ts 恢复**：

- auto-start：RCS 启动时遍历 `autoStart=true` 的 environment，本地 spawn
- graceful shutdown：调用 `stopAllInstances()`

### 远端 Machine 路径（改进现有实现）

**session_start 协议升级**：

当前只有 `{ type: "session_start", session_id, agent_prompt }`，改为携带完整 launch spec：

```typescript
{
  type: "session_start",
  session_id: string,
  launch_spec: {
    // 与 buildLaunchSpec() 输出完全一致
    instanceId: string,
    engineType: "opencode",
    nodeId: string,
    launchSpec: AgentLaunchSpec  // model、provider、mcp、skill、permission 等
  }
}
```

**远端 machine 端改动**：

`SessionManager` 收到 `session_start` 后，用与旧架构 opencode plugin 相同的逻辑：
- 解析 launch spec
- spawn 子进程（command = opencode binary）
- 通过 ACP stdio 协议通信
- 上报 session_started / session_data / session_ended

### Machine 注册

- 远端 machine 注册时通过 `agentName` 自动绑定同 organization 下名称匹配的 agentConfig
- `machineId` 为 organization 粒度，一台 machine 归属一个组织
- RCS 自身不需要注册为 machine——本地路径完全绕过 machine 表

## 修改清单

### 恢复的文件（从 git 历史恢复并适配）

| 文件 | 说明 |
|---|---|
| `src/services/instance.ts` | 本地 spawn 能力，从 `bfdc7c9^` 恢复 |
| `src/schemas/instance.schema.ts` | Instance 相关请求校验 |

### 修改的文件

| 文件 | 变更 |
|---|---|
| `src/index.ts` | 恢复 auto-start、stopAllInstances、hooks 路由引用 |
| `src/transport/relay/relay-handler.ts` | 统一入口：无 machineId → 本地 spawn 路径；有 machineId → 远端路径传完整 launch spec |
| `src/services/environment-web.ts` | `groupActiveInstancesByEnvironment()` 改为调用 instance.ts 真实实现 |
| `src/routes/web/index.ts` | 恢复 instances 路由挂载 |
| `src/routes/web/environments.ts` | 恢复 instance 相关路由逻辑 |
| `packages/acp-link/src/server.ts` | `session_start` handler 接收完整 launch spec，用 opencode plugin 逻辑执行 |
| `packages/acp-link/src/client/session-manager.ts` | 适配 launch spec 格式 |
| `src/transport/acp-ws-handler.ts` | 恢复 boundEnvId 连接支持（本地 acp-link 回连场景） |

### 新增的文件

无。全部是恢复或修改现有文件。

### 删除的文件

无。

## 不在范围内

- 前端 machine 选择器 UI（已由 Phase 2 引入，保持不变）
- Docker 多 machine 部署配置（已有 docker-compose.machines.yml，保持不变）
- machine 心跳和 sweep 逻辑（已实现，保持不变）
- workflow 触发器（hooks 路由恢复后自动可用）
