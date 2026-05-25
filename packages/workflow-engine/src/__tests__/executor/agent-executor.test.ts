/**
 * AgentExecutor 测试 — 使用 FakeTransport 验证 Agent 节点执行逻辑。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { AgentExecutor } from "../../executor/agent-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { AgentRequest, AgentResponse, AgentSession, Transport } from "../../transport/transport";
import type { AgentNodeDef } from "../../types/dag";
import { WorkflowError, WorkflowErrorCode } from "../../types/errors";

// ---------- FakeTransport（测试专用） ----------

/** 测试用 Transport 实现，返回预设响应 */
class FakeTransport implements Transport {
  private responses: Map<string, AgentResponse> = new Map();
  private connectedAgents: Set<string> = new Set();
  private lastRequests: Map<string, AgentRequest> = new Map();
  private shouldThrow: Error | null = null;

  /** 设置指定 agent 的响应 */
  setResponse(agentId: string, response: AgentResponse): void {
    this.responses.set(agentId, response);
  }

  /** 获取指定 agent 的最后请求 */
  getLastRequest(agentId: string): AgentRequest | undefined {
    return this.lastRequests.get(agentId);
  }

  /** 获取已连接的 agent 列表 */
  getConnectedAgents(): Set<string> {
    return this.connectedAgents;
  }

  /** 设置下一次连接时抛出的错误 */
  setThrowError(error: Error): void {
    this.shouldThrow = error;
  }

  async connect(agentId: string): Promise<AgentSession> {
    this.connectedAgents.add(agentId);

    if (this.shouldThrow) {
      const err = this.shouldThrow;
      this.shouldThrow = null;
      throw err;
    }

    return {
      execute: async (req: AgentRequest) => {
        this.lastRequests.set(agentId, req);
        const response = this.responses.get(agentId);
        if (!response) throw new Error(`No response configured for agent: ${agentId}`);
        return response;
      },
    };
  }
}

// ---------- 辅助工具 ----------

/** 创建测试用的 NodeExecutionContext */
function makeCtx(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const storage = createInMemoryStorage();
  return {
    runId: "test-run-001",
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal: AbortSignal.timeout(30_000),
    storage,
    ...overrides,
  };
}

/** 创建简单的 agent 节点定义 */
function agentNode(prompt: string, overrides?: Partial<AgentNodeDef>): AgentNodeDef {
  return {
    id: "test-agent",
    type: "agent",
    prompt,
    ...overrides,
  };
}

// ========== 基础执行测试 ==========

describe("AgentExecutor", () => {
  let transport: FakeTransport;
  let executor: AgentExecutor;

  beforeEach(() => {
    transport = new FakeTransport();
    executor = new AgentExecutor(transport);
  });

  // 基本执行：FakeTransport 返回预设响应
  test("FakeTransport 返回预设响应 → 正确 stdout 和 exit_code", async () => {
    transport.setResponse("default", {
      stdout: "Hello from agent",
      exit_code: 0,
    });

    const ctx = makeCtx();
    const node = agentNode("Say hello");
    const output = await executor.execute(node, ctx);

    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe("Hello from agent");
    expect(output.size).toBeGreaterThan(0);
  });

  // 指定 agent 连接
  test("指定 agent 参数时连接到对应 agent", async () => {
    transport.setResponse("my-agent", {
      stdout: "Agent response",
      exit_code: 0,
    });

    const ctx = makeCtx();
    const node = agentNode("Do something", { agent: "my-agent" });
    const output = await executor.execute(node, ctx);

    expect(output.stdout).toBe("Agent response");
    expect(transport.getConnectedAgents().has("my-agent")).toBe(true);
  });

  // 非零退出码
  test("Agent 返回非零 exit_code 时抛出 WorkflowError", async () => {
    transport.setResponse("default", {
      stdout: "error output",
      exit_code: 1,
    });

    const ctx = makeCtx();
    const node = agentNode("Fail task");

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
    await expect(executor.execute(node, ctx)).rejects.toMatchObject({
      code: WorkflowErrorCode.NODE_FAILED,
    });
  });

  // 非法节点类型
  test("非 agent 节点抛出错误", async () => {
    const ctx = makeCtx();
    const node = { id: "bad", type: "shell" } as any;

    await expect(executor.execute(node, ctx)).rejects.toThrow(WorkflowError);
  });

  // 未配置响应的 agent
  test("未配置响应时抛出错误", async () => {
    const ctx = makeCtx();
    const node = agentNode("No response configured");

    await expect(executor.execute(node, ctx)).rejects.toThrow();
  });
});

// ========== 事件测试 ==========

describe("AgentExecutor events", () => {
  let transport: FakeTransport;
  let executor: AgentExecutor;

  beforeEach(() => {
    transport = new FakeTransport();
    executor = new AgentExecutor(transport);
  });

  // node.started 事件
  test("执行产生 node.started 事件", async () => {
    transport.setResponse("default", { stdout: "ok", exit_code: 0 });

    const ctx = makeCtx();
    const node = agentNode("test");
    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-agent" });
    const startedEvents = events.filter((e) => e.type === "node.started");
    expect(startedEvents.length).toBe(1);
  });

  // node.completed 事件
  test("成功执行产生 node.completed 事件", async () => {
    transport.setResponse("default", { stdout: "done", exit_code: 0 });

    const ctx = makeCtx();
    const node = agentNode("test");
    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-agent" });
    const completedEvents = events.filter((e) => e.type === "node.completed");
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].metadata?.exit_code).toBe(0);
    expect(completedEvents[0].metadata?.output_size).toBeGreaterThan(0);
  });

  // Token 统计出现在 node.completed 事件 metadata
  test("Token 统计出现在 node.completed 事件 metadata", async () => {
    transport.setResponse("default", {
      stdout: "token test",
      exit_code: 0,
      tokens: { input: 100, output: 50 },
      model: "gpt-4",
      latency_ms: 1234,
    });

    const ctx = makeCtx();
    const node = agentNode("test");
    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-agent" });
    const completedEvents = events.filter((e) => e.type === "node.completed");
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].metadata?.tokens).toEqual({ input: 100, output: 50 });
    expect(completedEvents[0].metadata?.model).toBe("gpt-4");
    expect(completedEvents[0].metadata?.latency_ms).toBe(1234);
  });

  // node.failed 事件（关闭默认重试以验证单次失败）
  test("非零退出码产生 node.failed 事件", async () => {
    transport.setResponse("default", { stdout: "err", exit_code: 1 });

    const ctx = makeCtx();
    const node = agentNode("fail", { retry: { count: 0 } });

    try {
      await executor.execute(node, ctx);
    } catch {}

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-agent" });
    const failedEvents = events.filter((e) => e.type === "node.failed");
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].metadata?.exit_code).toBe(1);
  });
});

// ========== resolvedInputs 测试 ==========

describe("AgentExecutor resolvedInputs", () => {
  let transport: FakeTransport;
  let executor: AgentExecutor;

  beforeEach(() => {
    transport = new FakeTransport();
    executor = new AgentExecutor(transport);
  });

  // resolvedInputs.prompt 注入到 AgentRequest
  test("resolvedInputs.prompt 注入到 AgentRequest", async () => {
    transport.setResponse("default", {
      stdout: "resolved",
      exit_code: 0,
    });

    const ctx = makeCtx({
      params: { topic: "world" },
      resolvedInputs: { prompt: "Tell me about world" },
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional test input for expression parser
    const node = agentNode("Tell me about ${{ params.topic }}");
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("default");
    expect(lastReq?.prompt).toBe("Tell me about world");
  });

  // resolvedInputs.agent 注入到 AgentRequest
  test("resolvedInputs.agent 注入到 AgentRequest", async () => {
    transport.setResponse("resolved-agent", {
      stdout: "ok",
      exit_code: 0,
    });

    const ctx = makeCtx({
      resolvedInputs: {
        prompt: "test",
        agent: "resolved-agent",
      },
    });
    const node = agentNode("test", { agent: "original-agent" });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("resolved-agent");
    expect(lastReq?.agent).toBe("resolved-agent");
    expect(transport.getConnectedAgents().has("resolved-agent")).toBe(true);
  });

  // resolvedInputs.skill 注入到 AgentRequest
  test("resolvedInputs.skill 注入到 AgentRequest", async () => {
    transport.setResponse("default", {
      stdout: "ok",
      exit_code: 0,
    });

    const ctx = makeCtx({
      resolvedInputs: {
        prompt: "test",
        skill: "resolved-skill",
      },
    });
    const node = agentNode("test", { skill: "original-skill" });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("default");
    expect(lastReq?.skill).toBe("resolved-skill");
  });
});

// ========== 重试测试 ==========

describe("AgentExecutor retry", () => {
  let transport: FakeTransport;
  let executor: AgentExecutor;

  beforeEach(() => {
    transport = new FakeTransport();
    executor = new AgentExecutor(transport);
  });

  // 默认重试 2 次后失败
  test("Transport 抛错 → FAILED（默认重试 2 次）", async () => {
    // 未配置响应 → 每次都抛错
    const ctx = makeCtx();
    const node = agentNode("always fail");

    await expect(executor.execute(node, ctx)).rejects.toThrow();

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-agent" });
    const retryEvents = events.filter((e) => e.type === "node.retrying");
    // 默认重试 2 次 → 2 个 node.retrying 事件
    expect(retryEvents.length).toBe(2);
    expect(retryEvents[0].metadata?.attempt).toBe(2);
    expect(retryEvents[1].metadata?.attempt).toBe(3);
  });

  // 自定义重试配置
  test("自定义 retry.count=1 → 重试 1 次后失败", async () => {
    const ctx = makeCtx();
    const node = agentNode("fail", {
      retry: { count: 1, delay: 50, backoff: "fixed" },
    });

    await expect(executor.execute(node, ctx)).rejects.toThrow();

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-agent" });
    const retryEvents = events.filter((e) => e.type === "node.retrying");
    expect(retryEvents.length).toBe(1);
  });

  // 重试成功：前两次失败，第三次成功
  test("重试成功：前两次失败、第三次成功 → COMPLETED", async () => {
    const _callCount = 0;
    transport.setResponse("default", {
      stdout: "eventual success",
      exit_code: 0,
    });

    // 用 setThrowError 模拟前两次失败
    // FakeTransport.setThrowError 只在 connect 时生效一次
    // 所以需要用另一种方式：让响应前两次返回非零退出码

    // 替换为自定义行为：通过多次设置来模拟
    const customTransport = new FakeTransport();
    let attempt = 0;
    const origConnect = customTransport.connect.bind(customTransport);
    customTransport.connect = async (agentId: string) => {
      attempt++;
      if (attempt <= 2) {
        throw new Error(`Connection failed (attempt ${attempt})`);
      }
      return origConnect(agentId);
    };
    customTransport.setResponse("default", { stdout: "ok", exit_code: 0 });

    const customExecutor = new AgentExecutor(customTransport);
    const ctx = makeCtx();
    const node = agentNode("retry me", {
      retry: { count: 2, delay: 50, backoff: "fixed" },
    });

    const output = await customExecutor.execute(node, ctx);
    expect(output.exit_code).toBe(0);
    expect(output.stdout).toBe("ok");

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-agent" });
    const retryEvents = events.filter((e) => e.type === "node.retrying");
    expect(retryEvents.length).toBe(2);
  });
});

// ========== AbortSignal 取消测试 ==========

describe("AgentExecutor cancellation", () => {
  test("AbortSignal 取消时 FakeTransport 收到 abort signal", async () => {
    let receivedSignal: AbortSignal | undefined;

    const transportWithSignal = new FakeTransport();
    const origConnect = transportWithSignal.connect.bind(transportWithSignal);
    transportWithSignal.connect = async (agentId: string) => {
      const _session = await origConnect(agentId);
      return {
        execute: async (req: AgentRequest) => {
          receivedSignal = req.signal;
          // 模拟长时间执行，监听 signal 取消
          return new Promise<AgentResponse>((_resolve, reject) => {
            const onAbort = () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            };
            if (req.signal?.aborted) {
              onAbort();
              return;
            }
            req.signal?.addEventListener("abort", onAbort, { once: true });
          });
        },
      };
    };

    const executor = new AgentExecutor(transportWithSignal);
    const controller = new AbortController();
    const ctx = makeCtx({ signal: controller.signal });
    const node = agentNode("cancel me");

    // 50ms 后取消
    setTimeout(() => controller.abort(), 50);

    await expect(executor.execute(node, ctx)).rejects.toThrow();

    // 验证 signal 被传递到 session.execute
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });
});

// ========== JSON 解析测试 ==========

describe("AgentExecutor JSON parsing", () => {
  test("stdout 为合法 JSON 时 json 字段被解析", async () => {
    const transport = new FakeTransport();
    transport.setResponse("default", {
      stdout: '{"result": "success"}',
      exit_code: 0,
    });

    const executor = new AgentExecutor(transport);
    const ctx = makeCtx();
    const node = agentNode("json test");

    const output = await executor.execute(node, ctx);
    expect(output.json).toEqual({ result: "success" });
  });

  test("stdout 非法 JSON 时 json 为 undefined", async () => {
    const transport = new FakeTransport();
    transport.setResponse("default", {
      stdout: "plain text",
      exit_code: 0,
    });

    const executor = new AgentExecutor(transport);
    const ctx = makeCtx();
    const node = agentNode("text test");

    const output = await executor.execute(node, ctx);
    expect(output.json).toBeUndefined();
  });
});

// ========== 请求参数透传测试 ==========

describe("AgentExecutor request forwarding", () => {
  test("skill 参数透传到 AgentRequest", async () => {
    const transport = new FakeTransport();
    transport.setResponse("default", { stdout: "ok", exit_code: 0 });

    const executor = new AgentExecutor(transport);
    const ctx = makeCtx();
    const node = agentNode("use skill", { skill: "code-review" });

    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("default");
    expect(lastReq?.skill).toBe("code-review");
  });
});

// ========== Agent Config 合并测试 ==========

describe("AgentExecutor config merging", () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
    transport.setResponse("my-agent", { stdout: "ok", exit_code: 0 });
  });

  test("resolveAgentConfig 被调用且 model 合并到 request", async () => {
    let resolvedName = "";
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async (name: string) => {
        resolvedName = name;
        return {
          model: "claude-sonnet-4-6",
          steps: 20,
          temperature: 0.7,
          permission: { bash: "allow" },
          knowledge: null,
        };
      },
    });

    const ctx = makeCtx();
    const node = agentNode("test", { agent: "my-agent" });
    await executor.execute(node, ctx);

    expect(resolvedName).toBe("my-agent");
    const lastReq = transport.getLastRequest("my-agent");
    expect(lastReq?.model).toBe("claude-sonnet-4-6");
    expect(lastReq?.temperature).toBe(0.7);
    expect(lastReq?.steps).toBe(20);
    expect(lastReq?.permission).toEqual({ bash: "allow" });
  });

  test("节点级 model 覆盖 agent config 的 model", async () => {
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => {
        return { model: "gpt-4", steps: 10, temperature: 0.5, permission: null, knowledge: null };
      },
    });

    const ctx = makeCtx();
    const node = agentNode("test", { agent: "my-agent", model: "claude-opus-4-7" });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("my-agent");
    expect(lastReq?.model).toBe("claude-opus-4-7");
    expect(lastReq?.temperature).toBe(0.5);
    expect(lastReq?.steps).toBe(10);
  });

  test("节点级 temperature 覆盖 agent config", async () => {
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => {
        return { model: "gpt-4", steps: 10, temperature: 0.5, permission: null, knowledge: null };
      },
    });

    const ctx = makeCtx();
    const node = agentNode("test", { agent: "my-agent", temperature: 0.1 });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("my-agent");
    expect(lastReq?.temperature).toBe(0.1);
    expect(lastReq?.model).toBe("gpt-4");
  });

  test("agent 字段为空时 resolveAgentConfig 不被调用", async () => {
    transport.setResponse("default", { stdout: "ok", exit_code: 0 });
    let called = false;
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => {
        called = true;
        return { model: null, steps: null, temperature: null, permission: null, knowledge: null };
      },
    });

    const ctx = makeCtx();
    const node = agentNode("test");
    await executor.execute(node, ctx);

    expect(called).toBe(false);
    const lastReq = transport.getLastRequest("default");
    expect(lastReq?.model).toBeUndefined();
  });

  test("resolveAgentConfig 返回 null 时使用节点字段", async () => {
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => null,
    });

    const ctx = makeCtx();
    const node = agentNode("test", { agent: "my-agent", model: "fallback-model" });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("my-agent");
    expect(lastReq?.model).toBe("fallback-model");
  });
});

// ========== Agent Config 合并测试 ==========

describe("AgentExecutor config merging", () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
    transport.setResponse("my-agent", { stdout: "ok", exit_code: 0 });
  });

  // resolveAgentConfig 被调用且 model 合并到 request
  test("resolveAgentConfig 被调用且 model 合并到 request", async () => {
    let resolvedName = "";
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async (name: string) => {
        resolvedName = name;
        return {
          model: "claude-sonnet-4-6",
          steps: 20,
          temperature: 0.7,
          permission: { bash: "allow" },
          knowledge: null,
        };
      },
    });

    const ctx = makeCtx();
    const node = agentNode("test", { agent: "my-agent" });
    await executor.execute(node, ctx);

    expect(resolvedName).toBe("my-agent");
    const lastReq = transport.getLastRequest("my-agent");
    expect(lastReq?.model).toBe("claude-sonnet-4-6");
    expect(lastReq?.temperature).toBe(0.7);
    expect(lastReq?.steps).toBe(20);
    expect(lastReq?.permission).toEqual({ bash: "allow" });
  });

  // 节点级 model 覆盖 agent config 的 model
  test("节点级 model 覆盖 agent config 的 model", async () => {
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => {
        return { model: "gpt-4", steps: 10, temperature: 0.5, permission: null, knowledge: null };
      },
    });

    const ctx = makeCtx();
    const node = agentNode("test", { agent: "my-agent", model: "claude-opus-4-7" });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("my-agent");
    expect(lastReq?.model).toBe("claude-opus-4-7");
    expect(lastReq?.temperature).toBe(0.5);
    expect(lastReq?.steps).toBe(10);
  });

  // 节点级 temperature 覆盖 agent config
  test("节点级 temperature 覆盖 agent config", async () => {
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => {
        return { model: "gpt-4", steps: 10, temperature: 0.5, permission: null, knowledge: null };
      },
    });

    const ctx = makeCtx();
    const node = agentNode("test", { agent: "my-agent", temperature: 0.1 });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("my-agent");
    expect(lastReq?.temperature).toBe(0.1);
    expect(lastReq?.model).toBe("gpt-4");
  });

  // agent 字段为空时 resolveAgentConfig 不被调用
  test("agent 字段为空时 resolveAgentConfig 不被调用", async () => {
    transport.setResponse("default", { stdout: "ok", exit_code: 0 });
    let called = false;
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => {
        called = true;
        return { model: null, steps: null, temperature: null, permission: null, knowledge: null };
      },
    });

    const ctx = makeCtx();
    const node = agentNode("test");
    await executor.execute(node, ctx);

    expect(called).toBe(false);
    const lastReq = transport.getLastRequest("default");
    expect(lastReq?.model).toBeUndefined();
  });

  // resolveAgentConfig 返回 null 时使用节点字段
  test("resolveAgentConfig 返回 null 时使用节点字段", async () => {
    const executor = new AgentExecutor(transport, {
      resolveAgentConfig: async () => null,
    });

    const ctx = makeCtx();
    const node = agentNode("test", { agent: "my-agent", model: "fallback-model" });
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("my-agent");
    expect(lastReq?.model).toBe("fallback-model");
  });
});
