# I1: 编排域包基础 — 类型 + 错误 + 包骨架

## What to build

创建 `packages/orchestration/` 包的基础结构：包骨架、类型定义、错误体系、对外入口。

这是纯基础设施切片——不包含任何运行时逻辑，但为后续三个 Issue 提供统一类型契约。

## 具体产出

### 1. `package.json`

- name: `@fenix/orchestration`
- dependencies: 仅 `drizzle-orm`（类型引用）、`zod/v4`（如有校验需求）
- 无 Bun/Elysia/WS 服务器依赖

### 2. `tsconfig.json`

- 继承 workspace root tsconfig
- 确保 `src/` 可以 import `@fenix/orchestration`

### 3. `types/deps.ts` — 4 个 Repo 接口

```ts
interface AgentConfigRepo {
  getConfig(configId: string): Promise<AgentConfigData | null>;
}

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

interface EnvironmentRepo {
  getEnvironment(envId: string): Promise<EnvironmentData | null>;
}

interface EnvironmentData {
  id: string;
  agentConfigId: string;
  machineId: string | null;
  maxConcurrency: number;
  autoStart: boolean;
}

interface AgentMachineRepo {
  getMachine(machineId: string): Promise<AgentMachineData | null>;
}

interface AgentMachineData {
  id: string;
  host: string;
  port: number;
}

interface AgentEngineRepo {
  getEngine(engineId: string): Promise<AgentEngineData | null>;
}

interface AgentEngineData {
  id: string;
  type: string;
  version: string;
}
```

### 4. `types/domain.ts` — 公开领域类型

- `InstanceInfo`（状态、关联的 envId/agentConfigId）
- `AgentNodeStatus`（uninitialized/connecting/connected/disconnected/closing/closed/destroyed）
- `SpawnRequest`（envId, userId 等）
- `SpawnResult`

### 5. `errors.ts` — 错误分层

```ts
class OrchestrationError extends Error { code: string; }
class AgentNodeUnavailableError extends OrchestrationError {}
class ConcurrencyExceededError extends OrchestrationError {}
class MachineOfflineError extends OrchestrationError {}
class LaunchSpecBuildError extends OrchestrationError {}
class EnvironmentNotFoundError extends OrchestrationError {}
```

### 6. `index.ts` — 对外入口

- export 所有类型、接口、错误类
- 暂不 export AgentController（I3 添加）

## Acceptance criteria

- [ ] `packages/orchestration/package.json` 存在，name 为 `@fenix/orchestration`
- [ ] `src/` 可以 `import { AgentConfigRepo, EnvironmentRepo, ... } from "@fenix/orchestration"`
- [ ] 所有类型、接口、错误类可被外部 import 使用
- [ ] `bun run precheck` 无新增错误（包尚未加入 workspace 除外）

## Blocked by

无 — 可立即开始
