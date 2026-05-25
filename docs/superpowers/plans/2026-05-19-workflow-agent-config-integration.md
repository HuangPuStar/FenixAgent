# Workflow Agent 节点与智能体配置联动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作流的 Agent 节点能引用智能体配置（agentConfig），并支持节点级覆盖 model/temperature/steps，前端提供下拉选择器。

**Architecture:** 方案 A — 通过 `resolveAgentConfig` 回调注入 AgentExecutor。引擎构造时传入回调函数，AgentExecutor 执行时调用它获取 agent config 并合并节点级覆盖字段。回调由宿主服务层（`src/services/workflow/index.ts`）实现，查询 `agentConfig` 表。

**Tech Stack:** TypeScript, Drizzle ORM, React, @xyflow/react

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/workflow-engine/src/types/dag.ts` | `AgentNodeDef` 增加 `model?` `temperature?` `steps?` 字段 |
| `packages/workflow-engine/src/transport/transport.ts` | `AgentRequest` 增加 `model?` `temperature?` `steps?` `permission?` `knowledge?` 字段 |
| `packages/workflow-engine/src/executor/agent-executor.ts` | 接收 `resolveAgentConfig` 回调，合并配置，透传到 Transport |
| `packages/workflow-engine/src/engine/workflow-engine.ts` | `WorkflowEngineOptions` 增加 `resolveAgentConfig?`，传入 AgentExecutor |
| `packages/workflow-engine/src/parser/yaml-parser.ts` | 解析 agent 节点的 model/temperature/steps 字段 |
| `src/services/workflow/index.ts` | 实现 `resolveAgentConfig` 回调（查询 agentConfig 表） |
| `web/src/pages/workflow/WorkflowEditor.tsx` | agent 名称改为 Select 下拉，添加覆盖配置折叠面板 |

---

### Task 1: 扩展 AgentNodeDef 类型定义

**Files:**
- Modify: `packages/workflow-engine/src/types/dag.ts:39-45`

- [ ] **Step 1: 在 `AgentNodeDef` 中增加可选覆盖字段**

```typescript
/** Agent 节点 — 调用 AI Agent */
export interface AgentNodeDef extends BaseNodeDef {
  type: 'agent';
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

- [ ] **Step 2: 运行类型检查确认无破坏性变更**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -20`
Expected: 无新增类型错误（新增字段均为可选）

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/types/dag.ts
git commit -m "feat: AgentNodeDef 增加 model/temperature/steps 可选覆盖字段"
```

---

### Task 2: 扩展 AgentRequest 透传配置

**Files:**
- Modify: `packages/workflow-engine/src/transport/transport.ts:9-15`

- [ ] **Step 1: 在 `AgentRequest` 中增加配置字段**

```typescript
/** Agent 请求参数 */
export interface AgentRequest {
  prompt: string;
  agent?: string;
  skill?: string;
  cwd?: string;
  signal?: AbortSignal;
  /** 模型（来自 agent config 或节点覆盖） */
  model?: string;
  /** 温度（来自 agent config 或节点覆盖） */
  temperature?: number;
  /** 最大步数（来自 agent config 或节点覆盖） */
  steps?: number;
  /** 权限配置（来自 agent config） */
  permission?: unknown;
  /** 知识库配置（来自 agent config） */
  knowledge?: unknown;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/workflow-engine/src/transport/transport.ts
git commit -m "feat: AgentRequest 增加配置透传字段（model/temperature/steps/permission/knowledge）"
```

---

### Task 3: AgentExecutor 接收 resolveAgentConfig 回调并合并配置

**Files:**
- Modify: `packages/workflow-engine/src/executor/agent-executor.ts`

- [ ] **Step 1: 写失败测试 — 验证 resolveAgentConfig 被调用且配置合并正确**

在 `packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts` 末尾追加：

```typescript
// ========== Agent Config 合并测试 ==========

describe('AgentExecutor config merging', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
    transport.setResponse('my-agent', { stdout: 'ok', exit_code: 0 });
  });

  test('resolveAgentConfig 被调用且 model 合并到 request', async () => {
    let resolvedName = '';
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async (name: string) => {
        resolvedName = name;
        return { model: 'claude-sonnet-4-6', steps: 20, temperature: 0.7, permission: { bash: 'allow' }, knowledge: null };
      },
    });

    const ctx = makeCtx();
    const node = agentNode('test', { agent: 'my-agent' });
    await executor.execute(node, ctx);

    expect(resolvedName).toBe('my-agent');
    const lastReq = transport.getLastRequest('my-agent');
    expect(lastReq?.model).toBe('claude-sonnet-4-6');
    expect(lastReq?.temperature).toBe(0.7);
    expect(lastReq?.steps).toBe(20);
    expect(lastReq?.permission).toEqual({ bash: 'allow' });
  });

  test('节点级 model 覆盖 agent config 的 model', async () => {
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => {
        return { model: 'gpt-4', steps: 10, temperature: 0.5, permission: null, knowledge: null };
      },
    });

    const ctx = makeCtx();
    const node = agentNode('test', { agent: 'my-agent', model: 'claude-opus-4-7' });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest('my-agent');
    expect(lastReq?.model).toBe('claude-opus-4-7'); // 节点级覆盖生效
    expect(lastReq?.temperature).toBe(0.5); // config 值保留
    expect(lastReq?.steps).toBe(10); // config 值保留
  });

  test('节点级 temperature 覆盖 agent config', async () => {
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => {
        return { model: 'gpt-4', steps: 10, temperature: 0.5, permission: null, knowledge: null };
      },
    });

    const ctx = makeCtx();
    const node = agentNode('test', { agent: 'my-agent', temperature: 0.1 });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest('my-agent');
    expect(lastReq?.temperature).toBe(0.1); // 节点级覆盖
    expect(lastReq?.model).toBe('gpt-4'); // config 值保留
  });

  test('agent 字段为空时 resolveAgentConfig 不被调用', async () => {
    transport.setResponse('default', { stdout: 'ok', exit_code: 0 });
    let called = false;
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => {
        called = true;
        return { model: null, steps: null, temperature: null, permission: null, knowledge: null };
      },
    });

    const ctx = makeCtx();
    const node = agentNode('test'); // 无 agent 字段
    await executor.execute(node, ctx);

    expect(called).toBe(false);
    const lastReq = transport.getLastRequest('default');
    expect(lastReq?.model).toBeUndefined();
  });

  test('resolveAgentConfig 返回 null 时使用节点字段', async () => {
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => null, // agent 不存在
    });

    const ctx = makeCtx();
    const node = agentNode('test', { agent: 'my-agent', model: 'fallback-model' });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest('my-agent');
    expect(lastReq?.model).toBe('fallback-model');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts 2>&1 | tail -20`
Expected: FAIL — `AgentExecutor` constructor 和 options 类型不存在

- [ ] **Step 3: 定义 `AgentResolvedConfig` 类型和 `AgentExecutorOptions` 接口，修改 `AgentExecutor` 构造函数和 `executeOnce`**

在 `packages/workflow-engine/src/executor/agent-executor.ts` 顶部，Transport import 后添加类型定义：

```typescript
/** 从宿主层获取的 agent 配置 */
export interface AgentResolvedConfig {
  model: string | null;
  steps: number | null;
  temperature: number | null;
  permission: unknown;
  knowledge: unknown;
}

/** AgentExecutor 构造选项 */
export interface AgentExecutorOptions {
  /** 注入的 agent 配置解析回调（方案 A） */
  resolveAgentConfig?: (agentName: string) => Promise<AgentResolvedConfig | null>;
}
```

修改构造函数：

```typescript
export class AgentExecutor implements NodeExecutor {
  constructor(
    private transport: Transport,
    private options?: AgentExecutorOptions,
  ) {}
```

在 `execute` 方法中，解析模板后、重试循环前，添加配置合并逻辑。将 `executeOnce` 签名改为接收合并后的配置：

```typescript
  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<NodeOutput> {
    if (node.type !== 'agent') {
      throw new WorkflowError(
        `AgentExecutor only handles 'agent' nodes, got '${node.type}'`,
        WorkflowErrorCode.NODE_FAILED,
      );
    }

    const agentNode = node as AgentNodeDef;
    const evalContext = this.buildEvalContext(ctx);

    // 解析模板
    const resolvedPrompt = resolveTemplate(agentNode.prompt, evalContext);
    const resolvedAgent = agentNode.agent ? resolveTemplate(agentNode.agent, evalContext) : undefined;
    const resolvedSkill = agentNode.skill ? resolveTemplate(agentNode.skill, evalContext) : undefined;

    // 合并 agent config + 节点级覆盖
    const mergedConfig = await this.resolveAndMergeConfig(agentNode);

    // 重试配置：默认 2 次（ShellNode 默认 0 次）
    const retryConfig = agentNode.retry ?? { count: 2, delay: DEFAULT_RETRY_DELAY_MS, backoff: 'exponential' };
    const maxAttempts = (retryConfig.count ?? 2) + 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 重试时发射 node.retrying 事件
      if (attempt > 0) {
        const baseDelay = retryConfig.delay ?? DEFAULT_RETRY_DELAY_MS;
        const multiplier = retryConfig.backoff === 'exponential' ? Math.pow(2, attempt - 1) : 1;
        const jitter = 0.5 + Math.random() * 0.5;
        const delay = Math.round(baseDelay * multiplier * jitter);

        await this.emitEvent(ctx, 'node.retrying', agentNode, {
          attempt: attempt + 1,
          max_attempts: maxAttempts,
          next_delay_ms: delay,
        });

        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        return await this.executeOnce(agentNode, ctx, resolvedPrompt, resolvedAgent, resolvedSkill, mergedConfig);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // AbortError（取消）不重试
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new WorkflowError(
            'Node cancelled',
            WorkflowErrorCode.DAG_CANCELLED,
            { node_id: node.id },
          );
        }

        // 最后一次失败直接抛出
        if (attempt === maxAttempts - 1) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new WorkflowError('All retry attempts exhausted', WorkflowErrorCode.NODE_FAILED);
  }
```

新增 `resolveAndMergeConfig` 私有方法：

```typescript
  /** 解析 agent config 并合并节点级覆盖 */
  private async resolveAndMergeConfig(node: AgentNodeDef): Promise<Partial<AgentResolvedConfig>> {
    // 无 agent 名称 → 无法解析 config，只用节点字段
    if (!node.agent || !this.options?.resolveAgentConfig) {
      return {
        model: node.model ?? null,
        temperature: node.temperature ?? null,
        steps: node.steps ?? null,
        permission: null,
        knowledge: null,
      };
    }

    const config = await this.options.resolveAgentConfig(node.agent);

    if (!config) {
      // agent 不存在 → 只用节点字段
      return {
        model: node.model ?? null,
        temperature: node.temperature ?? null,
        steps: node.steps ?? null,
        permission: null,
        knowledge: null,
      };
    }

    // 节点字段覆盖 config 值
    return {
      model: node.model ?? config.model,
      temperature: node.temperature ?? config.temperature,
      steps: node.steps ?? config.steps,
      permission: config.permission,
      knowledge: config.knowledge,
    };
  }
```

修改 `executeOnce` 签名，将合并配置透传到 `AgentRequest`：

```typescript
  private async executeOnce(
    node: AgentNodeDef,
    ctx: NodeExecutionContext,
    resolvedPrompt: string,
    resolvedAgent: string | undefined,
    resolvedSkill: string | undefined,
    mergedConfig: Partial<AgentResolvedConfig>,
  ): Promise<NodeOutput> {
    // 发射 node.started 事件
    await this.emitEvent(ctx, 'node.started', node, {
      inputs: ctx.resolvedInputs,
      agent: resolvedAgent,
      skill: resolvedSkill,
    });

    // 连接 Transport
    const session = await this.transport.connect(resolvedAgent ?? 'default', {
      cwd: node.cwd,
    });

    // 构建请求（含合并后的配置）
    const request: AgentRequest = {
      prompt: resolvedPrompt,
      agent: resolvedAgent,
      skill: resolvedSkill,
      cwd: node.cwd,
      signal: ctx.signal,
      model: mergedConfig.model ?? undefined,
      temperature: mergedConfig.temperature ?? undefined,
      steps: mergedConfig.steps ?? undefined,
      permission: mergedConfig.permission ?? undefined,
      knowledge: mergedConfig.knowledge ?? undefined,
    };

    // 执行请求
    const response = await session.execute(request);

    const outputSize = Buffer.byteLength(response.stdout);

    // 非零退出码 → 失败
    if (response.exit_code !== 0) {
      await this.emitEvent(ctx, 'node.failed', node, {
        error: `Agent exited with code ${response.exit_code}`,
        exit_code: response.exit_code,
      });
      throw new WorkflowError(
        `Agent exited with code ${response.exit_code}`,
        WorkflowErrorCode.NODE_FAILED,
        { node_id: node.id, exit_code: response.exit_code, stdout: response.stdout },
      );
    }

    // 尝试解析 JSON
    let json: unknown;
    try {
      json = JSON.parse(response.stdout);
    } catch {
      // stdout 不是合法 JSON，json 留 undefined
    }

    // 发射 node.completed 事件（含 token 统计）
    await this.emitEvent(ctx, 'node.completed', node, {
      exit_code: response.exit_code,
      output_size: outputSize,
      tokens: response.tokens,
      model: response.model,
      latency_ms: response.latency_ms,
    });

    return {
      stdout: response.stdout,
      json,
      exit_code: response.exit_code,
      size: outputSize,
    };
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts 2>&1 | tail -15`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add packages/workflow-engine/src/executor/agent-executor.ts packages/workflow-engine/src/__tests__/executor/agent-executor.test.ts
git commit -m "feat: AgentExecutor 支持 resolveAgentConfig 回调，合并 agent config 与节点级覆盖"
```

---

### Task 4: YAML 解析器支持 agent 节点新字段

**Files:**
- Modify: `packages/workflow-engine/src/parser/yaml-parser.ts:137-151`

- [ ] **Step 1: 在 agent case 分支中解析 model/temperature/steps**

将 `yaml-parser.ts` 中 agent case（约第 137-151 行）替换为：

```typescript
    case "agent": {
      if (!("prompt" in n)) {
        throw new WorkflowError(
          `nodes[${index}] (${n.id}): agent node requires 'prompt'`,
          WorkflowErrorCode.INVALID_YAML,
        );
      }
      return {
        ...base,
        type: "agent",
        prompt: n.prompt as string,
        agent: typeof n.agent === "string" ? n.agent : undefined,
        skill: typeof n.skill === "string" ? n.skill : undefined,
        model: typeof n.model === "string" ? n.model : undefined,
        temperature: typeof n.temperature === "number" ? n.temperature : undefined,
        steps: typeof n.steps === "number" ? n.steps : undefined,
      };
    }
```

- [ ] **Step 2: 写测试验证 YAML 解析**

在 `packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts` 中追加（如果没有 agent 解析的测试）：

```typescript
test('agent 节点解析 model/temperature/steps 可选字段', () => {
  const yaml = `
schema_version: "1.0"
name: test
nodes:
  - id: step1
    type: agent
    prompt: "hello"
    agent: general
    model: claude-sonnet-4-6
    temperature: 0.3
    steps: 15
`;
  const def = parseWorkflowYaml(yaml);
  const node = def.nodes[0] as import('../../types/dag').AgentNodeDef;
  expect(node.agent).toBe('general');
  expect(node.model).toBe('claude-sonnet-4-6');
  expect(node.temperature).toBe(0.3);
  expect(node.steps).toBe(15);
});

test('agent 节点省略可选字段时为 undefined', () => {
  const yaml = `
schema_version: "1.0"
name: test
nodes:
  - id: step1
    type: agent
    prompt: "hello"
`;
  const def = parseWorkflowYaml(yaml);
  const node = def.nodes[0] as import('../../types/dag').AgentNodeDef;
  expect(node.agent).toBeUndefined();
  expect(node.model).toBeUndefined();
  expect(node.temperature).toBeUndefined();
  expect(node.steps).toBeUndefined();
});
```

- [ ] **Step 3: 运行测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/parser/yaml-parser.ts packages/workflow-engine/src/__tests__/parser/yaml-parser.test.ts
git commit -m "feat: YAML 解析器支持 agent 节点的 model/temperature/steps 字段"
```

---

### Task 5: 调度器 resolveNodeInputs 支持 agent 节点新字段

**Files:**
- Modify: `packages/workflow-engine/src/scheduler/dag-scheduler.ts:340-352`

- [ ] **Step 1: 在 `resolveNodeInputs` 的 agent case 中解析新字段**

将 `resolveNodeInputs` 方法中 agent case（约第 340-352 行）替换为：

```typescript
      case 'agent': {
        resolved.prompt = resolveTemplate(node.prompt, evalContext);
        if (node.agent) resolved.agent = resolveTemplate(node.agent, evalContext);
        if (node.skill) resolved.skill = resolveTemplate(node.skill, evalContext);
        if (node.model) resolved.model = resolveTemplate(node.model, evalContext);
        if (node.temperature !== undefined) resolved.temperature = node.temperature;
        if (node.steps !== undefined) resolved.steps = node.steps;
        break;
      }
```

- [ ] **Step 2: 运行全部 workflow-engine 测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/ 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add packages/workflow-engine/src/scheduler/dag-scheduler.ts
git commit -m "feat: 调度器 resolveNodeInputs 支持 agent 节点新字段"
```

---

### Task 6: WorkflowEngine 传入 resolveAgentConfig 回调

**Files:**
- Modify: `packages/workflow-engine/src/engine/workflow-engine.ts`

- [ ] **Step 1: 在 `WorkflowEngineOptions` 中添加 `resolveAgentConfig` 可选字段**

在 `WorkflowEngineOptions` 接口（约第 36-45 行）中增加：

```typescript
/** createWorkflowEngine 构造选项 */
export interface WorkflowEngineOptions {
  storage: StorageAdapter;
  transport?: Transport;
  /** AuditNode HMAC 签名密钥 */
  hmacSecret: string;
  /** .env 文件路径 */
  envFile?: string;
  /** 默认工作目录（子流程 ref 解析基准） */
  defaultCwd?: string;
  /** Agent 配置解析回调（方案 A：注入依赖，不耦合数据库） */
  resolveAgentConfig?: (agentName: string) => Promise<import('../executor/agent-executor').AgentResolvedConfig | null>;
}
```

- [ ] **Step 2: 在 `buildRegistry` 中将回调传入 AgentExecutor**

在 `createWorkflowEngine` 函数体中，`buildRegistry` 函数（约第 121-132 行）的 `AgentExecutor` 构造处：

```typescript
  function buildRegistry(runId: string, baseDir: string): NodeExecutorRegistry {
    const registry = new NodeExecutorRegistry();
    registry.register('shell', new ProcessExecutor());
    registry.register('api', new ApiExecutor());
    if (transport) {
      registry.register('agent', new AgentExecutor(transport, {
        resolveAgentConfig: options.resolveAgentConfig,
      }));
    }
    registry.register('audit', new AuditExecutor(hmacSecret));
    registry.register('workflow', new SubWorkflowExecutor(runId, registry, baseDir));
    registry.register('loop', new LoopExecutor(runId, registry));
    return registry;
  }
```

- [ ] **Step 3: 运行全部 workflow-engine 测试**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/workflow-engine/src/__tests__/ 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add packages/workflow-engine/src/engine/workflow-engine.ts
git commit -m "feat: WorkflowEngineOptions 增加 resolveAgentConfig 回调并传入 AgentExecutor"
```

---

### Task 7: 宿主层实现 resolveAgentConfig 回调

**Files:**
- Modify: `src/services/workflow/index.ts`

- [ ] **Step 1: 实现 resolveAgentConfig 回调并传入引擎构造**

```typescript
import type { WorkflowEngine, AgentResolvedConfig } from "@mothership/workflow-engine";
import { createWorkflowEngine } from "@mothership/workflow-engine";
import type { Transport } from "@mothership/workflow-engine";
import { createAcpTransport } from "./acp-transport";
import { createPgStorageAdapter } from "./pg-storage-adapter";
import { getAgentConfigById } from "../services/config/agent-config";
import { db } from "../../db";
import { agentConfig } from "../../db/schema";
import { eq } from "drizzle-orm";

// 每个 team 一个引擎实例，lazy 创建
const engines = new Map<string, WorkflowEngine>();
let _transport: Transport | null = null;

/** 获取全局共享的 Transport 单例 */
function getTransport(): Transport {
  if (!_transport) _transport = createAcpTransport();
  return _transport;
}

/** 创建 resolveAgentConfig 回调：按 name 查询 agentConfig 表 */
function createAgentConfigResolver(teamId: string): (name: string) => Promise<AgentResolvedConfig | null> {
  return async (name: string) => {
    const rows = await db
      .select()
      .from(agentConfig)
      .where(eq(agentConfig.teamId, teamId))
      .limit(100);

    const row = rows.find((r) => r.name === name);
    if (!row) return null;

    return {
      model: row.model ?? null,
      steps: row.steps ?? null,
      temperature: row.temperature != null ? Number(row.temperature) : null,
      permission: row.permission ?? null,
      knowledge: row.knowledge ?? null,
    };
  };
}

/** 获取或创建指定 team 的 WorkflowEngine 实例 */
export function getTeamEngine(teamId: string): WorkflowEngine {
  let engine = engines.get(teamId);
  if (!engine) {
    const storage = createPgStorageAdapter(teamId);
    engine = createWorkflowEngine({
      storage,
      transport: getTransport(),
      hmacSecret: process.env.RCS_WORKFLOW_HMAC_SECRET || crypto.randomUUID(),
      resolveAgentConfig: createAgentConfigResolver(teamId),
    });
    engines.set(teamId, engine);
  }
  return engine;
}
```

注意：需要从 `@mothership/workflow-engine` 导出 `AgentResolvedConfig` 类型。在 `packages/workflow-engine/src/index.ts` 中检查并添加 re-export：

```typescript
export type { AgentResolvedConfig, AgentExecutorOptions } from './executor/agent-executor';
```

- [ ] **Step 2: 运行类型检查**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1 | head -20`
Expected: 无新增类型错误

- [ ] **Step 3: Commit**

```bash
git add src/services/workflow/index.ts packages/workflow-engine/src/index.ts
git commit -m "feat: 宿主层实现 resolveAgentConfig 回调（查询 agentConfig 表）"
```

---

### Task 8: 前端编辑器 — agent 下拉选择器 + 覆盖配置面板

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

这是最大的任务，需要：
1. 在编辑器组件中加载 agent 列表（`/web/config/agents?action=list`）
2. 将 "Agent 名称" 纯文本 input 替换为 Select 下拉
3. 选中 agent 后显示摘要（model、description）
4. 添加可折叠的"覆盖配置"区域（model、temperature、steps）

- [ ] **Step 1: 在组件顶部添加 agent 列表状态和加载逻辑**

在 `WorkflowEditor.tsx` 中，找到现有 state 声明区域（约第 100 行附近），在合适位置添加：

```typescript
  // ── Agent 配置联动 ──
  const [agentList, setAgentList] = useState<Array<{ name: string; model: string | null; description: string | null }>>([]);
  const [agentOverrideOpen, setAgentOverrideOpen] = useState(false);

  useEffect(() => {
    fetch("/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "list" }),
    })
      .then((res) => res.json())
      .then((json) => {
        const agents = json?.data?.agents;
        if (Array.isArray(agents)) {
          setAgentList(agents.map((a: any) => ({
            name: a.name,
            model: a.model ?? null,
            description: a.description ?? null,
          })));
        }
      })
      .catch((err) => console.error("加载 agent 列表失败:", err));
  }, []);
```

- [ ] **Step 2: 替换 agent 名称 input 为 Select 下拉**

找到 `{nodeType === "agent" && (` 部分（约第 1399 行），将 "Agent 名称" 的 `<input>` 替换为：

```tsx
                    <div className="wf-prop-field">
                      <label>Agent 名称</label>
                      <select
                        value={String(sd?.agent ?? "")}
                        onChange={(e) => updateNodeData({ agent: e.target.value })}
                        disabled={readOnly}
                      >
                        <option value="">（默认）</option>
                        {agentList.map((a) => (
                          <option key={a.name} value={a.name}>{a.name}</option>
                        ))}
                      </select>
                      {sd?.agent && (() => {
                        const found = agentList.find((a) => a.name === sd.agent);
                        if (!found) return null;
                        return (
                          <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>
                            {found.model && <span>模型: {found.model}</span>}
                            {found.model && found.description && <span> · </span>}
                            {found.description && <span>{found.description}</span>}
                          </div>
                        );
                      })()}
                    </div>
```

- [ ] **Step 3: 在 agent 配置区域末尾添加覆盖配置折叠面板**

在 Skill 输入框之后（`</div>` 闭合的 skill field 后），`</>` 闭合 agent section 前，添加：

```tsx
                    <div className="wf-prop-field">
                      <button
                        type="button"
                        onClick={() => setAgentOverrideOpen(!agentOverrideOpen)}
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          fontSize: 11,
                          color: "#6b7280",
                          padding: 0,
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <ChevronRight
                          size={11}
                          style={{
                            transform: agentOverrideOpen ? "rotate(90deg)" : "rotate(0deg)",
                            transition: "transform 0.15s",
                          }}
                        />
                        覆盖配置（可选）
                      </button>
                      {agentOverrideOpen && (
                        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                          <div>
                            <label style={{ fontSize: 10, color: "#9ca3af" }}>模型</label>
                            <input
                              value={String(sd?.model ?? "")}
                              onChange={(e) => updateNodeData({ model: e.target.value || undefined })}
                              placeholder="沿用 agent 配置"
                              readOnly={readOnly}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 10, color: "#9ca3af" }}>Temperature</label>
                            <input
                              type="number"
                              step="0.1"
                              min="0"
                              max="2"
                              value={sd?.temperature ?? ""}
                              onChange={(e) => updateNodeData({
                                temperature: e.target.value ? Number(e.target.value) : undefined,
                              })}
                              placeholder="沿用 agent 配置"
                              readOnly={readOnly}
                            />
                          </div>
                          <div>
                            <label style={{ fontSize: 10, color: "#9ca3af" }}>最大步数</label>
                            <input
                              type="number"
                              min="1"
                              max="200"
                              value={sd?.steps ?? ""}
                              onChange={(e) => updateNodeData({
                                steps: e.target.value ? Number(e.target.value) : undefined,
                              })}
                              placeholder="沿用 agent 配置"
                              readOnly={readOnly}
                            />
                          </div>
                        </div>
                      )}
                    </div>
```

需要在文件顶部 import 中添加 `ChevronRight`：

```typescript
import { ..., ChevronRight } from "lucide-react";
```

- [ ] **Step 4: 构建前端并验证**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -5`
Expected: `✓ built in X.XXs`

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat: 工作流编辑器 agent 节点支持下拉选择和配置覆盖面板"
```

---

## Self-Review

### 1. Spec Coverage
- ✅ AgentNodeDef 增加 model/temperature/steps — Task 1
- ✅ AgentRequest 透传配置 — Task 2
- ✅ AgentExecutor 合并 agent config + 节点覆盖 — Task 3
- ✅ YAML 解析器支持新字段 — Task 4
- ✅ 调度器 resolveNodeInputs 支持新字段 — Task 5
- ✅ WorkflowEngineOptions 注入回调 — Task 6
- ✅ 宿主层实现 resolveAgentConfig — Task 7
- ✅ 前端编辑器下拉选择 + 覆盖面板 — Task 8

### 2. Placeholder Scan
- 无 TBD/TODO/placeholder
- 所有代码步骤包含完整实现

### 3. Type Consistency
- `AgentResolvedConfig` 定义在 `agent-executor.ts`，通过 `index.ts` re-export
- `AgentExecutorOptions` 包含 `resolveAgentConfig` 回调签名
- Task 7 的 `createAgentConfigResolver` 返回类型匹配回调签名
- `AgentRequest` 新增字段均为可选，不破坏现有 Transport 实现
- 前端 `sd?.model` / `sd?.temperature` / `sd?.steps` 匹配 `AgentNodeDef` 类型
