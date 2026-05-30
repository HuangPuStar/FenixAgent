# Workflow Agent 节点重新设计 — 基于 Environment 的智能体复用

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 workflow Agent 节点从 agentConfig name 引用改为 Environment 引用，实现完整的智能体复用：按需启动环境实例、收集完整会话流、workflow 结束时统一销毁。

**Architecture:** Agent 节点的 `agent` 字段改为 Environment name（运行时按 name 查 Environment 表获取 envId）。执行时通过 Environment 的 `ensureRunning` 机制按需启动实例，通过 ACP Transport 发送 prompt 并收集完整会话流（assistant/tool_call/tool_result），简化后作为 `stdout` 传递给下游。workflow 结束时由 RCS 服务层统一销毁期间启动的实例。

**Tech Stack:** TypeScript、`@fenix/workflow-engine`（DAG 类型 + 执行器 + Transport 接口）、ACP WebSocket、Elysia、React 19 + TanStack Router

---

## 设计决策摘要

| 决策 | 结论 |
|------|------|
| Agent 节点引用 | Environment name（非 agentConfig） |
| 实例生命周期 | 按需启动（ensureRunning），workflow 结束时统一销毁 |
| YAML 定义 | `agent: env-name` + `prompt` + 可选 `output_messages`/`timeout`/`retry` |
| 去掉的字段 | `skill`、`model`、`temperature`、`steps` |
| 上游数据传递 | prompt 模板表达式（现有机制，不改动） |
| 输出格式 | `stdout` = 简化文本；`messages` = 完整会话流 |
| `output_messages` | 节点级参数（默认 0），控制回传给下游的最后 N 条原始消息 |
| 销毁责任方 | RCS 服务层（引擎层暴露启动的环境 ID 列表） |

## 文件变更清单

### `@fenix/workflow-engine` 包（引擎层）

| 文件 | 变更 | 职责 |
|------|------|------|
| `packages/workflow-engine/src/types/dag.ts` | 修改 | `AgentNodeDef` 删除 skill/model/temperature/steps，新增 `output_messages` |
| `packages/workflow-engine/src/transport/transport.ts` | 修改 | `AgentRequest` 精简（删除 agentConfig 相关字段），`AgentResponse` 新增 `messages` |
| `packages/workflow-engine/src/executor/agent-executor.ts` | 重写 | 删除 `AgentResolvedConfig`/`resolveAndMergeConfig`，精简为纯 Transport 调用 + 会话流收集 |
| `packages/workflow-engine/src/parser/yaml-parser.ts` | 可能修改 | 如果 YAML 解析对 agent 节点有特殊处理 |
| `packages/workflow-engine/src/engine/workflow-engine.ts` | 修改 | `WorkflowEngineOptions` 删除 `resolveAgentConfig`，`runAsync` 返回新增 `spawnedEnvIds` |
| `packages/workflow-engine/src/scheduler/dag-scheduler.ts` | 修改 | `SchedulerContext` 新增 `spawnedEnvIds` 收集器 |

### RCS 服务层

| 文件 | 变更 | 职责 |
|------|------|------|
| `src/services/workflow/acp-transport.ts` | 重写 | Transport connect 改为接收 envId（不再需要 name 解析），execute 收集完整会话流 |
| `src/services/workflow/index.ts` | 重写 | 删除 `AgentNameResolver`/`createAgentConfigResolver`，注入 `ensureEnvironment` 回调，run 后统一销毁 |
| `src/routes/web/workflow-engine.ts` | 修改 | `run`/`runAsync` 端点返回 `spawnedEnvIds`，finally 中调用销毁 |

### 前端

| 文件 | 变更 | 职责 |
|------|------|------|
| `web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts` | 修改 | `agentList` 改为拉取 Environment 列表（非 agentConfig） |
| `web/src/pages/workflow/components/NodeConfigPanel.tsx` | 修改 | Agent 节点配置：环境下拉 + prompt + output_messages，删除 skill/model/temperature/steps |
| `web/src/pages/workflow/yaml-utils.ts` | 修改 | flowToYaml/yamlToFlow 适配新的 agent 节点字段 |
| `web/src/pages/workflow/components/NodeOutputView.tsx` | 可能修改 | 支持 messages 列表渲染 |

---

## Task 1: 更新 DAG 类型定义

**Files:**
- Modify: `packages/workflow-engine/src/types/dag.ts`

- [ ] **Step 1: 更新 AgentNodeDef**

将 `AgentNodeDef` 从：

```typescript
/** Agent 节点 — 调用 AI Agent */
export interface AgentNodeDef extends BaseNodeDef {
  type: "agent";
  prompt: string;
  agent?: string;
  skill?: string;
  /** 节点级模型覆盖（覆盖 agent config 的 model） */
  model?: string;
  /** 节点级温度覆盖 */
  temperature?: number;
  /** 节点级最大步数覆盖 */
  steps?: number;
  retry?: RetryConfig;
}
```

改为：

```typescript
/** Agent 节点 — 复用在线 Environment */
export interface AgentNodeDef extends BaseNodeDef {
  type: "agent";
  /** 环境名称（对应 Environment.name） */
  agent: string;
  /** 发送给 agent 的 prompt */
  prompt: string;
  /** 回传给下游的最后 N 条原始消息（默认 0 = 只传简化 stdout） */
  output_messages?: number;
  retry?: RetryConfig;
}
```

关键变更：
- `agent` 从 optional 变为 required（必须指定环境）
- 删除 `skill`、`model`、`temperature`、`steps`
- 新增 `output_messages`

- [ ] **Step 2: 运行类型检查确认影响范围**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit 2>&1 | grep -c error`
Expected: 会有类型错误，用于确认下游文件列表

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/types/dag.ts
git commit -m "refactor: AgentNodeDef 改为引用 Environment name，删除覆盖字段，新增 output_messages"
```

---

## Task 2: 更新 Transport 接口

**Files:**
- Modify: `packages/workflow-engine/src/transport/transport.ts`

- [ ] **Step 1: 精简 AgentRequest，扩展 AgentResponse**

将 `AgentRequest` 改为：

```typescript
/** Agent 请求参数 */
export interface AgentRequest {
  prompt: string;
  signal?: AbortSignal;
}

/** 会话流中的单条消息 */
export interface AgentMessage {
  role: "assistant" | "tool_call" | "tool_result" | "user";
  content: string;
  /** tool_call / tool_result 的工具名 */
  tool_name?: string;
}

/** Agent 响应结果 */
export interface AgentResponse {
  /** 简化后的文本（去掉 tool_call/tool_result，拼接 assistant content） */
  stdout: string;
  exit_code: number;
  tokens?: { input: number; output: number };
  model?: string;
  latency_ms?: number;
  /** 完整会话流 */
  messages: AgentMessage[];
}
```

关键变更：
- `AgentRequest` 删除 `agent`/`skill`/`model`/`temperature`/`steps`/`permission`/`knowledge`/`system_prompt`/`skills`/`cwd`（这些由环境自身的 agentConfig 决定）
- `AgentResponse` 新增 `messages: AgentMessage[]`
- 新增 `AgentMessage` 类型

- [ ] **Step 2: Commit**

```bash
git add packages/workflow-engine/src/transport/transport.ts
git commit -m "refactor: 精简 AgentRequest，AgentResponse 新增 messages 会话流"
```

---

## Task 3: 重写 AgentExecutor

**Files:**
- Modify: `packages/workflow-engine/src/executor/agent-executor.ts`
- Test: `packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts`

- [ ] **Step 1: 重写 AgentExecutor**

核心变更：
- 删除 `AgentResolvedConfig` 接口和 `AgentExecutorOptions.resolveAgentConfig`
- 删除 `resolveAndMergeConfig` 方法
- 构造函数只接收 `Transport`（不再需要 options）
- `executeOnce` 只传 `prompt` 和 `signal`
- 从 `AgentResponse.messages` 收集完整会话流
- 按 `output_messages` 参数决定传递给下游的内容

完整代码：

```typescript
/**
 * Agent 节点执行器 — 通过 Transport 接口与 Environment 的 Agent 通信。
 *
 * 职责：
 * - 类型守卫：仅处理 'agent' 节点
 * - Transport 连接：connect(envId) → execute(prompt) → 收集会话流
 * - 输出：简化 stdout + 完整 messages
 * - 重试：默认 2 次指数退避
 * - 事件发射：node.started / node.completed / node.failed / node.retrying
 */

import { nanoid } from "nanoid";
import type { NodeExecutionContext, NodeExecutor } from "../scheduler/dag-scheduler";
import type { AgentRequest, AgentResponse, Transport } from "../transport/transport";
import type { AgentNodeDef, NodeDef } from "../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../types/errors";
import type { NodeOutput } from "../types/execution";

// ---------- 常量 ----------

const DEFAULT_RETRY_DELAY_MS = 1000;

// ---------- AgentExecutor ----------

/** Agent 节点执行器 */
export class AgentExecutor implements NodeExecutor {
  constructor(private transport: Transport) {}

  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== "agent") {
      throw new WorkflowError(
        `AgentExecutor only handles 'agent' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const agentNode = node as AgentNodeDef;
    const resolvedPrompt = (ctx.resolvedInputs.prompt as string) ?? agentNode.prompt;
    const resolvedAgent = (ctx.resolvedInputs.agent as string) ?? agentNode.agent;

    const retryConfig = agentNode.retry ?? { count: 2, delay: DEFAULT_RETRY_DELAY_MS, backoff: "exponential" };
    const maxAttempts = (retryConfig.count ?? 2) + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const baseDelay = retryConfig.delay ?? DEFAULT_RETRY_DELAY_MS;
        const multiplier = retryConfig.backoff === "exponential" ? 2 ** (attempt - 1) : 1;
        const jitter = 0.5 + Math.random() * 0.5;
        const delay = Math.round(baseDelay * multiplier * jitter);

        await this.emitEvent(ctx, "node.retrying", agentNode, {
          attempt: attempt + 1,
          max_attempts: maxAttempts,
          next_delay_ms: delay,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        return await this.executeOnce(agentNode, ctx, resolvedPrompt, resolvedAgent);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof DOMException && error.name === "AbortError") {
          throw new WorkflowError("Node cancelled", WorkflowErrorCode.DAG_CANCELLED, { node_id: node.id });
        }

        if (attempt === maxAttempts - 1) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new WorkflowError("All retry attempts exhausted", WorkflowErrorCode.NODE_FAILED);
  }

  /** 单次执行：connect → execute → 收集会话流 */
  private async executeOnce(
    node: AgentNodeDef,
    ctx: NodeExecutionContext,
    resolvedPrompt: string,
    resolvedAgent: string,
  ): Promise<NodeOutput> {
    // 发射 node.started 事件
    await this.emitEvent(ctx, "node.started", node, {
      inputs: ctx.resolvedInputs,
      agent: resolvedAgent,
    });

    // 连接 Transport（resolvedAgent 是环境名称，Transport 层负责解析为 envId）
    const session = await this.transport.connect(resolvedAgent);

    // 构建请求
    const request: AgentRequest = {
      prompt: resolvedPrompt,
      signal: ctx.signal,
    };

    // 执行请求
    const response = await session.execute(request);

    const outputSize = Buffer.byteLength(response.stdout);

    // 非零退出码 → 失败
    if (response.exit_code !== 0) {
      const errorMessage = response.stdout
        ? `Agent exited with code ${response.exit_code}: ${response.stdout.slice(0, 500)}`
        : `Agent exited with code ${response.exit_code}`;
      await this.emitEvent(ctx, "node.failed", node, {
        error: errorMessage,
        exit_code: response.exit_code,
        stdout: response.stdout,
      });
      throw new WorkflowError(errorMessage, WorkflowErrorCode.NODE_FAILED, {
        node_id: node.id,
        exit_code: response.exit_code,
        stdout: response.stdout,
      });
    }

    // 构建 stdout：简化文本
    const simplifiedStdout = response.stdout;

    // 构建 output_messages：根据 output_messages 参数决定传递多少原始消息
    const outputMessages = node.output_messages ?? 0;
    const json = {
      simplified: simplifiedStdout,
      ...(response.messages.length > 0 ? { messages: response.messages } : {}),
      ...(outputMessages > 0 && response.messages.length > 0
        ? { last_messages: response.messages.slice(-outputMessages) }
        : {}),
    };

    // 尝试解析 stdout 为 JSON
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(simplifiedStdout);
    } catch {
      // stdout 不是合法 JSON
    }

    // 发射 node.completed 事件
    await this.emitEvent(ctx, "node.completed", node, {
      exit_code: response.exit_code,
      output_size: outputSize,
      message_count: response.messages.length,
      tokens: response.tokens,
      model: response.model,
      latency_ms: response.latency_ms,
    });

    return {
      stdout: simplifiedStdout,
      json: parsedJson ?? json,
      exit_code: response.exit_code,
      size: outputSize,
    };
  }

  /** 发射事件到 storage */
  private async emitEvent(
    ctx: NodeExecutionContext,
    type: import("../types/execution").EventType,
    node: AgentNodeDef,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const event: import("../types/execution").DAGEvent = {
      event_id: `evt_${nanoid(10)}`,
      run_id: ctx.runId,
      node_id: node.id,
      node_type: node.type,
      timestamp: new Date().toISOString(),
      type,
      ...(metadata ? { metadata } : {}),
    };
    await ctx.storage.appendEvent(event);
  }
}
```

- [ ] **Step 2: 更新 workflow-engine.ts 中 buildRegistry 的 AgentExecutor 构造**

在 `packages/workflow-engine/src/engine/workflow-engine.ts` 的 `buildRegistry` 函数中，将：

```typescript
registry.register(
  "agent",
  new AgentExecutor(transport, {
    resolveAgentConfig: options.resolveAgentConfig,
  }),
);
```

改为：

```typescript
registry.register("agent", new AgentExecutor(transport));
```

同时删除 `WorkflowEngineOptions` 中的 `resolveAgentConfig` 字段。

- [ ] **Step 3: 更新测试**

更新 `packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts`：
- 删除所有 `resolveAgentConfig` 相关测试
- 删除 `model`/`temperature`/`steps`/`permission`/`knowledge` 相关断言
- 新增 `output_messages` 参数测试
- 新增 `messages` 会话流收集测试
- `agent` 字段从 optional 改为 required

- [ ] **Step 4: 运行测试**

Run: `bun test packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/executor/agent-executor.ts packages/workflow-engine/src/engine/workflow-engine.ts packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts
git commit -m "refactor: 重写 AgentExecutor — 删除 agentConfig 解析，精简为 Transport 调用 + 会话流收集"
```

---

## Task 4: 重写 ACP Transport — 收集完整会话流

**Files:**
- Modify: `src/services/workflow/acp-transport.ts`

- [ ] **Step 1: 重写 ACP Transport**

核心变更：
- 删除 `AgentNameResolver` 机制（不再需要 agentConfig name → envId 映射）
- `connect()` 接收 Environment name，通过注入的回调解析为 envId
- `execute()` 收集完整会话流（session_update 中的 assistant/tool_call/tool_result 消息）
- 新增 `AgentMessage` 的收集逻辑
- 简化 `AgentRequest` 构造（只传 prompt）

注入回调设计：

```typescript
/** Environment name → envId + ensureRunning 的回调 */
export interface EnvironmentResolver {
  /** 解析环境名称为 envId，如果环境不在线则自动启动 */
  resolve(name: string): Promise<{ envId: string; started: boolean }>;
}
```

`AcpAgentSession.execute()` 的消息收集逻辑：

```typescript
// session_update 消息中需要收集的消息类型
switch (message.role) {
  case "assistant":
    chunks.push(message.content);
    collectedMessages.push({
      role: "assistant",
      content: message.content,
    });
    break;
  case "tool_call":
    collectedMessages.push({
      role: "tool_call",
      content: message.content ?? "",
      tool_name: message.tool_name,
    });
    break;
  case "tool_result":
    collectedMessages.push({
      role: "tool_result",
      content: message.content ?? "",
      tool_name: message.tool_name,
    });
    break;
}
```

`prompt_complete` 时：

```typescript
resolve({
  stdout: chunks.join(""),  // 简化文本：只有 assistant content
  exit_code: 0,
  messages: collectedMessages,
  tokens: metadata?.tokens,
  model: metadata?.model,
  latency_ms: latencyMs,
});
```

- [ ] **Step 2: Commit**

```bash
git add src/services/workflow/acp-transport.ts
git commit -m "refactor: 重写 ACP Transport — Environment name 解析 + 完整会话流收集"
```

---

## Task 5: 重写 RCS 服务层 — 注入 Environment 回调 + 统一销毁

**Files:**
- Modify: `src/services/workflow/index.ts`

- [ ] **Step 1: 重写 workflow/index.ts**

核心变更：
- 删除 `createAgentConfigResolver`、`createAgentNameResolverFn`、`setAgentNameResolver`
- 注入 `EnvironmentResolver` 到 ACP Transport（Environment name → ensureRunning → envId）
- `WorkflowEngineOptions` 不再需要 `resolveAgentConfig`
- `runAsync` 返回的 result 新增 `spawnedEnvIds: string[]`
- 引擎层通过回调通知服务层"本次启动了哪些环境"
- 服务层在 workflow 结束时统一销毁

实现方案：

```typescript
// 注入到 AcpTransport 的环境解析回调
const envResolver: EnvironmentResolver = {
  async resolve(name: string) {
    // 1. 按 name 查 Environment
    const [envRow] = await db
      .select({ id: environment.id })
      .from(environment)
      .where(and(eq(environment.name, name), eq(environment.organizationId, organizationId)))
      .limit(1);
    if (!envRow) throw new Error(`Environment '${name}' not found`);

    // 2. 检查是否已有在线 ACP 连接
    const conn = findAcpConnectionByAgentId(envRow.id);
    if (conn) return { envId: envRow.id, started: false };

    // 3. 调用 ensureRunning 启动实例
    const { instance } = await ensureRunning(systemUserId, envRow.id);
    // 记录到 spawnedEnvIds 供后续销毁
    spawnedEnvIds.add(envRow.id);
    return { envId: envRow.id, started: true };
  },
};
```

销毁逻辑：

```typescript
/** workflow 结束后销毁期间启动的实例 */
async function cleanupSpawnedEnvironments(envIds: Set<string>): Promise<void> {
  for (const envId of envIds) {
    try {
      await stopEnvironmentInstances(envId);
    } catch (err) {
      console.error(`[Workflow] Failed to stop environment ${envId}:`, err);
    }
  }
}
```

- [ ] **Step 2: 更新路由层 — runAsync 调用后注册销毁**

在 `src/routes/web/workflow-engine.ts`（或相关路由文件）中，调用 `engine.runAsync()` 后，在 result Promise 的 finally 中调用 `cleanupSpawnedEnvironments`。

- [ ] **Step 3: 运行后端测试**

Run: `bun test src/__tests__/ 2>&1 | tail -10`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/workflow/index.ts src/routes/web/workflow-engine.ts
git commit -m "refactor: workflow 服务层注入 Environment 回调 + workflow 结束统一销毁实例"
```

---

## Task 6: 更新 Scheduler — 收集 spawnedEnvIds

**Files:**
- Modify: `packages/workflow-engine/src/scheduler/dag-scheduler.ts`

- [ ] **Step 1: SchedulerContext 新增 spawnedEnvIds**

在 `SchedulerContext` 中新增：

```typescript
/** 收集本次运行启动的 Environment ID（由 Transport 层通过回调注入） */
spawnedEnvIds?: Set<string>;
```

在 `DAGRunResult` 中新增：

```typescript
/** 本次运行期间启动的 Environment ID 列表 */
spawnedEnvIds: string[];
```

在 `run()` 的 finally 中，从 `this.ctx.spawnedEnvIds` 收集并放入 result。

- [ ] **Step 2: 更新 workflow-engine.ts 的 runAsync — 传递 spawnedEnvIds**

在 `runAsync` 中构建 `SchedulerContext` 时传入 `spawnedEnvIds: new Set<string>()`，从 result 中取回。

- [ ] **Step 3: 运行引擎测试**

Run: `bun test packages/workflow-engine/src/__tests__/`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/scheduler/dag-scheduler.ts packages/workflow-engine/src/engine/workflow-engine.ts
git commit -m "feat: DAGRunResult 新增 spawnedEnvIds，支持 workflow 结束后统一销毁"
```

---

## Task 7: 更新前端 — 环境下拉 + 配置面板

**Files:**
- Modify: `web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts`
- Modify: `web/src/pages/workflow/components/NodeConfigPanel.tsx`
- Modify: `web/src/pages/workflow/yaml-utils.ts`

- [ ] **Step 1: useWorkflowMetaAgent — 改为拉取 Environment 列表**

将 `agentApi.list()` 改为调用 Environment 列表 API。需要确认前端 SDK 中有 `EnvironmentApi.list()` 或类似方法。

```typescript
// 替换原来的 agentApi.list()
import { environmentApi } from "@/src/api/sdk";

useEffect(() => {
  environmentApi
    .list()
    .then((result) => {
      if (result.ok && Array.isArray(result.data)) {
        setAgentList(
          result.data.map((env) => ({
            name: env.name,
            model: null, // environment 没有 model 字段
            description: env.description ?? null,
          })),
        );
      }
    })
    .catch((err: unknown) => console.error("Failed to load environment list:", err));
}, []);
```

- [ ] **Step 2: NodeConfigPanel — 更新 agent 节点配置**

将 agent 节点配置区改为：
- **环境名称**：下拉选择（从 Environment 列表），required
- **Prompt**：textarea，required
- **Output Messages**：number input，可选，默认 0
- 删除：skill、model、temperature、steps 的所有输入

替换原来 333-457 行的 `nodeType === "agent"` 区块：

```tsx
{nodeType === "agent" && (
  <>
    <div className="wf-prop-field">
      <label>{t("editor.agent_env")}</label>
      <select
        value={String(sd?.agent ?? "")}
        onChange={(e) => updateNodeData({ agent: e.target.value || undefined })}
        disabled={readOnly}
      >
        <option value="">{t("editor.agent_select_env")}</option>
        {agentList.map((a) => (
          <option key={a.name} value={a.name}>
            {a.name}
            {a.description ? ` - ${a.description}` : ""}
          </option>
        ))}
      </select>
    </div>
    <div className="wf-prop-field">
      <label>{t("editor.agent_prompt")}</label>
      <textarea
        value={String(sd?.prompt ?? "")}
        onChange={(e) => updateNodeData({ prompt: e.target.value })}
        placeholder={t("editor.agent_prompt_placeholder")}
        rows={4}
        readOnly={readOnly}
      />
    </div>
    <div className="wf-prop-field">
      <label>{t("editor.agent_output_messages")}</label>
      <input
        type="number"
        min="0"
        max="100"
        value={sd?.output_messages != null ? String(sd.output_messages) : ""}
        onChange={(e) =>
          updateNodeData({ output_messages: e.target.value ? Number(e.target.value) : undefined })
        }
        placeholder="0"
        readOnly={readOnly}
      />
    </div>
  </>
)}
```

- [ ] **Step 3: yaml-utils.ts — 适配新字段**

在 `flowToYaml` 和 `yamlToFlow` 中，agent 节点只保留 `agent`、`prompt`、`output_messages` 字段，删除 `skill`、`model`、`temperature`、`steps` 的序列化/反序列化。

- [ ] **Step 4: 添加 i18n 翻译键**

在 `web/src/i18n/locales/en/workflows.json` 和 `web/src/i18n/locales/zh/workflows.json` 中添加新的翻译键：

```json
{
  "editor.agent_env": "Environment" / "环境",
  "editor.agent_select_env": "Select environment..." / "选择环境...",
  "editor.agent_output_messages": "Output Messages" / "输出消息数"
}
```

- [ ] **Step 5: 运行前端测试**

Run: `bun test web/src/__tests__/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/workflow/hooks/useWorkflowMetaAgent.ts web/src/pages/workflow/components/NodeConfigPanel.tsx web/src/pages/workflow/yaml-utils.ts web/src/i18n/
git commit -m "feat: 前端 agent 节点改为环境下拉 + prompt + output_messages"
```

---

## Task 8: 更新 DAG Scheduler 的 resolveNodeInputs

**Files:**
- Modify: `packages/workflow-engine/src/scheduler/dag-scheduler.ts`

- [ ] **Step 1: 更新 agent 节点的 inputs 解析**

在 `resolveNodeInputs` 方法的 `case "agent"` 中，删除 `skill`、`model`、`temperature`、`steps` 的解析，只保留 `prompt` 和 `agent`：

```typescript
case "agent": {
  resolved.prompt = resolveTemplate(node.prompt, evalContext);
  if (node.agent) resolved.agent = resolveTemplate(node.agent, evalContext);
  break;
}
```

- [ ] **Step 2: 运行引擎测试**

Run: `bun test packages/workflow-engine/src/__tests__/`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/scheduler/dag-scheduler.ts
git commit -m "refactor: agent 节点 inputs 解析只保留 prompt 和 agent"
```

---

## Task 9: 集成测试 + 清理旧代码

**Files:**
- Various cleanup across all modified files

- [ ] **Step 1: 删除残留的 agentConfig 相关导入和引用**

搜索所有 `resolveAgentConfig`、`AgentResolvedConfig`、`AgentNameResolver`、`setAgentNameResolver` 引用，确认全部清理。

Run: `grep -rn "resolveAgentConfig\|AgentResolvedConfig\|AgentNameResolver\|setAgentNameResolver" packages/ src/ web/`

- [ ] **Step 2: 运行全量测试**

Run: `bun test packages/workflow-engine/src/__tests__/ src/__tests__/ web/src/__tests__/`
Expected: 全部 PASS

- [ ] **Step 3: 运行 precheck**

Run: `bun run precheck`
Expected: PASS（tsc + biome check 无错误）

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: 清理 Agent 节点旧 agentConfig 引用，全量测试通过"
```

---

## Self-Review

### Spec Coverage Check

| 设计决策 | 对应 Task |
|---------|----------|
| Agent 节点引用 Environment name | Task 1 (dag.ts), Task 6, Task 7 |
| 按需启动 + workflow 结束销毁 | Task 4, Task 5, Task 6 |
| YAML 去掉 skill/model/temperature/steps | Task 1, Task 8 |
| 新增 output_messages | Task 1, Task 3 |
| prompt 模板不变 | 无需改动（现有机制） |
| 简化 stdout + 完整 messages | Task 2, Task 3, Task 4 |
| 销毁责任在 RCS 服务层 | Task 5 |

### Placeholder Scan

无 TBD/TODO/占位符。所有步骤包含完整代码或明确的搜索/运行命令。

### Type Consistency

- `AgentNodeDef.agent`: `string`（required）— Task 1 定义，Task 3/7/8 使用
- `AgentNodeDef.output_messages`: `number | undefined` — Task 1 定义，Task 3 使用
- `AgentRequest`: `{ prompt, signal }` — Task 2 定义，Task 3/4 使用
- `AgentResponse.messages`: `AgentMessage[]` — Task 2 定义，Task 3/4 使用
- `EnvironmentResolver.resolve()`: 返回 `{ envId, started }` — Task 4/5 使用
