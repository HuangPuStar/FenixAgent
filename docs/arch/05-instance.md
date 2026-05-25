# 实例管理

> 对应文件：`src/services/instance.ts`

## 这个模块干什么

Instance 服务管理 acp-link 子进程的完整生命周期。当用户在前端点击"启动 Agent"时，这个模块负责把 acp-link 作为子进程启动起来，分配端口，跟踪状态，直到用户点击"停止"时 kill 掉。

简单说就是：**帮用户在服务器上启动和管理 AI Agent 进程**。

## 核心概念

### Environment 与 Instance 的关系

Environment 是**资源管理层**，负责调度 Instance 的生命周期。Instance 由 Environment 按需 spawn 和管理，不是 Environment 的"子容器"。

关系：Environment 调度 Instance → Instance 是进程级概念，由 Environment 根据 spawn 策略决定创建/复用。

spawn 策略由 Environment 统一管理：
- 是否已有 running Instance（复用）
- autoStart 配置
- 并发实例上限（maxSessions）
- 端口资源是否充足

### SpawnedInstance

每 spawn 一个 acp-link 子进程，就会创建一个 `SpawnedInstance` 记录，保存在内存的 `instances` Map 里。它包含：

- `id`：实例 ID，格式 `inst_xxxxxxxx`
- `environmentId`：关联的环境 ID
- `port`：acp-link 监听的端口（8888-8999 范围）
- `pid`：子进程的操作系统 PID
- `status`：`starting` → `running` → `stopped` / `error`
- `apiKey`：acp-link 本地 WS 的认证 token
- `instanceNumber`：同一环境的第几个实例（支持多实例）

### 端口分配

端口范围 8888-8999，分配策略是：
1. 跳过已被其他 instance 占用的端口
2. 跳过正在分配中的端口（防止并发冲突）
3. 对候选端口做 `probePort`（尝试 listen）确认真的可用
4. 分配后加入 `allocatingPorts` 集合，直到进程启动完成

### 多实例

同一个 environment 可以 spawn 多个 instance（比如同时处理多个用户请求）。每个 instance 有独立的端口和进程，通过 `instanceNumber` 区分。

## 两种 Spawn 方式

### 方式一：`spawnInstance(userId)`（无环境绑定）

直接 spawn 一个独立的 acp-link 进程，不绑定到任何持久环境。用于测试或临时场景。

### 方式二：`spawnInstanceFromEnvironment(userId, environmentId)`（绑定环境）

这是主流方式，完整流程：

```text
spawnInstanceFromEnvironment(userId, environmentId)
        │
        ▼
  1. 查 environment 记录，验证所有权
        │
        ▼
  2. 查找或创建 session
     （如果 DB 里有上次的 session 就复用，否则创建新的）
        │
        ▼
  3. 注入 workspace 配置
     写 .opencode/opencode.json：
     - default_agent = env.agentName
     - 如果有知识库绑定，注入 MCP knowledge 端点
        │
        ▼
  4. 分配端口
        │
        ▼
  5. spawn 子进程
     命令：acp-link --host 0.0.0.0 --group {secret} --port {port} opencode -- acp
     不设 ACP_RCS_URL（standalone 模式，不做 upstream 连接）
     cwd = env.workspacePath
        │
        ▼
  6. 从 stdout 捕获 auth token
     acp-link 启动时会打印 "Token: <64位hex>"
     用正则匹配后更新 instance.apiKey
        │
        ▼
  7. 返回 SpawnedInstance
```

## Instance 的使用方

Instance spawn 之后，谁会用到它？

1. **ACP Relay Handler**：前端连接 `/acp/relay/:agentId` 时，relay 通过 `findRunningInstanceByEnvironment()` 找到 instance，建立本地 WS 连接进行消息转发
2. **Hermes Client**：IM 消息到达时，hermes 通过 `findRunningInstanceByEnvironment()` 找到 instance，把消息发给 acp-link
3. **Agent Task Runner**：定时任务执行时，通过 instance 发送 prompt 给 Agent
4. **启动时 autoStart**：`index.ts` 遍历 `autoStart=true` 的环境，调用 `spawnInstanceFromEnvironment()`

## 停止流程

```text
stopInstance(id, userId)
        │
        ▼
  1. 关闭 relay 的本地 WS 连接
     （调用 closeInstanceLocalWs，通知 transport 层清理）
        │
        ▼
  2. SIGTERM 子进程
        │
        ▼
  3. 5 秒后还没退出就 SIGKILL
        │
        ▼
  4. instance.status = "stopped"
```

## 和其他模块的关系

- → `repositories/environment.ts`：读取环境配置
- → `repositories/session.ts`：创建/查找关联的 session
- → `auth/api-key-service.ts`：spawnInstance 时创建 API Key
- → `services/agent-knowledge.ts`：查询 Agent 的知识库绑定
- → `transport/acp-relay-handler.ts`：stop 时关闭本地 WS、closeInstanceLocalWs
- ← `transport/acp-relay-handler.ts`：relay 连接时查找 running instance
- ← `services/hermes-client.ts`：IM 消息路由时查找 running instance
- ← `services/agent-task-runner.ts`：定时任务执行时查找 running instance
- ← `index.ts`：autoStart 和 graceful shutdown
