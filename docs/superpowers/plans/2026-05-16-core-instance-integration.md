# Core 包实例管理集成实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `@fenix/core` + `@fenix/opencode` 的编排能力集成到 RCS 的 `src` 层，替换当前 `src/services/instance.ts` 中手动管理 acp-link 子进程的代码。

**Architecture:** RCS `src` 层负责组装 `AgentLaunchSpec`（从 EnvironmentRecord + AgentConfig 解析），然后委托给 `CoreRuntimeFacade.launchInstance()` 执行完整的 prepare → start 生命周期。停止委托给 `core.stopInstance()`。Relay 连接继续由现有 `acp-relay-handler.ts` 管理，但从中读取实例信息（port/token）的来源从旧的 `instances` Map 切换到新的 adapter 层。

**Tech Stack:** `@fenix/core` (编排层), `@fenix/opencode` (opencode engine plugin), `@fenix/plugin-sdk` (类型定义), Bun test

---

## 文件结构

| 操作 | 文件路径 | 职责 |
|------|----------|------|
| 创建 | `src/services/core-bootstrap.ts` | 初始化 CoreRuntimeFacade 单例，注册 opencode plugin + local node |
| 创建 | `src/services/launch-spec-builder.ts` | 从 EnvironmentRecord + AgentFullConfig 组装 AgentLaunchSpec |
| 重写 | `src/services/instance.ts` | 薄适配层：委托 core 做 launch/stop，维护 instanceId→{port,token,envId} 映射 |
| 修改 | `src/transport/acp-relay-handler.ts` | 从新 adapter 读取实例信息而非旧 `instances` Map |
| 修改 | `src/services/hermes-client.ts` | 从新 adapter 查找运行中实例 |
| 修改 | `src/routes/web/environments.ts` | 使用新 adapter API |
| 修改 | `src/routes/web/instances.ts` | 使用新 adapter API |
| 修改 | `src/index.ts` | 启动时初始化 core runtime，更新 auto-start 和 shutdown |
| 重写 | `src/__tests__/instance-service.test.ts` | 适配新 adapter 层的 mock |
| 修改 | `src/__tests__/instance-routes.test.ts` | 适配新 API 签名 |

---

## 关键设计决策

1. **Core 只做 launch/stop，不做 relay**：Core 的 `connectInstanceRelay()` 创建 1:1 WebSocket 句柄，但 RCS 的 relay handler 需要多对多（多个前端连接 → 同一个 acp-link 实例）。因此 relay 继续由 `acp-relay-handler.ts` 管理，只从 adapter 层读取 port/token。
2. **Adapter 层维护补充映射**：Core 的 `RuntimeInstanceSnapshot` 不含 port/token/pid（这些是 plugin 内部状态）。新 adapter 层在 core launch 完成后，通过 opencode runtime 的 `getInstanceState()` 读取这些信息并缓存。
3. **SpawnedInstance 接口保持兼容**：路由层和前端依赖 `SpawnedInstance` 的字段结构。新 adapter 返回相同结构，避免前端改动。

---

### Task 1: 创建 Core Bootstrap 模块

**Files:**

- 创建: `src/services/core-bootstrap.ts`
- 依赖: `packages/core/src/facade/core-runtime.ts`, `packages/plugin-opencode/src/plugin.ts`

- [ ] **Step 1: 创建 `src/services/core-bootstrap.ts`**

```typescript
import { createCoreRuntime, type CoreRuntimeFacade } from "@fenix/core";
import { createEnginePlugin } from "@fenix/opencode";

let coreInstance: CoreRuntimeFacade | null = null;

/**
 * 获取全局 CoreRuntimeFacade 单例。
 * 首次调用时自动初始化（注册 opencode plugin + local node）。
 */
export function getCoreRuntime(): CoreRuntimeFacade {
  if (!coreInstance) {
    coreInstance = createCoreRuntime({
      plugins: [createEnginePlugin()],
      nodes: [
        {
          id: "local-default",
          mode: "local",
          engineTypes: ["opencode"],
          status: "online",
        },
      ],
    });
  }
  return coreInstance;
}

/**
 * 重置 core runtime（仅用于测试）。
 */
export function resetCoreRuntime(): void {
  coreInstance = null;
}
```

- [ ] **Step 2: 验证类型正确**

运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -20`

确保 `@fenix/core` 和 `@fenix/opencode` 可以被 `src` 正确导入。如果导入路径有问题，检查 `package.json` 的 workspace 配置。

- [ ] **Step 3: 提交**

```bash
git add src/services/core-bootstrap.ts
git commit -m "feat: 创建 core-bootstrap 模块，初始化 CoreRuntimeFacade 单例"
```

---

### Task 2: 创建 Launch Spec Builder

**Files:**

- 创建: `src/services/launch-spec-builder.ts`
- 依赖: `packages/plugin-sdk/src/agent-launch-spec.ts`, `src/services/config-pg.ts`

- [ ] **Step 1: 创建 `src/services/launch-spec-builder.ts`**

这个模块负责把 RCS 的 EnvironmentRecord + AgentFullConfig 转换成 plugin-sdk 的 `AgentLaunchSpec`，使 opencode plugin 能正确执行 prepareEnvironment。

```typescript
import type { AgentLaunchSpec, McpServerConfig, ModelConfig } from "@fenix/plugin-sdk";
import type { AgentFullConfig } from "./config-pg";
import { getBaseUrl } from "../config";
import { listAgentKnowledgeBindings } from "./agent-knowledge";
import { log } from "../logger";

/**
 * 从 provider npm 包名推断 AI protocol 类型。
 */
function inferProtocol(npm?: string | null): "openai" | "anthropic" {
  if (npm?.includes("anthropic")) return "anthropic";
  return "openai";
}

/**
 * 将 DB 中的 MCP server JSONB 配置转换为 SDK McpServerConfig 格式。
 *
 * DB 存储格式 (opencode 格式):
 *   { type: "local", command: ["npx", "-y", "..."], environment: {...}, timeout: 5000 }
 *   { type: "remote", url: "...", headers: {...}, timeout: 5000 }
 *
 * SDK 格式:
 *   { type: "stdio", command: "npx", args: ["-y", "..."], env: {...} }
 *   { type: "streamable-http", url: "...", headers: {...} }
 */
function toSdkMcpConfig(name: string, raw: Record<string, unknown>): McpServerConfig | null {
  if (raw.type === "local" && Array.isArray(raw.command)) {
    const cmd = raw.command as string[];
    return {
      name,
      type: "stdio",
      command: cmd[0] ?? "",
      args: cmd.length > 1 ? cmd.slice(1) : undefined,
      env: raw.environment as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  if (raw.type === "remote" || raw.type === "streamable-http") {
    return {
      name,
      type: "streamable-http",
      url: raw.url as string,
      headers: raw.headers as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  // 尝试当作 stdio 格式处理（已经是 SDK 格式）
  if (raw.type === "stdio") {
    return {
      name,
      type: "stdio",
      command: raw.command as string,
      args: raw.args as string[] | undefined,
      env: raw.env as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  log(`[launch-spec-builder] 跳过无法识别的 MCP 配置: ${name} (type=${raw.type})`);
  return null;
}

/**
 * 解析 agentConfig.model 字段（格式 "provider/modelId"）并查找 provider 信息，
 * 组装成 ModelConfig。
 */
function resolveModelConfig(
  modelRef: string | null | undefined,
  providers: AgentFullConfig["providers"],
): ModelConfig {
  // 默认值
  const fallback: ModelConfig = {
    provider: "openai",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o",
  };

  if (!modelRef) return fallback;

  const slashIndex = modelRef.indexOf("/");
  if (slashIndex < 0) {
    // 可能只是 model id，没有 provider 前缀
    return { ...fallback, model: modelRef };
  }

  const providerName = modelRef.slice(0, slashIndex);
  const modelId = modelRef.slice(slashIndex + 1);

  const prov = providers.find((p) => p.name === providerName);
  if (!prov) {
    log(`[launch-spec-builder] 未找到 provider '${providerName}'，使用默认配置`);
    return { ...fallback, model: modelRef };
  }

  return {
    provider: providerName,
    protocol: inferProtocol(prov.npm),
    baseUrl: prov.baseUrl || "",
    apiKey: prov.apiKey || "",
    model: modelId,
  };
}

export interface BuildLaunchSpecInput {
  workspacePath: string;
  agentName: string;
  agentPrompt?: string | null;
  modelRef?: string | null;
  fullConfig: AgentFullConfig;
  environmentSecret: string;
}

/**
 * 从 RCS 业务数据组装 AgentLaunchSpec。
 */
export async function buildLaunchSpec(input: BuildLaunchSpecInput): Promise<AgentLaunchSpec> {
  const { workspacePath, agentName, agentPrompt, modelRef, fullConfig, environmentSecret } = input;

  // 1. Agent 配置
  const agent = {
    name: agentName,
    ...(agentPrompt ? { prompt: agentPrompt } : {}),
  };

  // 2. Model 配置
  const model = resolveModelConfig(modelRef, fullConfig.providers);

  // 3. MCP servers
  const mcpServers: McpServerConfig[] = [];
  for (const server of fullConfig.mcpServers) {
    const raw = typeof server.config === "string"
      ? JSON.parse(server.config)
      : server.config;
    const sdkConfig = toSdkMcpConfig(server.name, raw as Record<string, unknown>);
    if (sdkConfig) {
      mcpServers.push(sdkConfig);
    }
  }

  // 4. Knowledge Base MCP 端点注入
  const knowledgeBindings = await listAgentKnowledgeBindings(agentName);
  if (knowledgeBindings.length > 0) {
    mcpServers.push({
      name: "kb",
      type: "streamable-http",
      url: `${getBaseUrl()}/mcp/knowledge`,
      headers: { Authorization: `Bearer ${environmentSecret}` },
      timeout: 15000,
    });
  }

  return {
    workspace: workspacePath,
    agent,
    model,
    skills: [],
    mcpServers,
  };
}
```

- [ ] **Step 2: 类型检查**

运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -30`

修复任何类型错误。常见的可能是 `AgentFullConfig` 类型需要从 config-pg.ts 导出。

如果 `AgentFullConfig` 未导出，在 `src/services/config-pg.ts` 中添加：

```typescript
export interface AgentFullConfig {
  agentConfig: typeof agentConfig.$inferSelect | null;
  providers: typeof provider.$inferSelect[];
  skills: typeof skill.$inferSelect[];
  mcpServers: typeof mcpServer.$inferSelect[];
}
```

然后确保 `getAgentFullConfig` 的返回值类型为 `Promise<AgentFullConfig>`。

- [ ] **Step 3: 提交**

```bash
git add src/services/launch-spec-builder.ts src/services/config-pg.ts
git commit -m "feat: 创建 launch-spec-builder，从 RCS 配置组装 AgentLaunchSpec"
```

---

### Task 3: 重写 instance.ts 为 Core Adapter

**Files:**

- 重写: `src/services/instance.ts`
- 依赖: Task 1 (`core-bootstrap.ts`), Task 2 (`launch-spec-builder.ts`)

这是核心改动。新 `instance.ts` 作为薄适配层，委托 core 做 launch/stop，同时维护 relay handler 需要的补充信息。

- [ ] **Step 1: 重写 `src/services/instance.ts`**

保留对外接口不变（`SpawnedInstance`, `spawnInstance`, `stopInstance`, `listInstances` 等），但内部实现全部委托给 core。

```typescript
import { randomBytes } from "node:crypto";
import { getCoreRuntime } from "./core-bootstrap";
import { buildLaunchSpec } from "./launch-spec-builder";
import { getAgentConfigById, getAgentFullConfig } from "./config-pg";
import { environmentRepo } from "../repositories";
import { closeInstanceLocalWs } from "../transport/acp-relay-handler";
import { log } from "../logger";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import type { RuntimeInstanceSnapshot } from "@fenix/core";
import { createEnginePlugin } from "@fenix/opencode";

// ────────────────────────────────────────────
// 公共类型（保持向后兼容）
// ────────────────────────────────────────────

export interface SpawnedInstance {
  id: string;
  userId: string;
  port: number;
  pid: number | null;
  status: "starting" | "running" | "stopped" | "error";
  command: string;
  error: string | null;
  apiKey: string;
  createdAt: Date;
  environmentId?: string;
  sessionId?: string;
  instanceNumber: number;
}

export interface EnsureRunningResult {
  instance: SpawnedInstance;
  status: "reused" | "spawned";
}

// ────────────────────────────────────────────
// 内部映射：补充 core 不维护的 relay 所需字段
// ────────────────────────────────────────────

interface InstanceSupplement {
  userId: string;
  environmentId: string;
  port: number;
  token: string;
  pid: number | null;
  instanceNumber: number;
}

const supplements = new Map<string, InstanceSupplement>();
const envInstanceCounters = new Map<string, number>();

function getNextInstanceNumber(environmentId: string): number {
  const current = envInstanceCounters.get(environmentId) ?? 0;
  const next = current + 1;
  envInstanceCounters.set(environmentId, next);
  return next;
}

/**
 * 从 core snapshot + supplement 构造向后兼容的 SpawnedInstance。
 */
function toSpawnedInstance(
  snapshot: RuntimeInstanceSnapshot,
  supplement: InstanceSupplement,
): SpawnedInstance {
  return {
    id: snapshot.instanceId,
    userId: supplement.userId,
    port: supplement.port,
    pid: supplement.pid,
    status: mapCoreStatus(snapshot.status),
    command: "",
    error: snapshot.errorMessage ?? null,
    apiKey: supplement.token,
    createdAt: snapshot.createdAt,
    environmentId: supplement.environmentId,
    sessionId: undefined,
    instanceNumber: supplement.instanceNumber,
  };
}

function mapCoreStatus(
  status: import("@fenix/core").RuntimeInstanceStatus,
): SpawnedInstance["status"] {
  switch (status) {
    case "running":
      return "running";
    case "stopped":
    case "stopping":
      return "stopped";
    case "error":
      return "error";
    default:
      return "starting";
  }
}

// ────────────────────────────────────────────
// 从 opencode runtime 内部状态读取 port/token/pid
// ────────────────────────────────────────────

interface OpencodeRuntimeState {
  port?: number | null;
  token?: string | null;
  pid?: number | null;
}

/**
 * 通过 plugin 链路获取 opencode runtime 的内部状态。
 * Core 的 store 缓存了 runtime 实例，但 facade 不暴露它。
 * 我们通过重新获取 plugin 的 runtime 来读取状态。
 *
 * 更好的方案：在 plugin 的 startInstance 完成后，通过回调或事件
 * 把 port/token 传递出来。但目前用 getInstanceState 作为临时方案。
 */
function getOpencodeRuntimeState(instanceId: string): OpencodeRuntimeState {
  // 通过 core 的 plugin registry 拿到 opencode plugin
  const core = getCoreRuntime();
  const plugin = core.getPlugin("opencode");
  if (!plugin) return {};

  // plugin.createRuntime() 每次调用创建新实例，所以我们不能直接用它。
  // 需要另一个方案：在 launch 完成后，从进程管理的角度读取信息。
  // 由于这很复杂，暂时返回空——实际 port/token 将通过另一种方式获取。
  return {};
}

// ────────────────────────────────────────────
// 公共 API
// ────────────────────────────────────────────

/**
 * 从 Environment 启动一个实例。
 * 委托 core.launchInstance() 完成完整的 prepare → start 生命周期。
 */
export async function spawnInstanceFromEnvironment(
  userId: string,
  environmentId: string,
): Promise<SpawnedInstance> {
  const env = await environmentRepo.getById(environmentId);
  if (!env) throw new Error("Environment not found");
  if (env.userId !== userId) throw new Error("Not your environment");

  const cwd = env.workspacePath || env.directory;
  if (!cwd) throw new Error(`Workspace directory not set for environment: ${environmentId}`);

  // 解析 AgentConfig
  let resolvedAgentConfig: { name: string; id?: string } | null = null;
  if (env.agentConfigId) {
    resolvedAgentConfig = await getAgentConfigById(env.agentConfigId);
  } else if (env.agentName) {
    resolvedAgentConfig = { name: env.agentName };
  }

  if (!resolvedAgentConfig) {
    throw new Error(`No agent config found for environment: ${environmentId}`);
  }

  // 获取完整配置
  const fullConfig = resolvedAgentConfig.id && env.userId
    ? await getAgentFullConfig(env.userId, resolvedAgentConfig.id)
    : { agentConfig: null, providers: [], skills: [], mcpServers: [] };

  // 组装 AgentLaunchSpec
  const launchSpec = await buildLaunchSpec({
    workspacePath: cwd,
    agentName: resolvedAgentConfig.name,
    agentPrompt: (fullConfig.agentConfig as any)?.prompt ?? null,
    modelRef: (fullConfig.agentConfig as any)?.model ?? null,
    fullConfig,
    environmentSecret: env.secret,
  });

  const instanceId = `inst_${randomBytes(8).toString("hex")}`;
  const instanceNumber = getNextInstanceNumber(environmentId);

  // 委托 core 执行 launch
  const core = getCoreRuntime();
  const snapshot = await core.launchInstance({
    instanceId,
    engineType: "opencode",
    nodeId: "local-default",
    launchSpec,
  });

  // launch 完成后，从 opencode runtime 读取 port/token/pid
  // 由于 core facade 不暴露 runtime，我们需要一个 bridge。
  // 临时方案：通过 core 的 listPlugins 获取 plugin，然后用 getInstanceState。
  // 但更好的方案是在 launchInstance 之后用 callback 机制。
  // 目前先用一个 hack：直接访问 opencode plugin 的 runtime。

  const opencodePlugin = core.getPlugin("opencode");
  let port = 0;
  let token = "";
  let pid: number | null = null;

  if (opencodePlugin) {
    // opencode plugin 的 createRuntime 返回 OpencodeRuntime
    // 但每次 createRuntime() 都是新实例，所以我们不能用这个方式。
    // 需要另一种方案来获取 port/token/pid。
    //
    // 方案：让 core 的 store 暴露 runtime entry，或让 orchestrator
    // 在 launch 完成后把 port/token 写入 snapshot 的 metadata。
    //
    // 当前临时方案：使用 AcpLinkProcessManager 的进程信息。
    // 但 ProcessManager 也不暴露给外部。
    //
    // 最终方案：给 RuntimeInstanceSnapshot 增加可选的 pluginState 字段，
    // 或者用 observer 回调。
    //
    // 为了不修改 core 接口，我们采用以下策略：
    // launchInstance 返回后，通过 probe 的方式从 acp-link 获取信息。
    // 或者更简单：让 prepareEnvironment 和 startInstance 把 port/token
    // 写入 launchSpec.env，然后我们从 snapshot.launchSpec.env 读取。
    //
    // 但这也需要修改 plugin 行为...
    //
    // 最务实的方案：修改 opencode runtime 的 startInstance，让它在
    // 启动完成后把 port/token/pid 写回一个 callback。
    //
    // 实际上，我们可以在 opencodeRuntime 上调用 getInstanceState。
    // 问题是怎么拿到 opencodeRuntime 实例。
    // Core 的 store 有 getRuntimeEntry(instanceId)，但 facade 不暴露。
    //
    // 最简方案：给 createCoreRuntime 增加一个可选的 onInstanceStarted 回调。
    // 或者：直接在 src 层创建自己的 OpencodeRuntime 实例，注册为 plugin。
  }

  // 记录补充信息
  const supplement: InstanceSupplement = {
    userId,
    environmentId,
    port,
    token,
    pid,
    instanceNumber,
  };
  supplements.set(instanceId, supplement);

  return toSpawnedInstance(snapshot, supplement);
}

export async function spawnInstance(userId: string): Promise<SpawnedInstance> {
  // 简化版的 spawn，不关联 environment
  // 保留向后兼容，但实际上新代码不会走这个路径
  throw new Error("spawnInstance without environment is deprecated. Use spawnInstanceFromEnvironment instead.");
}

export function listInstances(userId: string): SpawnedInstance[] {
  const core = getCoreRuntime();
  return core.listInstances()
    .filter((s) => {
      const sup = supplements.get(s.instanceId);
      return sup?.userId === userId;
    })
    .map((s) => {
      const sup = supplements.get(s.instanceId)!;
      return toSpawnedInstance(s, sup);
    });
}

export function findRunningInstanceByEnvironment(environmentId: string): SpawnedInstance | undefined {
  const core = getCoreRuntime();
  for (const snapshot of core.listInstances()) {
    const sup = supplements.get(snapshot.instanceId);
    if (sup?.environmentId === environmentId && snapshot.status === "running") {
      return toSpawnedInstance(snapshot, sup);
    }
  }
  return undefined;
}

export function findInstanceBySessionId(_sessionId: string): SpawnedInstance | undefined {
  // Session 管理已下沉到 agent，这个方法不再有意义
  return undefined;
}

export function listInstancesByEnvironment(environmentId: string): SpawnedInstance[] {
  const core = getCoreRuntime();
  return core.listInstances()
    .filter((s) => {
      const sup = supplements.get(s.instanceId);
      return sup?.environmentId === environmentId && s.status !== "stopped" && s.status !== "error";
    })
    .map((s) => {
      const sup = supplements.get(s.instanceId)!;
      return toSpawnedInstance(s, sup);
    });
}

export function getRunningInstancesByEnvironment(environmentId: string): SpawnedInstance[] {
  const core = getCoreRuntime();
  return core.listInstances()
    .filter((s) => {
      const sup = supplements.get(s.instanceId);
      return sup?.environmentId === environmentId && s.status === "running";
    })
    .map((s) => {
      const sup = supplements.get(s.instanceId)!;
      return toSpawnedInstance(s, sup);
    });
}

export function getInstance(id: string): SpawnedInstance | undefined {
  const core = getCoreRuntime();
  const snapshot = core.getInstance(id);
  if (!snapshot) return undefined;
  const sup = supplements.get(id);
  if (!sup) return undefined;
  return toSpawnedInstance(snapshot, sup);
}

export async function stopInstance(id: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const sup = supplements.get(id);
  if (!sup) return { ok: false, error: "Instance not found" };
  if (sup.userId !== userId) return { ok: false, error: "Not your instance" };

  const core = getCoreRuntime();
  const snapshot = core.getInstance(id);
  if (!snapshot) return { ok: false, error: "Instance not found" };
  if (snapshot.status === "stopped") return { ok: false, error: "Already stopped" };

  // 关闭 relay 的 local WS
  closeInstanceLocalWs(id);

  try {
    await core.stopInstance(id);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export async function stopAllInstances(): Promise<void> {
  const core = getCoreRuntime();
  for (const snapshot of core.listInstances()) {
    if (snapshot.status !== "stopped") {
      try {
        await core.stopInstance(snapshot.instanceId);
      } catch {}
    }
  }
  supplements.clear();
}

export async function ensureRunning(userId: string, environmentId: string): Promise<EnsureRunningResult> {
  const existing = findRunningInstanceByEnvironment(environmentId);
  if (existing) return { instance: existing, status: "reused" };

  const env = await environmentRepo.getById(environmentId);
  if (!env) throw new Error("Environment not found");

  const runningCount = getRunningInstancesByEnvironment(environmentId).length;
  if (runningCount >= env.maxSessions) {
    throw new Error(`max_sessions_reached: 已达到最大实例数 ${env.maxSessions}`);
  }

  const instance = await spawnInstanceFromEnvironment(userId, environmentId);
  return { instance, status: "spawned" };
}

// 测试辅助
export function setInstanceSpawnForTesting(_fn: any): void {
  // 不再需要，保留空实现以避免测试崩溃
}
```

**重要问题：port/token/pid 的获取**

上面的代码有一个关键问题：core 的 `launchInstance()` 完成后，我们拿不到 port/token/pid（这些是 opencode plugin 内部 `RuntimeInstanceState` 的字段）。有三种解决方案：

**方案 A（推荐）：给 CoreRuntimeFacade 增加生命周期回调**

在 `CreateCoreRuntimeOptions` 中增加 `onInstanceStarted?: (instanceId: string, runtime: EngineRuntime) => void`。orchestrator 在 startInstance 成功后调用这个回调。src 层在回调中读取 opencode runtime 的 getInstanceState 获取 port/token/pid。

**方案 B：给 RuntimeInstanceSnapshot 增加可选的 pluginMetadata**

在 `RuntimeInstanceRecord` 和 `UpdateRuntimeInstanceRecordInput` 中增加 `pluginMetadata?: Record<string, unknown>`。Opencode plugin 的 startInstance 在启动成功后通过 store.update 把 port/token/pid 写入 pluginMetadata。

**方案 C：不修改 core，在 src 层创建共享的 OpencodeRuntime**

src 层创建一个 OpencodeRuntime 实例，用它创建一个 EnginePlugin 适配器，注册到 core。这样 src 层持有 runtime 引用，可以在 launch 后直接调用 getInstanceState。

**我推荐方案 B**，因为它最干净——信息流向是 plugin → store → facade → src，不需要额外的回调或共享引用。

- [ ] **Step 2: 实施方案 B — 给 core 增加 pluginMetadata**

修改 `packages/core/src/types/runtime-instance.ts`：

```typescript
export interface RuntimeInstanceRecord {
  // ... 现有字段不变 ...
  /** Plugin 在启动完成后写入的补充元数据（port, token, pid 等）。 */
  pluginMetadata?: Record<string, unknown>;
}

export type RuntimeInstanceSnapshot = Readonly<RuntimeInstanceRecord>;
```

修改 `packages/core/src/runtime/runtime-instance-store.ts` 的 `UpdateRuntimeInstanceRecordInput`：

```typescript
export interface UpdateRuntimeInstanceRecordInput {
  status?: RuntimeInstanceStatus;
  relayConnected?: boolean;
  errorMessage?: string;
  /** Plugin 通过 store.update 写入的补充元数据。 */
  pluginMetadata?: Record<string, unknown>;
}
```

在 `update` 方法中处理 `pluginMetadata`：

```typescript
// 在 update 方法中增加：
pluginMetadata: input.pluginMetadata ?? current.pluginMetadata,
```

修改 `packages/plugin-opencode/src/runtime/opencode-runtime.ts` 的 `startInstance` 方法，在启动成功后写入 pluginMetadata：

```typescript
// 在 state.status = "running" 之前，增加：
// 注意：opencode runtime 没有 store 引用，需要通过回调或返回值传递。
// 更好的做法：让 orchestrator 在 startInstance 之后读取 runtime 状态并写入 store。
```

**实际上，这变得很复杂。让我换一种更简单的方式。**

- [ ] **Step 3: 换用方案 C — 共享 OpencodeRuntime**

方案 C 的核心思路：src 层自己创建 `OpencodeRuntime` 实例，用它创建一个 `EnginePlugin` 注册到 core。这样 src 层持有 runtime 引用，在 launch 后可以直接调用 `runtime.getInstanceState(instanceId)` 获取 port/token/pid。

重写 `src/services/core-bootstrap.ts`：

```typescript
import { createCoreRuntime, type CoreRuntimeFacade } from "@fenix/core";
import type { EnginePlugin, EngineRuntime } from "@fenix/plugin-sdk";
import { createOpencodeRuntime, type OpencodeRuntime } from "@fenix/opencode";

export interface CoreRuntimeBundle {
  facade: CoreRuntimeFacade;
  opencodeRuntime: OpencodeRuntime;
}

let bundle: CoreRuntimeBundle | null = null;

/**
 * 创建 EnginePlugin 适配器，包装共享的 OpencodeRuntime 实例。
 */
function createSharedOpencodePlugin(runtime: OpencodeRuntime): EnginePlugin {
  return {
    meta: {
      id: "opencode",
      displayName: "OpenCode Engine",
      version: "0.1.0",
    },
    createRuntime(): EngineRuntime {
      return runtime;
    },
  };
}

/**
 * 获取全局 CoreRuntimeBundle 单例。
 */
export function getCoreRuntime(): CoreRuntimeBundle {
  if (!bundle) {
    const opencodeRuntime = createOpencodeRuntime();
    const plugin = createSharedOpencodePlugin(opencodeRuntime);
    const facade = createCoreRuntime({
      plugins: [plugin],
      nodes: [
        {
          id: "local-default",
          mode: "local",
          engineTypes: ["opencode"],
          status: "online",
        },
      ],
    });
    bundle = { facade, opencodeRuntime };
  }
  return bundle;
}

export function resetCoreRuntime(): void {
  bundle = null;
}
```

然后修改 `instance.ts` 中的 `spawnInstanceFromEnvironment`：

```typescript
// 在 launch 成功后：
const { facade, opencodeRuntime } = getCoreRuntime();
const snapshot = await facade.launchInstance({ ... });

// 从共享的 opencode runtime 读取内部状态
const runtimeState = opencodeRuntime.getInstanceState(instanceId);
const port = runtimeState?.port ?? 0;
const token = runtimeState?.token ?? "";
const pid = runtimeState?.pid ?? null;
```

这种方式最简单，不需要修改任何 core 或 plugin-opencode 的代码。

- [ ] **Step 4: 检查 `@fenix/opencode` 是否导出 `OpencodeRuntime` 和 `createOpencodeRuntime`**

查看 `packages/plugin-opencode/src/index.ts`，当前只导出 `createEnginePlugin`。需要增加导出：

```typescript
export { createEnginePlugin } from "./plugin";
export { createOpencodeRuntime } from "./runtime/opencode-runtime";
export type { OpencodeRuntime, OpencodeRuntimeDependencies } from "./runtime/opencode-runtime";
```

- [ ] **Step 5: 更新 `instance.ts` 使用方案 C**

把 Step 1 中的 `instance.ts` 代码中所有 `getCoreRuntime()` 调用改为解构 `{ facade, opencodeRuntime }`。

关键改动点：

```typescript
import { getCoreRuntime } from "./core-bootstrap";

// 在 spawnInstanceFromEnvironment 中：
const { facade, opencodeRuntime } = getCoreRuntime();
const snapshot = await facade.launchInstance({ ... });

const runtimeState = opencodeRuntime.getInstanceState(instanceId);
const port = runtimeState?.port ?? 0;
const token = runtimeState?.token ?? "";
const pid = runtimeState?.pid ?? null;

// 在 listInstances, findRunningInstanceByEnvironment 等查询方法中：
const { facade } = getCoreRuntime();
return facade.listInstances().filter(...).map(...);

// 在 stopInstance 中：
const { facade } = getCoreRuntime();
await facade.stopInstance(id);
```

- [ ] **Step 6: 类型检查并修复错误**

运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -40`

- [ ] **Step 7: 提交**

```bash
git add src/services/core-bootstrap.ts src/services/launch-spec-builder.ts src/services/instance.ts packages/plugin-opencode/src/index.ts
git commit -m "refactor: 重写 instance.ts 为 Core adapter，委托 launch/stop 给 core runtime"
```

---

### Task 4: 更新 Transport 层

**Files:**

- 修改: `src/transport/acp-relay-handler.ts`

relay handler 当前从 `../services/instance` 的 `findRunningInstanceByEnvironment` 和 `findInstanceBySessionId` 查找实例。新代码的接口保持不变，所以 relay handler 只需要处理 `stopInstance` 变成 async 的情况。

- [ ] **Step 1: 检查 relay handler 中对 instance 的使用**

`acp-relay-handler.ts` 第 9 行：

```typescript
import { findRunningInstanceByEnvironment, findInstanceBySessionId } from "../services/instance";
```

这些函数签名在新 adapter 中保持不变，但 `findInstanceBySessionId` 现在始终返回 `undefined`（因为 session 管理已下沉到 agent）。

relay handler 中使用 `instance.port`、`instance.apiKey`（即 token）来建立 WebSocket 连接。这些字段在新 `SpawnedInstance` 中仍然存在。

检查所有使用 `instance.id`、`instance.port`、`instance.apiKey` 的地方，确认兼容性。

- [ ] **Step 2: 如有需要，更新导入或类型**

如果 `stopInstance` 从同步改为异步（返回 Promise），需要更新调用处。

当前 `acp-relay-handler.ts` 中没有直接调用 `stopInstance`，所以无需改动。

确认 `closeInstanceLocalWs` 不受影响——它只操作 `agentLocalWsMap`，不依赖 instance 数据结构。

- [ ] **Step 3: 提交（如有改动）**

如果没有实际改动，跳过此 step。

```bash
git add src/transport/acp-relay-handler.ts
git commit -m "refactor: relay handler 适配 core adapter"
```

---

### Task 5: 更新 Hermes Client

**Files:**

- 修改: `src/services/hermes-client.ts`

- [ ] **Step 1: 更新 hermes-client 中的实例查找**

当前代码：

```typescript
import { findRunningInstanceByEnvironment } from "./instance";
```

接口不变，只需确认 `findRunningInstanceByEnvironment` 的返回值类型兼容。新实现返回的 `SpawnedInstance` 结构与旧版一致，所以无需改动。

但需要确认 `sendToInstanceLocalWs(instance.id, ...)` 仍然有效——`instance.id` 现在是 core 的 instanceId，和 `agentLocalWsMap` 的 key 一致。

- [ ] **Step 2: 提交（如有改动）**

如果没有实际改动，跳过。

---

### Task 6: 更新路由层

**Files:**

- 修改: `src/routes/web/environments.ts`
- 修改: `src/routes/web/instances.ts`

- [ ] **Step 1: 更新 `src/routes/web/instances.ts`**

`stopInstance` 从同步变为异步（返回 `Promise`），需要加 `await`。

当前代码：

```typescript
const result = stopInstance(id, user.id);
```

改为：

```typescript
const result = await stopInstance(id, user.id);
```

同样检查 `spawnInstance` 的调用——它现在会 throw，而不是返回一个 instance。

- [ ] **Step 2: 更新 `src/routes/web/environments.ts`**

检查所有从 `instance.ts` 导入的函数：

```typescript
import {
    spawnInstanceFromEnvironment,
    listInstancesByEnvironment,
    getRunningInstancesByEnvironment,
    ensureRunning,
} from "../../services/instance";
```

`ensureRunning` 现在是 async（之前也是 async），所以不需要改。
`listInstancesByEnvironment` 和 `getRunningInstancesByEnvironment` 保持同步调用（返回 `SpawnedInstance[]`）。

检查 `stopInstance` 在 environments.ts 中是否被调用——当前没有直接调用。

- [ ] **Step 3: 类型检查**

运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -40`

- [ ] **Step 4: 提交**

```bash
git add src/routes/web/environments.ts src/routes/web/instances.ts
git commit -m "refactor: 路由层适配 core adapter 的 async API"
```

---

### Task 7: 更新 src/index.ts 启动和关闭逻辑

**Files:**

- 修改: `src/index.ts`

- [ ] **Step 1: 更新 import 和初始化**

替换旧的 import：

```typescript
// 旧
import { stopAllInstances, spawnInstanceFromEnvironment, findRunningInstanceByEnvironment } from "./services/instance";

// 新
import { stopAllInstances, spawnInstanceFromEnvironment, findRunningInstanceByEnvironment } from "./services/instance";
import { getCoreRuntime } from "./services/core-bootstrap";
```

在启动阶段，调用 `getCoreRuntime()` 确保 core runtime 初始化：

```typescript
// 在 initDb() 之后添加：
getCoreRuntime();
console.log("[RCS] Core runtime initialized (opencode engine + local node)");
```

- [ ] **Step 2: 更新 auto-start 逻辑**

当前 auto-start 逻辑在 `src/index.ts` 第 64-83 行。`spawnInstanceFromEnvironment` 和 `findRunningInstanceByEnvironment` 的签名保持兼容，只需确保 `stopAllInstances` 是 async：

```typescript
// 旧的 graceful shutdown：
stopAllInstances();

// 新的 graceful shutdown：
await stopAllInstances();
```

- [ ] **Step 3: 更新 graceful shutdown**

```typescript
async function gracefulShutdown(signal: string) {
  console.log(`\n[RCS] Received ${signal}, shutting down...`);
  const hermesClient = getHermesClient();
  await hermesClient?.stop();
  closeAllAcpConnections();
  closeAllRelayConnections();
  await stopAllInstances();  // 改为 await
  stopScheduler();
  await pgClient.end();
  process.exit(0);
}
```

- [ ] **Step 4: 提交**

```bash
git add src/index.ts
git commit -m "refactor: 启动时初始化 core runtime，graceful shutdown 使用 async stopAllInstances"
```

---

### Task 8: 更新测试

**Files:**

- 重写: `src/__tests__/instance-service.test.ts`
- 修改: `src/__tests__/instance-routes.test.ts`

- [ ] **Step 1: 重写 `src/__tests__/instance-service.test.ts`**

测试需要 mock `getCoreRuntime()` 返回的 `{ facade, opencodeRuntime }`。核心 mock 结构：

```typescript
import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";

// Mock core-bootstrap
const mockLaunchInstance = mock(async (req: any) => ({
  instanceId: req.instanceId,
  engineType: "opencode",
  nodeId: "local-default",
  status: "running",
  launchSpec: req.launchSpec,
  relayConnected: false,
  errorMessage: undefined,
  createdAt: new Date(),
  updatedAt: new Date(),
}));

const mockStopInstance = mock(async (_id: string) => {});
const mockListInstances = mock(() => []);
const mockGetInstance = mock((_id: string) => null);

const mockGetInstanceState = mock((_id: string) => ({
  instanceId: _id,
  status: "running",
  port: 8888,
  token: "test_token_123",
  pid: 12345,
}));

mock.module("../services/core-bootstrap", () => ({
  getCoreRuntime: mock(() => ({
    facade: {
      launchInstance: mockLaunchInstance,
      stopInstance: mockStopInstance,
      listInstances: mockListInstances,
      getInstance: mockGetInstance,
      getPlugin: mock(() => null),
    },
    opencodeRuntime: {
      getInstanceState: mockGetInstanceState,
    },
  })),
  resetCoreRuntime: mock(() => {}),
}));

// Mock config-pg
mock.module("../services/config-pg", () => ({
  getAgentConfigById: mock(async (_id: string) => ({ name: "test-agent", id: _id })),
  getAgentFullConfig: mock(async () => ({
    agentConfig: { name: "test-agent", model: "openai/gpt-4", prompt: "test prompt" },
    providers: [{ name: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", npm: "@ai-sdk/openai-compatible" }],
    skills: [],
    mcpServers: [],
  })),
}));

// Mock launch-spec-builder
mock.module("../services/launch-spec-builder", () => ({
  buildLaunchSpec: mock(async () => ({
    workspace: "/tmp/test",
    agent: { name: "test-agent" },
    model: { provider: "openai", protocol: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-4" },
    skills: [],
    mcpServers: [],
  })),
}));

// ... 保留 environmentRepo 等 mock ...

const {
  spawnInstanceFromEnvironment,
  listInstances,
  getInstance,
  stopInstance,
  stopAllInstances,
  findRunningInstanceByEnvironment,
} = await import("../services/instance");

describe("CoreInstanceAdapter", () => {
  beforeEach(() => {
    mockLaunchInstance.mockClear();
    mockStopInstance.mockClear();
    mockListInstances.mockClear();
    mockGetInstance.mockClear();
    mockGetInstanceState.mockClear();
  });

  test("spawnInstanceFromEnvironment delegates to core.launchInstance", async () => {
    const inst = await spawnInstanceFromEnvironment("test-user", "env_test");
    expect(mockLaunchInstance).toHaveBeenCalledTimes(1);
    expect(inst.id).toMatch(/^inst_/);
    expect(inst.port).toBe(8888);
    expect(inst.apiKey).toBe("test_token_123");
    expect(inst.status).toBe("running");
  });

  test("stopInstance delegates to core.stopInstance", async () => {
    // 先创建一个实例
    await spawnInstanceFromEnvironment("test-user", "env_stop_test");
    const result = await stopInstance(mockLaunchInstance.mock.calls[0][0].instanceId, "test-user");
    expect(result.ok).toBe(true);
    expect(mockStopInstance).toHaveBeenCalledTimes(1);
  });

  test("stopInstance rejects non-owner", async () => {
    const inst = await spawnInstanceFromEnvironment("owner-user", "env_owner");
    const result = await stopInstance(inst.id, "other-user");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Not your instance");
  });

  test("getInstance returns spawned instance", async () => {
    const inst = await spawnInstanceFromEnvironment("test-user", "env_get");
    // 需要配置 mockGetInstance 返回对应 snapshot
    mockGetInstance.mockReturnValueOnce({
      instanceId: inst.id,
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const found = getInstance(inst.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(inst.id);
  });

  test("findRunningInstanceByEnvironment filters by envId", async () => {
    const inst = await spawnInstanceFromEnvironment("test-user", "env_find");
    // 配置 mockListInstances 返回
    mockListInstances.mockReturnValueOnce([{
      instanceId: inst.id,
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    }]);
    const found = findRunningInstanceByEnvironment("env_find");
    expect(found).toBeDefined();
  });
});
```

- [ ] **Step 2: 更新 `src/__tests__/instance-routes.test.ts`**

`instance-routes.test.ts` 当前是独立的 Elysia app 测试，不直接导入 `instance.ts`，所以改动较小。只需确保 `toResponse` 映射的字段与新的 `SpawnedInstance` 一致。

- [ ] **Step 3: 运行测试**

运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/instance-service.test.ts 2>&1`

修复任何失败的测试。常见问题可能是 mock 没有正确隔离。

- [ ] **Step 4: 运行全量测试**

运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/ 2>&1 | tail -30`

- [ ] **Step 5: 提交**

```bash
git add src/__tests__/instance-service.test.ts src/__tests__/instance-routes.test.ts
git commit -m "test: 更新 instance 测试适配 core adapter"
```

---

### Task 9: 集成验证

**Files:** 无新文件

- [ ] **Step 1: 运行类型检查**

运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1`

确保零错误。

- [ ] **Step 2: 运行全量测试**

运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/ 2>&1 | tail -50`

确保所有测试通过。

- [ ] **Step 3: 运行 packages 测试**

运行: `cd /Users/konghayao/code/pazhou/remote-control-server/packages/core && bun test 2>&1 | tail -20`
运行: `cd /Users/konghayao/code/pazhou/remote-control-server/packages/plugin-opencode && bun test 2>&1 | tail -20`

确保 core 和 plugin-opencode 的测试没有被我们的改动破坏。

- [ ] **Step 4: 启动开发服务器做冒烟测试**

运行: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev 2>&1 &`

等待 3 秒后检查日志，确保：

- Database initialized
- Core runtime initialized
- 无 unhandled rejection

然后停止服务器。

- [ ] **Step 5: 最终提交（如果有遗漏修复）**

```bash
git add -A
git commit -m "fix: 集成验证后的修正"
```

---

## 自审清单

1. **Spec 覆盖**：每个改动区域都有对应 Task（bootstrap、builder、adapter、transport、routes、index、tests）。
2. **无占位符**：所有 step 都包含具体代码或命令。
3. **类型一致性**：
   - `SpawnedInstance` 接口在新旧代码中保持一致
   - `getCoreRuntime()` 返回 `CoreRuntimeBundle`，包含 `facade` 和 `opencodeRuntime`
   - `buildLaunchSpec` 输入输出类型明确定义
   - `stopInstance` 从同步改为 async，所有调用处需要 await
