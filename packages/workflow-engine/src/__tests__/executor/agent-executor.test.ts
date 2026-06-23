/**
 * AgentExecutor 测试 — 使用 FakeTransport 验证 Agent 节点执行逻辑。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { AgentExecutor } from "../../executor/agent-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { AgentRequest, AgentResponse, AgentSession, Transport } from "../../transport/transport";
import type { AgentNodeDef } from "../../types/dag";
import { WorkflowError } from "../../types/errors";

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

/** 创建 agent 节点定义（agent 字段为 required） */
function agentNode(prompt: string, overrides?: Partial<AgentNodeDef>): AgentNodeDef {
  return {
    id: "test-agent",
    type: "agent",
    agent: "default",
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
      messages: [],
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
      messages: [],
    });

    const ctx = makeCtx();
    const node = agentNode("Do something", { agent: "my-agent" });
    const output = await executor.execute(node, ctx);

    expect(output.stdout).toBe("Agent response");
    expect(transport.getConnectedAgents().has("my-agent")).toBe(true);
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
    const node = agentNode("No response configured", { agent: "unknown" });

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
    transport.setResponse("default", { stdout: "ok", exit_code: 0, messages: [] });

    const ctx = makeCtx();
    const node = agentNode("test");
    await executor.execute(node, ctx);

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-agent" });
    const startedEvents = events.filter((e) => e.type === "node.started");
    expect(startedEvents.length).toBe(1);
  });

  // node.completed 事件
  test("成功执行产生 node.completed 事件", async () => {
    transport.setResponse("default", { stdout: "done", exit_code: 0, messages: [] });

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
      messages: [],
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
    transport.setResponse("default", { stdout: "err", exit_code: 1, messages: [] });

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
      messages: [],
    });

    const ctx = makeCtx({
      params: { topic: "world" },
      resolvedInputs: { prompt: "Tell me about world" },
    });
    const node = agentNode("Tell me about ${{ params.topic }}");
    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("default");
    expect(lastReq?.prompt).toBe("Tell me about world");
  });

  // resolvedInputs.agent 注入到连接目标
  test("resolvedInputs.agent 注入到连接目标", async () => {
    transport.setResponse("resolved-agent", {
      stdout: "ok",
      exit_code: 0,
      messages: [],
    });

    const ctx = makeCtx({
      resolvedInputs: {
        prompt: "test",
        agent: "resolved-agent",
      },
    });
    const node = agentNode("test", { agent: "original-agent" });
    await executor.execute(node, ctx);

    expect(transport.getConnectedAgents().has("resolved-agent")).toBe(true);
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
    const node = agentNode("always fail", { agent: "no-response" });

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
      agent: "no-response",
      retry: { count: 1, delay: 50, backoff: "fixed" },
    });

    await expect(executor.execute(node, ctx)).rejects.toThrow();

    const events = await ctx.storage.getEvents(ctx.runId, { nodeId: "test-agent" });
    const retryEvents = events.filter((e) => e.type === "node.retrying");
    expect(retryEvents.length).toBe(1);
  });

  // 重试成功：前两次失败，第三次成功
  test("重试成功：前两次失败、第三次成功 → COMPLETED", async () => {
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
    customTransport.setResponse("default", { stdout: "ok", exit_code: 0, messages: [] });

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
      messages: [],
    });

    const executor = new AgentExecutor(transport);
    const ctx = makeCtx();
    const node = agentNode("json test");

    const output = await executor.execute(node, ctx);
    expect(output.json).toEqual({ result: "success" });
  });

  test("stdout 非法 JSON 时 json 包含简化会话流结构", async () => {
    const transport = new FakeTransport();
    transport.setResponse("default", {
      stdout: "plain text",
      exit_code: 0,
      messages: [],
    });

    const executor = new AgentExecutor(transport);
    const ctx = makeCtx();
    const node = agentNode("text test");

    const output = await executor.execute(node, ctx);
    expect((output.json as Record<string, unknown>)?.simplified).toBe("plain text");
  });
});

// ========== 会话流收集测试 ==========

describe("AgentExecutor message stream", () => {
  test("AgentResponse.messages 被收集到 json 输出", async () => {
    const transport = new FakeTransport();
    transport.setResponse("default", {
      stdout: "Here is the answer",
      exit_code: 0,
      messages: [
        { role: "assistant", content: "Let me think..." },
        { role: "tool_call", content: "reading file", tool_name: "read_file" },
        { role: "tool_result", content: "file contents", tool_name: "read_file" },
        { role: "assistant", content: "Here is the answer" },
      ],
    });

    const executor = new AgentExecutor(transport);
    const ctx = makeCtx();
    const node = agentNode("test");

    const output = await executor.execute(node, ctx);
    const json = output.json as Record<string, unknown>;
    expect(json.simplified).toBe("Here is the answer");
    const messages = json.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(4);
    expect(messages[1].role).toBe("tool_call");
    expect(messages[1].tool_name).toBe("read_file");
  });

  test("output_messages 参数控制回传的消息数", async () => {
    const transport = new FakeTransport();
    transport.setResponse("default", {
      stdout: "result",
      exit_code: 0,
      messages: [
        { role: "assistant", content: "msg1" },
        { role: "assistant", content: "msg2" },
        { role: "assistant", content: "msg3" },
      ],
    });

    const executor = new AgentExecutor(transport);
    const ctx = makeCtx();
    const node = agentNode("test", { output_messages: 2 });

    const output = await executor.execute(node, ctx);
    const json = output.json as Record<string, unknown>;
    const lastMessages = json.last_messages as Array<Record<string, unknown>>;
    expect(lastMessages.length).toBe(2);
    expect(lastMessages[0].content).toBe("msg2");
    expect(lastMessages[1].content).toBe("msg3");
  });

  test("output_messages 为 0 时不回传 last_messages", async () => {
    const transport = new FakeTransport();
    transport.setResponse("default", {
      stdout: "result",
      exit_code: 0,
      messages: [{ role: "assistant", content: "msg1" }],
    });

    const executor = new AgentExecutor(transport);
    const ctx = makeCtx();
    const node = agentNode("test", { output_messages: 0 });

    const output = await executor.execute(node, ctx);
    const json = output.json as Record<string, unknown>;
    expect(json.last_messages).toBeUndefined();
    expect(json.messages).toBeDefined();
  });
});

// ========== 请求参数测试 ==========

describe("AgentExecutor request", () => {
  test("AgentRequest 只包含 prompt 和 signal", async () => {
    const transport = new FakeTransport();
    transport.setResponse("default", { stdout: "ok", exit_code: 0, messages: [] });

    const executor = new AgentExecutor(transport);
    const ctx = makeCtx();
    const node = agentNode("test prompt");

    await executor.execute(node, ctx);

    const lastReq = transport.getLastRequest("default");
    expect(lastReq?.prompt).toBe("test prompt");
    expect(lastReq?.signal).toBeDefined();
    // 不再有 agent/skill/model/temperature/steps 字段
    expect((lastReq as Record<string, unknown>)?.agent).toBeUndefined();
    expect((lastReq as Record<string, unknown>)?.skill).toBeUndefined();
    expect((lastReq as Record<string, unknown>)?.model).toBeUndefined();
  });
});
