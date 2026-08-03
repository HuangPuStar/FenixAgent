# I3: AgentController — spawn 编排 + Instance + LaunchSpec

## What to build

实现编排域的核心入口 `AgentController`，以及其依赖的 `Instance` 运行时载体和 `LaunchSpecBuilder`。

这是编排域的"大脑"——`spawnInstance()` 串联所有子域（AgentNode、Instance、LaunchSpec），为外部提供统一的 Agent 实例创建、查询、停止能力。

## 具体产出

### 1. `instance/types.ts`

```ts
interface InstanceInfo {
  instanceId: string;
  environmentId: string;
  agentConfigId: string;
  machineId: string;
  status: "starting" | "running" | "stopped" | "error";
}
```

### 2. `instance/instance.ts` — Instance 运行时载体

- **纯运行时类**，无 DB 持久化
- N 对 1 AgentNode（一个 AgentNode 可承载多个 Instance）
- 懒查询：`status()` 从 AgentNode 状态推导
- `send(message)`：直接通过 AgentNode 的 WS 发送

```ts
class Instance {
  readonly instanceId: string;
  status(): InstanceStatus;      // 懒查询 = starting | running | stopped | error
  send(data: unknown): void;     // 通过 AgentNode WS 发送
  stop(): void;                  // 通知 Agent 进程停止
}
```

### 3. `launch-spec/types.ts`

```ts
interface LaunchSpec {
  environmentId: string;
  agentConfig: AgentConfigData;    // 扁平聚合（I1 定义）
  engine: AgentEngineData;         // 引擎信息
  cwd: string;                     // workspace 路径
  userId: string;
  // Skills/knowledgeBases/mcpServers 已内嵌在 agentConfig 中
}
```

### 4. `launch-spec/launch-spec-builder.ts`

```ts
class LaunchSpecBuilder {
  constructor(deps: {
    agentConfigRepo: AgentConfigRepo;
    environmentRepo: EnvironmentRepo;
    agentEngineRepo: AgentEngineRepo;
  });

  /** 从 envId + userId 构建完整 LaunchSpec */
  async build(envId: string, userId: string): Promise<LaunchSpec>;
}
```

**构建流程**：
1. `environmentRepo.getEnvironment(envId)` → 获取 agentConfigId、machineId
2. `agentConfigRepo.getConfig(agentConfigId)` → 获取扁平配置（含 skills/kb/mcp）
3. `agentEngineRepo.getEngine(engineId)` → 获取引擎信息
4. 聚合返回 `LaunchSpec`

缺失字段时抛 `LaunchSpecBuildError`（含诊断信息）。

### 5. `agent-controller/index.ts` — AgentController

```ts
class AgentController {
  constructor(deps: {
    agentNodeService: AgentNodeService;
    launchSpecBuilder: LaunchSpecBuilder;
    environmentRepo: EnvironmentRepo;
  });

  /** 创建 Agent 运行实例 */
  async spawnInstance(envId: string, userId: string): Promise<Instance>;

  /** 停止指定实例 */
  async stopInstance(instanceId: string): Promise<void>;

  /** 列出当前所有活跃实例 */
  listInstances(): Instance[];
}
```

**spawnInstance 完整流程**：
1. 环境校验 → `environmentRepo.getEnvironment(envId)`
2. 并发检查 → 当前 Instance 数 vs `maxConcurrency`
3. 构建 LaunchSpec → `launchSpecBuilder.build(envId, userId)`
4. 获取 AgentNode → `agentNodeService.ensureNode(machineId)`
5. 创建 Instance → `agentNode._spawnInstance(launchSpec)`
6. 返回 Instance 引用

**错误场景**：

| 场景 | 异常 |
|------|------|
| envId 不存在 | `EnvironmentNotFoundError` |
| 并发超限 | `ConcurrencyExceededError` |
| Machine 未连接 | `AgentNodeUnavailableError` |
| LaunchSpec 缺失字段 | `LaunchSpecBuildError` |

### 6. 测试

文件：`agent-controller/agent-controller.test.ts`

覆盖：
- 正常 spawn：完整流程，返回 Instance，status() = running
- 并发超限：env maxConcurrency=1，连续两次 spawnInstance，第二次抛错
- Machine 不可用：agentNodeService 无对应 AgentNode，抛 AgentNodeUnavailableError
- LaunchSpec 缺失字段：agentConfig 无 modelName，抛 LaunchSpecBuildError
- Instance send：instance.send() → AgentNode WS 发送正确数据
- Instance stop：instance.stop() → Instance 状态变为 stopped
- listInstances：多次 spawn 后 listInstances 返回正确列表

## Acceptance criteria

- [ ] `controller.spawnInstance(envId, userId)` 返回 Instance 引用
- [ ] 全部异常路径有对应测试并正确抛出
- [ ] Instance 懒查询状态正确反映 AgentNode 状态
- [ ] `instance.send()` 通过 AgentNode WS 发送
- [ ] `bun test packages/orchestration/agent-controller/` 全绿
- [ ] 全 mock，无 DB/WS/Agent 进程依赖

## Blocked by

[I2: AgentNode 生命周期](02-agent-node-lifecycle.md)
