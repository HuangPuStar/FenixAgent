# 实例管理

> 对应文件：`src/services/instance.ts`、`src/services/instance-registry.ts`、`src/services/launch-spec-builder.ts`

## 这个模块干什么

Instance 服务管理 Agent 实例的完整生命周期。当用户在前端点击"启动 Agent"时，这个模块负责通过 `CoreRuntimeFacade` 委托启动实例，跟踪业务状态，管理 supplemental 元数据，直到用户点击"停止"。

核心动机：**RCS 不再直接 spawn 子进程和分配端口**。`CoreRuntimeFacade.launchInstance()` 统一处理进程管理，RCS 只管理 RCS 业务相关的元数据（userId、environmentId、instanceNumber、relay 计数等）。

## 核心概念

### Environment 与 Instance 的关系

Environment 是**资源管理层**，负责调度 Instance 的生命周期。Instance 由 Environment 按需 spawn 和管理。

关系：Environment 调度 Instance → Instance 是进程级概念，由 `CoreRuntimeFacade` 统一管理。RCS 通过 `InstanceRegistry` 存放业务 supplemental 数据。

spawn 策略由 Environment 统一管理：
- 是否已有 running Instance（复用）
- `autoStart` 配置
- 并发实例上限（`maxSessions`）
- `machineId` 远程部署

### SpawnedInstance（公共 API 类型）

这是对外暴露的实例视图，由 core snapshot + RCS supplement 合并生成：

- `id`：实例 ID，格式 `inst_xxxxxxxx`
- `userId`：启动者
- `port`：acp-link 监听端口（从 `snapshot.pluginMetadata.port` 获取，不再手动分配）
- `pid`：子进程 PID（从 `snapshot.pluginMetadata.pid` 获取）
- `status`：`starting` → `running` → `stopped` / `error`
- `apiKey`：acp-link 本地 WS 的认证 token（从 `snapshot.pluginMetadata.token` 获取）
- `environmentId`：关联的环境 ID（从 supplement 获取）
- `instanceNumber`：同一环境的第几个实例（从 supplement 获取）

### InstanceRegistry（`instance-registry.ts`）

**一句话**：封装 core 不维护的 RCS 业务补充元数据的内存注册表。

`InstanceRegistry` 是一个纯内存数据结构，不解决重启问题。它管理三类数据：

| 维度 | 数据结构 | 用途 |
|------|----------|------|
| supplements | `Map<instanceId, InstanceSupplement>` | 每个实例的 userId / environmentId / instanceNumber / organizationId / relay 计数 / activity 时间戳 |
| envCounters | `Map<environmentId, number>` | 每个环境的实例编号计数器（单调递增） |
| byEnvironment | `Map<environmentId, Set<instanceId>>` | 按环境快速查询实例 |

**核心方法**：

- `register / unregister`：注册/注销 supplement，同步维护 byEnvironment 索引
- `touchActivity(instanceId)`：更新最近一次业务活动时间
- `attachRelay / detachRelay(instanceId)`：管理 relay 连接计数，归零时开始空闲观察窗口
- `nextInstanceNumber(environmentId)`：双保险编号（max(counter, 现有实例最大编号) + 1）
- `reconcile(listCoreInstances)`：与 CoreRuntimeFacade 对账，移除孤儿条目

### engineType

`spawnInstanceFromEnvironment()` 从 AgentConfig 的 `engineType` 字段读取引擎类型，决定启动哪种 Agent 引擎：

| engineType | 说明 |
|------------|------|
| `opencode` | 默认引擎（OpenCode ACP） |
| `ccb` | Claude Code Bridge（历史遗留） |
| `claude-code` | Claude Code 引擎 |

无 AgentConfig 绑定（meta-agent 场景）时默认使用 `opencode`。

## Spawn 流程

### `spawnInstanceFromEnvironment(userId, environmentId, prefetchedEnv?, extraEnv?)`

这是核心 spawn 函数，完整流程：

```text
spawnInstanceFromEnvironment(userId, environmentId)
        │
        ▼
  1. 查 environment 记录，验证存在
        │
        ▼
  2. Phase 1: 注入平台级环境变量
     USER_META_API_KEY     = env.secret
     USER_META_BASE_URL    = getBaseUrl()
     USER_META_USER_ID     = env.userId ?? userId
     USER_META_ORG_ID      = env.organizationId ?? ""
     （extraEnv 参数可覆盖这些默认值）
        │
        ▼
  3. Phase 2: 构造 LaunchSpec
     有 agentConfigId → buildLaunchSpec()（完整资源解析）
     无 agentConfigId → buildBasicLaunchSpec()（最小可运行配置）
        │
        ▼
  4. 确定 nodeId（部署目标）
     agentConfig.machineId 存在 → 远程 node
     agentConfig.machineId 缺失 → "local-default"（本地）
        │
        ▼
  5. 远程节点连接检查（nodeId !== "local-default" 时）
     通过 findMachineConnectionById() 检查 machine WS 是否在线
     不可用抛出 AppError("MACHINE_OFFLINE")
        │
        ▼
  6. 委托 core 执行 launch
     facade.launchInstance({ instanceId, engineType, nodeId, launchSpec })
     返回 RuntimeInstanceSnapshot
        │
        ▼
  7. 注册 supplement + 构造 SpawnedInstance
     registry.register(instanceId, supplement)
     toSpawnedInstance(snapshot, supplement)
```

**关键变更**：不再手动分配端口（无 `probePort`/`allocatingPorts`）、不再构建 acp-link 命令行、不再从 stdout 捕获 Token。所有进程管理由 `CoreRuntimeFacade` 内部完成。端口/token/pid 从 `snapshot.pluginMetadata` 获取。

### `ensureRunning(userId, environmentId)`

封装了 spawn + 复用逻辑，是 relay 层和 `enterEnvironment()` 的统一入口：

```text
ensureRunning(userId, environmentId)
        │
        ▼
  1. 检查是否有运行中的实例 → 有则返回（status: "reused"）
        │
        ▼
  2. 查 environment，验证 autoStart
     autoStart === false → 抛出 AppError("AUTO_START_DISABLED")
        │
        ▼
  3. async gap 二次检查（防止并发重复创建）
     currentRunning.length >= env.maxSessions
       → 有实例则复用，无则抛出 AppError("MAX_SESSIONS_REACHED")
        │
        ▼
  4. spawnInstanceFromEnvironment()
     返回 { instance, status: "spawned" }
```

### `enterEnvironment(userId, environmentId, instanceNumber?)`

路由层聚合函数，组合 ensureRunning + session 创建：

```text
enterEnvironment(userId, environmentId, instanceNumber?)
        │
        ├── 指定 instanceNumber → 查找已有运行实例
        └── 未指定 → ensureRunning()
        │
        ▼
  查找或创建 session：
    - 检查已有 sessions 中是否有标题为 "Instance {n}" 的
    - 无则创建新 session
        │
        ▼
  返回 { session_id, instance_id, instance_number, instance_status, environment_id }
```

## 停止流程

```text
stopInstance(id, organizationId)
        │
        ▼
  1. 验证 supplement 存在 + 组织归属
        │
        ▼
  2. facade.stopInstance(id) — 委托 core 停止
        │
        ▼
  3. registry.unregister(id) — 注销 supplement
        │
        ▼
  4. 环境级计数器清理：
     getRunningInstancesByEnvironment() 为空 → registry.deleteCounter()
```

## 和其他模块的关系

- → `services/instance-registry.ts`（supplements 存储）
- → `services/core-bootstrap.ts`（`getCoreRuntime()` / `launchInstance` / `stopInstance`）
- → `services/launch-spec-builder.ts`（构造 AgentLaunchSpec）
- → `services/config/index.ts`（`getReadableAgentConfigById`）
- → `repositories/environment.ts`（环境配置验证）
- → `services/session.ts`（session 创建）
- → `services/workspace-resolver.ts`（workspace 路径计算）
- → `transport/acp-ws-handler.ts`（`findMachineConnectionById` 远程检查）
- ← `transport/relay/relay-handler.ts`（`ensureRunning` 调用）
- ← `routes/v2/instances/*`（路由层 API 端点）
- ← `services/acp-idle-monitor.ts`（空闲回收）
