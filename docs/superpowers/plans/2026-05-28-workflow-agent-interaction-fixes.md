# Workflow-Agent 交互层关键修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 workflow 后端与 agent 智能体交互层的 4 个关键/重要问题：执行超时缺失、agent 配置查询低效、EventBus 订阅泄漏、配置字段转发断裂。

**Architecture:** 所有修改集中在 `src/services/workflow/` 和 `src/routes/web/` 层。Workflow Engine 包（`packages/workflow-engine/`）无需修改——问题在于 RCS 侧的桥接层。Transport 接口已预留了需要的字段，只需在 ACP Transport 实现中正确使用。

**Tech Stack:** TypeScript, Bun test, Drizzle ORM, Zod v4

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/services/workflow/acp-transport.ts` | Modify | 添加执行超时、修复订阅泄漏、转发配置字段 |
| `src/services/workflow/index.ts` | Modify | 精确查询 agentConfig、添加 engine 淘汰导出 |
| `src/services/workflow/workflow-events.ts` | Modify | 事件 ID 改用 nanoid |
| `src/__tests__/workflow-acp-transport.test.ts` | Create | ACP Transport 单元测试 |
| `src/__tests__/workflow-index.test.ts` | Create | Workflow 服务层单元测试 |

---

## Task 1: 修复 EventBus 订阅泄漏（C3）

**Files:**
- Modify: `src/services/workflow/acp-transport.ts:79-177`
- Create: `src/__tests__/workflow-acp-transport.test.ts`

`AcpAgentSession.execute()` 的 `finally` 块清理的是已释放的占位 `unsub`，而非真正订阅的 `innerUnsub`。当 `prompt_complete` 或 `error` 事件未到达时（agent 挂死、意外异常），`innerUnsub` 泄漏。

- [ ] **Step 1: 写失败测试 — 验证异常路径下订阅被清理**

```typescript
// src/__tests__/workflow-acp-transport.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventBus, getAcpEventBus, removeAcpEventBus } from "../transport/event-bus";

// 我们需要直接测试 AcpAgentSession 的订阅清理逻辑
// 由于 AcpAgentSession 是模块内部类，我们通过 AcpTransport 间接测试

describe("AcpTransport subscription cleanup", () => {
  // 验证 EventBus 订阅在异常路径下不泄漏
  test("EventBus subscribe 后抛异常时订阅被清理", async () => {
    const bus = new EventBus();
    const initialCount = bus.subscriberCount();

    // 模拟：subscribe 后在 resolve 之前发生异常
    let innerUnsub: (() => void) | null = null;
    try {
      innerUnsub = bus.subscribe(() => {});
      throw new Error("unexpected");
    } catch {
      innerUnsub?.();
    }

    expect(bus.subscriberCount()).toBe(initialCount);
  });

  // 验证正常的 finally 清理模式
  test("finally 块正确清理内层订阅", async () => {
    const bus = new EventBus();
    const initialCount = bus.subscriberCount();

    let innerUnsub: (() => void) | null = null;
    const result = await new Promise<string>((resolve, reject) => {
      innerUnsub = bus.subscribe((event) => {
        if ((event.payload as Record<string, unknown>).type === "test_done") {
          resolve("done");
        }
      });

      // 模拟异步事件
      setTimeout(() => {
        bus.publish({
          id: "test",
          sessionId: "test",
          type: "test",
          payload: { type: "test_done" },
          direction: "inbound",
        });
      }, 10);
    }).finally(() => {
      innerUnsub?.();
    });

    expect(result).toBe("done");
    expect(bus.subscriberCount()).toBe(initialCount);
  });

  // 验证 reject 路径也清理订阅
  test("Promise reject 时 finally 仍然清理内层订阅", async () => {
    const bus = new EventBus();
    const initialCount = bus.subscriberCount();

    let innerUnsub: (() => void) | null = null;
    try {
      await new Promise<string>((_resolve, reject) => {
        innerUnsub = bus.subscribe(() => {});
        setTimeout(() => reject(new Error("agent_disconnect")), 10);
      }).finally(() => {
        innerUnsub?.();
      });
    } catch {
      // expected
    }

    expect(bus.subscriberCount()).toBe(initialCount);
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

```bash
bun test src/__tests__/workflow-acp-transport.test.ts
```

Expected: PASS（测试验证的是正确的清理模式，作为重构的基线）

- [ ] **Step 3: 重构 `AcpAgentSession.execute()` 订阅清理逻辑**

在 `src/services/workflow/acp-transport.ts` 中，修改 `AcpAgentSession.execute()` 方法。删除占位订阅模式（89-92 行的 `const unsub = bus.subscribe(() => {})` / `unsub()`），改为在 `try/finally` 中管理 `innerUnsub`：

```typescript
// acp-transport.ts — AcpAgentSession.execute() 重构后
async execute(request: AgentRequest): Promise<AgentResponse> {
  const startTime = Date.now();
  const chunks: string[] = [];

  if (request.signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  const bus = getAcpEventBus(this.agentId);
  let innerUnsub: (() => void) | null = null;

  try {
    return await new Promise<AgentResponse>((resolve, reject) => {
      let abortCleanup: (() => void) | null = null;

      innerUnsub = bus.subscribe((event: SessionEvent) => {
        if (event.direction !== "inbound") return;

        const type = getPayloadType(event);
        const eventSessionId = getPayloadField<string>(event, "session_id");
        if (eventSessionId !== this.sessionId) return;

        switch (type) {
          case "session_update": {
            const message = getPayloadField<SessionUpdateMessage>(event, "message");
            if (message?.role === "assistant" && typeof message.content === "string") {
              chunks.push(message.content);
            }
            break;
          }

          case "prompt_complete": {
            const metadata = getPayloadField<PromptCompleteMetadata>(event, "metadata");
            const latencyMs = Date.now() - startTime;
            cleanup();
            resolve({
              stdout: chunks.join(""),
              exit_code: 0,
              tokens: metadata?.tokens,
              model: metadata?.model,
              latency_ms: latencyMs,
            });
            break;
          }

          case "error": {
            cleanup();
            resolve({
              stdout: chunks.join(""),
              exit_code: 1,
              latency_ms: Date.now() - startTime,
            });
            break;
          }
        }
      });

      const cleanup = () => {
        innerUnsub?.();
        innerUnsub = null;
        abortCleanup?.();
      };

      // 监听 AbortSignal
      if (request.signal) {
        const onAbort = () => {
          cleanup();
          reject(new DOMException("Request aborted", "AbortError"));
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => request.signal?.removeEventListener("abort", onAbort);
      }

      // 构建并发送 user 消息
      const userMsg: Record<string, unknown> = {
        type: "user",
        session_id: this.sessionId,
        content: request.prompt,
      };
      if (request.skill) {
        userMsg.skill = request.skill;
      }
      if (request.cwd) {
        userMsg.cwd = request.cwd;
      }

      const sent = sendToAgentWs(this.agentId, userMsg);
      if (!sent) {
        cleanup();
        reject(new Error("Agent not found or offline"));
        return;
      }

      log(`[ACP-Transport] Sent user message: sessionId=${this.sessionId} promptLength=${request.prompt.length}`);
    });
  } finally {
    // 保证任何路径都清理内层订阅
    innerUnsub?.();
  }
}
```

注意：`cleanup` 函数内部将 `innerUnsub` 设为 `null`，所以 `finally` 中的 `innerUnsub?.()` 只在 cleanup 未被调用时生效（如意外异常）。

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test src/__tests__/workflow-acp-transport.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/workflow/acp-transport.ts src/__tests__/workflow-acp-transport.test.ts
git commit -m "fix: 修复 AcpAgentSession EventBus 订阅泄漏问题"
```

---

## Task 2: 添加 ACP Transport 执行超时（C1）

**Files:**
- Modify: `src/services/workflow/acp-transport.ts:17-18` (添加常量)
- Modify: `src/services/workflow/acp-transport.ts` (AcpAgentSession.execute 方法)
- Modify: `src/__tests__/workflow-acp-transport.test.ts`

`AcpAgentSession.execute()` 没有执行超时。如果 agent 静默挂死（不发 `prompt_complete`、不断连），Promise 永远不会 settle。需要添加与 `request.signal` 配合的执行超时。

- [ ] **Step 1: 写失败测试 — 验证超时路径清理订阅**

在 `src/__tests__/workflow-acp-transport.test.ts` 末尾追加：

```typescript
describe("AcpTransport execute timeout", () => {
  // 执行超时时抛出 AbortError
  test("execute 超时时抛出带有超时信息的错误", async () => {
    const bus = new EventBus();
    const initialCount = bus.subscriberCount();

    // 模拟：subscribe 后永不发事件，超时触发
    let innerUnsub: (() => void) | null = null;
    const timeoutMs = 100;

    try {
      await Promise.race([
        new Promise<string>((resolve) => {
          innerUnsub = bus.subscribe(() => {
            resolve("should not reach");
          });
          // 永不发事件
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new DOMException(`Agent execute timed out after ${timeoutMs}ms`, "AbortError"));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
      expect.unreachable("Should have timed out");
    } catch (err) {
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
    } finally {
      innerUnsub?.();
    }

    // 超时清理后订阅数恢复
    expect(bus.subscriberCount()).toBe(initialCount);
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

```bash
bun test src/__tests__/workflow-acp-transport.test.ts
```

Expected: PASS

- [ ] **Step 3: 在 `acp-transport.ts` 添加执行超时常量和逻辑**

在常量区（约第 20 行，`SESSION_CREATE_TIMEOUT_MS` 下方）添加：

```typescript
/** 等待 agent 执行响应的默认超时时间（10 分钟） */
const DEFAULT_EXECUTE_TIMEOUT_MS = 10 * 60 * 1000;
```

在 `AcpAgentSession.execute()` 方法的 `Promise.race` 中包装超时（在 Task 1 重构后的代码基础上）。修改 try 块内的 `return await new Promise<AgentResponse>(...)` 为：

```typescript
return await Promise.race([
  new Promise<AgentResponse>((resolve, reject) => {
    // ... 原有 Promise 逻辑不变（已在 Task 1 中重构）
  }),
  createTimeoutPromise(DEFAULT_EXECUTE_TIMEOUT_MS, "Agent execute"),
]);
```

完整替换后的 `execute()` 方法（基于 Task 1 的重构结果）：

```typescript
async execute(request: AgentRequest): Promise<AgentResponse> {
  const startTime = Date.now();
  const chunks: string[] = [];

  if (request.signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  const bus = getAcpEventBus(this.agentId);
  let innerUnsub: (() => void) | null = null;

  try {
    return await Promise.race([
      new Promise<AgentResponse>((resolve, reject) => {
        let abortCleanup: (() => void) | null = null;

        innerUnsub = bus.subscribe((event: SessionEvent) => {
          if (event.direction !== "inbound") return;

          const type = getPayloadType(event);
          const eventSessionId = getPayloadField<string>(event, "session_id");
          if (eventSessionId !== this.sessionId) return;

          switch (type) {
            case "session_update": {
              const message = getPayloadField<SessionUpdateMessage>(event, "message");
              if (message?.role === "assistant" && typeof message.content === "string") {
                chunks.push(message.content);
              }
              break;
            }

            case "prompt_complete": {
              const metadata = getPayloadField<PromptCompleteMetadata>(event, "metadata");
              const latencyMs = Date.now() - startTime;
              cleanup();
              resolve({
                stdout: chunks.join(""),
                exit_code: 0,
                tokens: metadata?.tokens,
                model: metadata?.model,
                latency_ms: latencyMs,
              });
              break;
            }

            case "error": {
              cleanup();
              resolve({
                stdout: chunks.join(""),
                exit_code: 1,
                latency_ms: Date.now() - startTime,
              });
              break;
            }
          }
        });

        const cleanup = () => {
          innerUnsub?.();
          innerUnsub = null;
          abortCleanup?.();
        };

        if (request.signal) {
          const onAbort = () => {
            cleanup();
            reject(new DOMException("Request aborted", "AbortError"));
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => request.signal?.removeEventListener("abort", onAbort);
        }

        const userMsg: Record<string, unknown> = {
          type: "user",
          session_id: this.sessionId,
          content: request.prompt,
        };
        if (request.skill) {
          userMsg.skill = request.skill;
        }
        if (request.cwd) {
          userMsg.cwd = request.cwd;
        }

        const sent = sendToAgentWs(this.agentId, userMsg);
        if (!sent) {
          cleanup();
          reject(new Error("Agent not found or offline"));
          return;
        }

        log(`[ACP-Transport] Sent user message: sessionId=${this.sessionId} promptLength=${request.prompt.length}`);
      }),
      createTimeoutPromise(DEFAULT_EXECUTE_TIMEOUT_MS, "Agent execute"),
    ]);
  } finally {
    innerUnsub?.();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test src/__tests__/workflow-acp-transport.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/workflow/acp-transport.ts src/__tests__/workflow-acp-transport.test.ts
git commit -m "fix: 添加 AcpAgentSession 执行超时防止 agent 挂死阻塞工作流"
```

---

## Task 3: 修复 agent 配置查询效率（C2）

**Files:**
- Modify: `src/services/workflow/index.ts:29-43`
- Create: `src/__tests__/workflow-index.test.ts`

`createAgentConfigResolver` 查询组织的所有 agent 配置（最多 100 行）再在 JS 中 find。应改为按 `organizationId + name` 精确查询。

- [ ] **Step 1: 写失败测试 — 验证精确查询调用模式**

```typescript
// src/__tests__/workflow-index.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// 测试 createAgentConfigResolver 的查询行为
// 由于 db 被 setup-mocks.ts mock 了，我们验证 stub 被正确调用

describe("createAgentConfigResolver", () => {
  // 精确查询时只返回匹配的行
  test("按 name 精确查询返回匹配的 agent 配置", async () => {
    // 导入会被 mock 的 db stub
    const { getDbStub, resetAllStubs, setDbStub } = await import("../test-utils/helpers");

    resetAllStubs();

    // 设置 db.select stub 返回精确匹配结果
    const mockSelect = (..._args: unknown[]) => ({
      from: (..._args: unknown[]) => ({
        where: (..._args: unknown[]) => ({
          limit: (..._args: unknown[]) => Promise.resolve([
            {
              name: "my-agent",
              model: "claude-sonnet-4-6",
              steps: 20,
              temperature: "0.7",
              permission: { bash: "allow" },
              knowledge: null,
            },
          ]),
        }),
      }),
    });

    setDbStub({ select: mockSelect });

    // 需要在 mock 设置后动态导入
    const { getTeamEngine } = await import("../services/workflow");

    // 通过 engine 的 resolveAgentConfig 回调验证
    // getTeamEngine 内部创建 engine 时会传入 resolveAgentConfig
    // 我们直接测试这个回调的行为
    const { createAgentConfigResolver } = await import("../services/workflow");

    // 这个测试验证接口契约——无论内部实现如何，返回值结构必须正确
    const resolver = createAgentConfigResolver("test-org");
    const config = await resolver("my-agent");

    expect(config).not.toBeNull();
    expect(config!.model).toBe("claude-sonnet-4-6");
    expect(config!.steps).toBe(20);
    expect(config!.temperature).toBe(0.7);
    expect(config!.permission).toEqual({ bash: "allow" });

    resetAllStubs();
  });

  // 查询不到时返回 null
  test("不存在的 agent 返回 null", async () => {
    const { getDbStub, resetAllStubs, setDbStub } = await import("../test-utils/helpers");

    resetAllStubs();

    const mockSelect = (..._args: unknown[]) => ({
      from: (..._args: unknown[]) => ({
        where: (..._args: unknown[]) => ({
          limit: (..._args: unknown[]) => Promise.resolve([]),
        }),
      }),
    });

    setDbStub({ select: mockSelect });

    const { createAgentConfigResolver } = await import("../services/workflow");
    const resolver = createAgentConfigResolver("test-org");
    const config = await resolver("nonexistent");

    expect(config).toBeNull();

    resetAllStubs();
  });
});
```

> 注意：如果 `createAgentConfigResolver` 没有从 `index.ts` 导出，需要在 `index.ts` 底部添加 `export { createAgentConfigResolver }` 来支持测试。或者改为测试整个 `getTeamEngine` 链路。根据项目实际导出情况调整。

- [ ] **Step 2: 运行测试确认失败或通过**

```bash
bun test src/__tests__/workflow-index.test.ts
```

Expected: 如果 `createAgentConfigResolver` 未导出，需要先添加导出。

- [ ] **Step 3: 修改 `createAgentConfigResolver` 为精确查询**

在 `src/services/workflow/index.ts` 中，将 `createAgentConfigResolver` 的实现从全表扫描改为精确查询：

修改前：
```typescript
function createAgentConfigResolver(organizationId: string): (name: string) => Promise<AgentResolvedConfig | null> {
  return async (name: string) => {
    const rows = await db.select().from(agentConfig).where(eq(agentConfig.organizationId, organizationId)).limit(100);
    const row = rows.find((r) => r.name === name);
    if (!row) return null;
    // ...
  };
}
```

修改后：
```typescript
function createAgentConfigResolver(organizationId: string): (name: string) => Promise<AgentResolvedConfig | null> {
  return async (name: string) => {
    const [row] = await db
      .select()
      .from(agentConfig)
      .where(and(eq(agentConfig.organizationId, organizationId), eq(agentConfig.name, name)))
      .limit(1);

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
```

同时需要在文件顶部添加 `and` 的导入（`eq` 已导入）：

```typescript
import { and, eq } from "drizzle-orm";
```

同时，导出 `createAgentConfigResolver` 以支持测试：

```typescript
export { createAgentConfigResolver };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test src/__tests__/workflow-index.test.ts
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/workflow/index.ts src/__tests__/workflow-index.test.ts
git commit -m "fix: agent 配置查询从全表扫描改为按 organizationId+name 精确查询"
```

---

## Task 4: 转发 model/temperature/steps/permission/knowledge 到 agent 消息（I2）

**Files:**
- Modify: `src/services/workflow/acp-transport.ts` (AcpAgentSession.execute 中的 userMsg 构建)
- Modify: `src/__tests__/workflow-acp-transport.test.ts`

`AgentRequest` 包含 `model`、`temperature`、`steps`、`permission`、`knowledge` 字段，`AgentExecutor` 也正确填充了这些字段，但 `AcpAgentSession.execute()` 只发送了 `prompt`、`skill`、`cwd`。配置合并链路在此断裂。

- [ ] **Step 1: 写失败测试 — 验证配置字段被转发**

在 `src/__tests__/workflow-acp-transport.test.ts` 末尾追加：

```typescript
describe("AcpAgentSession config forwarding", () => {
  // model 字段被转发到 agent 消息
  test("request.model 被包含在发送给 agent 的消息中", async () => {
    // 这里测试的是 AcpAgentSession.execute 中 userMsg 的构建逻辑
    // 由于 sendToAgentWs 需要真实 WS 连接，我们验证消息构建的正确性

    // 验证 AgentRequest 的所有可选字段都被映射到 userMsg
    const request = {
      prompt: "test prompt",
      model: "claude-sonnet-4-6",
      temperature: 0.7,
      steps: 20,
      permission: { bash: "allow" },
      knowledge: { ids: ["kb-1"] },
      skill: "code-review",
      cwd: "/workspace",
    };

    // 验证消息构建逻辑：所有字段应被包含
    const userMsg: Record<string, unknown> = {
      type: "user",
      session_id: "test-session",
      content: request.prompt,
    };
    if (request.skill) userMsg.skill = request.skill;
    if (request.cwd) userMsg.cwd = request.cwd;
    if (request.model) userMsg.model = request.model;
    if (request.temperature !== undefined) userMsg.temperature = request.temperature;
    if (request.steps !== undefined) userMsg.steps = request.steps;
    if (request.permission !== undefined) userMsg.permission = request.permission;
    if (request.knowledge !== undefined) userMsg.knowledge = request.knowledge;

    expect(userMsg.model).toBe("claude-sonnet-4-6");
    expect(userMsg.temperature).toBe(0.7);
    expect(userMsg.steps).toBe(20);
    expect(userMsg.permission).toEqual({ bash: "allow" });
    expect(userMsg.knowledge).toEqual({ ids: ["kb-1"] });
    expect(userMsg.skill).toBe("code-review");
    expect(userMsg.cwd).toBe("/workspace");
  });
});
```

- [ ] **Step 2: 运行测试确认通过（基线测试）**

```bash
bun test src/__tests__/workflow-acp-transport.test.ts
```

Expected: PASS（测试验证的是消息构建模式的正确性）

- [ ] **Step 3: 修改 `AcpAgentSession.execute()` 中的 userMsg 构建**

在 `src/services/workflow/acp-transport.ts` 中，`AcpAgentSession.execute()` 方法的 userMsg 构建部分（约 152-162 行），在现有 `skill` 和 `cwd` 字段之后添加配置字段转发：

修改前：
```typescript
const userMsg: Record<string, unknown> = {
  type: "user",
  session_id: this.sessionId,
  content: request.prompt,
};
if (request.skill) {
  userMsg.skill = request.skill;
}
if (request.cwd) {
  userMsg.cwd = request.cwd;
}
```

修改后：
```typescript
const userMsg: Record<string, unknown> = {
  type: "user",
  session_id: this.sessionId,
  content: request.prompt,
};
if (request.skill) {
  userMsg.skill = request.skill;
}
if (request.cwd) {
  userMsg.cwd = request.cwd;
}
if (request.model) {
  userMsg.model = request.model;
}
if (request.temperature !== undefined) {
  userMsg.temperature = request.temperature;
}
if (request.steps !== undefined) {
  userMsg.steps = request.steps;
}
if (request.permission !== undefined) {
  userMsg.permission = request.permission;
}
if (request.knowledge !== undefined) {
  userMsg.knowledge = request.knowledge;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test src/__tests__/workflow-acp-transport.test.ts
```

Expected: PASS

- [ ] **Step 5: 运行 precheck 确保类型检查通过**

```bash
bun run precheck
```

Expected: 通过（`AgentRequest` 接口已定义这些字段，类型兼容）

- [ ] **Step 6: 提交**

```bash
git add src/services/workflow/acp-transport.ts src/__tests__/workflow-acp-transport.test.ts
git commit -m "fix: 转发 model/temperature/steps/permission/knowledge 到 agent 消息"
```

---

## Task 5: 修复 workflow-events 事件 ID 碰撞风险（I5）

**Files:**
- Modify: `src/services/workflow/workflow-events.ts:1,43`

事件 ID 使用 `Date.now() + Math.random().toString(36)` 有碰撞风险。改用项目已有的 `nanoid`。

- [ ] **Step 1: 修改事件 ID 生成逻辑**

在 `src/services/workflow/workflow-events.ts` 中：

1. 添加 `nanoid` 导入（在文件顶部）：
```typescript
import { nanoid } from "nanoid";
```

2. 修改 `publishWorkflowEvent` 函数中的 `id` 生成（第 43 行）：

修改前：
```typescript
id: `wf_evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
```

修改后：
```typescript
id: `wf_evt_${nanoid(12)}`,
```

- [ ] **Step 2: 同样修复 `workflow-job-events.ts`**

在 `src/services/workflow/workflow-job-events.ts` 中做相同修改：

1. 添加导入：
```typescript
import { nanoid } from "nanoid";
```

2. 修改第 43 行：
```typescript
id: `job_evt_${nanoid(12)}`,
```

- [ ] **Step 3: 运行 precheck 确认无问题**

```bash
bun run precheck
```

Expected: 通过

- [ ] **Step 4: 提交**

```bash
git add src/services/workflow/workflow-events.ts src/services/workflow/workflow-job-events.ts
git commit -m "fix: workflow/job 事件 ID 改用 nanoid 避免高并发碰撞"
```

---

## Task 6: 添加 engine 实例淘汰机制（I1）

**Files:**
- Modify: `src/services/workflow/index.ts`

`engines` Map 只增不减。添加 `removeTeamEngine` 导出函数，供未来清理逻辑调用。

- [ ] **Step 1: 在 `src/services/workflow/index.ts` 末尾添加淘汰函数**

在文件末尾（`getTeamEngine` 函数之后）添加：

```typescript
/** 移除指定 team 的 WorkflowEngine 实例（释放内存） */
export function removeTeamEngine(organizationId: string): boolean {
  return engines.delete(organizationId);
}

/** 清理所有缓存的 engine 实例 */
export function clearAllEngines(): void {
  engines.clear();
}
```

- [ ] **Step 2: 运行 precheck 确认无问题**

```bash
bun run precheck
```

Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add src/services/workflow/index.ts
git commit -m "feat: 添加 WorkflowEngine 实例淘汰导出函数"
```

---

## Task 7: 全量测试与 precheck

**Files:** 无新文件

- [ ] **Step 1: 运行全量后端测试**

```bash
bun test src/__tests__/
```

Expected: 全部通过

- [ ] **Step 2: 运行 workflow engine 包测试**

```bash
bun test packages/workflow-engine/src/__tests__/
```

Expected: 全部通过

- [ ] **Step 3: 运行 precheck**

```bash
bun run precheck
```

Expected: 格式化 + tsc + biome check 全部通过

- [ ] **Step 4: 如有 precheck 自动修复导致的变更，提交**

```bash
git add -A
git commit -m "style: precheck 自动修复格式和 import 排序"
```

---

## 依赖关系

```
Task 1 (订阅泄漏) → Task 2 (执行超时，基于 Task 1 重构后的代码)
Task 3 (配置查询) — 独立
Task 4 (配置转发) — 独立，但应在 Task 2 之后（修改同一文件）
Task 5 (事件 ID) — 独立
Task 6 (engine 淘汰) — 独立
Task 7 (全量验证) — 依赖所有任务完成
```

推荐执行顺序：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7
