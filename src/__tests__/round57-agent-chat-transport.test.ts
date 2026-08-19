import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import { markInstanceRelayAttached } from "../services/acp-idle-monitor";
import {
  type AgentSession as ChatAgentSession,
  createPromptTurn,
  type PromptTurn,
} from "../services/agent-chat-service";
import { globalInstanceRegistry } from "../services/instance-registry";
import { AgentChatSessionAdapter, createAgentChatTransport } from "../services/workflow/agent-chat-transport";
import { clearInstanceLeases, hasActiveInstanceLease } from "../services/workflow/instance-lease";
import type { InstanceSupplement } from "../types/store";

class MemoryTurn implements PromptTurn {
  prompts: Array<Array<{ type: string; text: string; resource?: unknown }>> = [];
  released = 0;
  private readonly eventsQueue: EngineRelayMessage[];
  private readonly thrown: Error | undefined;

  constructor(events: EngineRelayMessage[] = [], thrown?: Error) {
    this.eventsQueue = events;
    this.thrown = thrown;
  }

  prompt(content: Array<{ type: string; text: string; resource?: unknown }>): void {
    this.prompts.push(content);
  }

  async *events(): AsyncIterable<EngineRelayMessage> {
    if (this.thrown) throw this.thrown;
    yield* this.eventsQueue;
  }

  release(): void {
    this.released += 1;
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

function message(update: Record<string, unknown>): EngineRelayMessage {
  return {
    type: "session_update",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: { update },
    },
  } as unknown as EngineRelayMessage;
}

function result(payload: Record<string, unknown>): EngineRelayMessage {
  return { jsonrpc: "2.0", result: payload } as unknown as EngineRelayMessage;
}

function chatSession(instanceId = "instance-round57"): ChatAgentSession {
  return {
    instanceId,
    dispose: async () => {},
    relayHandle: { state: "open", send: () => {}, close: () => {} },
  };
}

function supplement(): InstanceSupplement {
  return {
    userId: "user-round57",
    organizationId: "org-round57",
    environmentId: "env-round57",
    instanceNumber: 1,
    spawnSource: "system",
    lastActivityAt: Date.now() - 1_000,
    relayCount: 0,
    lastRelayDetachedAt: Date.now() - 1_000,
  };
}

function adapter(
  events: EngineRelayMessage[] = [],
  thrown?: Error,
): { turn: MemoryTurn; session: AgentChatSessionAdapter } {
  const turn = new MemoryTurn(events, thrown);
  return { turn, session: new AgentChatSessionAdapter(turn, chatSession(), 1_000) };
}

beforeEach(() => {
  globalInstanceRegistry.clear();
  clearInstanceLeases();
  globalInstanceRegistry.register("instance-round57", supplement());
});

afterEach(() => {
  globalInstanceRegistry.clear();
  clearInstanceLeases();
});

describe("round57 AgentChatTransport 内存链路", () => {
  // 工厂必须返回始终就绪的 Transport，供 workflow 在组织上下文中直接使用。
  test("工厂创建的 Transport 报告 ready", () => {
    expect(createAgentChatTransport("org-round57").isReady()).toBe(true);
  });

  // execute 必须把 workflow prompt 原样转换为 ACP text content。
  test("请求 prompt 转换为单个 text content", async () => {
    const { turn, session } = adapter([result({ stopReason: "end_turn" })]);

    await session.execute({ prompt: "请总结变更" });

    expect(turn.prompts).toEqual([[{ type: "text", text: "请总结变更" }]]);
  });

  // 原始 JSON-RPC result 是完成信号，成功时应返回零退出码。
  test("原始 result 完成会话并返回成功", async () => {
    const { session } = adapter([result({ stopReason: "end_turn" })]);

    const response = await session.execute({ prompt: "x" });

    expect(response.exit_code).toBe(0);
    expect(response.stdout).toBe("");
  });

  // 包裹的 session/update 中 assistant chunk 要累积到 stdout 和 messages。
  test("assistant 文本块按到达顺序累积", async () => {
    const { session } = adapter([
      message({ sessionUpdate: "agent_message_chunk", content: { text: "你好，" } }),
      message({ sessionUpdate: "agent_message_chunk", content: { text: "世界" } }),
      result({ stopReason: "end_turn" }),
    ]);

    const response = await session.execute({ prompt: "x" });

    expect(response.stdout).toBe("你好，世界");
    expect(response.messages).toEqual([
      { role: "assistant", content: "你好，" },
      { role: "assistant", content: "世界" },
    ]);
  });

  // user chunk 是审计消息，不得混入 agent stdout。
  test("user 文本块只进入 user messages", async () => {
    const { session } = adapter([
      message({ sessionUpdate: "user_message_chunk", content: { text: "用户补充" } }),
      result({ stopReason: "end_turn" }),
    ]);

    const response = await session.execute({ prompt: "x" });

    expect(response.stdout).toBe("");
    expect(response.messages).toEqual([{ role: "user", content: "用户补充" }]);
  });

  // 工具调用需保留名称、状态和结构化 tool_name，供 workflow 消费。
  test("tool_call 转换为工具消息", async () => {
    const { session } = adapter([
      message({ sessionUpdate: "tool_call", title: "读取文件", status: "completed" }),
      result({ stopReason: "end_turn" }),
    ]);

    const response = await session.execute({ prompt: "x" });

    expect(response.messages).toEqual([{ role: "tool_call", content: "读取文件 (completed)", tool_name: "读取文件" }]);
  });

  // 未知 update 不能污染输出或导致会话失败。
  test("未知 session update 被安全忽略", async () => {
    const { session } = adapter([
      message({ sessionUpdate: "progress", percent: 50 }),
      result({ stopReason: "end_turn" }),
    ]);

    const response = await session.execute({ prompt: "x" });

    expect(response).toMatchObject({ exit_code: 0, stdout: "", messages: [] });
  });

  // 非 JSON-RPC 的状态帧只用于活跃度观测，不得改变业务响应。
  test("非 JSON-RPC 状态帧被跳过", async () => {
    const { session } = adapter([
      { type: "status", payload: { state: "working" } },
      result({ stopReason: "end_turn" }),
    ]);

    await expect(session.execute({ prompt: "x" })).resolves.toMatchObject({ exit_code: 0, stdout: "" });
  });

  // usage 的输入和输出 token 应按 workflow 响应协议映射。
  test("usage 转换为 input 与 output tokens", async () => {
    const { session } = adapter([result({ stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 11 } })]);

    await expect(session.execute({ prompt: "x" })).resolves.toMatchObject({ tokens: { input: 7, output: 11 } });
  });

  // 顶层 JSON-RPC error 必须即时变为失败，不可等待超时。
  test("顶层 JSON-RPC error 转换为失败响应", async () => {
    const { session } = adapter([{ jsonrpc: "2.0", error: { message: "权限拒绝" } } as unknown as EngineRelayMessage]);

    await expect(session.execute({ prompt: "x" })).resolves.toMatchObject({ exit_code: 1, stdout: "[Error] 权限拒绝" });
  });

  // result 内嵌 error 同样是 Agent 失败，且前序输出必须保留。
  test("result 内嵌 error 保留部分输出", async () => {
    const { session } = adapter([
      message({ sessionUpdate: "agent_message_chunk", content: { text: "部分结果" } }),
      result({ error: { message: "工具失败" } }),
    ]);

    await expect(session.execute({ prompt: "x" })).resolves.toMatchObject({
      exit_code: 1,
      stdout: "部分结果\n\n[Error] 工具失败",
    });
  });

  // error stop reason 表示协议级失败，即使没有 error 对象也不能报告成功。
  test("error stop reason 返回失败退出码", async () => {
    const { session } = adapter([result({ stopReason: "error" })]);

    await expect(session.execute({ prompt: "x" })).resolves.toMatchObject({
      exit_code: 1,
      stdout: "Agent returned error stop reason",
    });
  });

  // 传输层 error 应带上已经生成的文本，方便节点重试前诊断。
  test("传输层 error 保留已有 stdout", async () => {
    const { session } = adapter([
      message({ sessionUpdate: "agent_message_chunk", content: { text: "已输出" } }),
      { type: "error", payload: { message: "relay 故障" } },
    ]);

    await expect(session.execute({ prompt: "x" })).resolves.toMatchObject({
      exit_code: 1,
      stdout: "已输出\n\n[Error] relay 故障",
    });
  });

  // 事件流无 completion 即结束时，已有内容仍是可用的正常响应。
  test("事件流自然结束返回已收集输出", async () => {
    const { session } = adapter([message({ sessionUpdate: "agent_message_chunk", content: { text: "收尾文本" } })]);

    await expect(session.execute({ prompt: "x" })).resolves.toMatchObject({ exit_code: 0, stdout: "收尾文本" });
  });

  // AbortSignal 必须取消挂起执行，并释放此前由 connect 占用的租约。
  test("取消执行拒绝 AbortError 并释放租约", async () => {
    const turn: PromptTurn = {
      prompt: () => {},
      events: async function* () {
        await new Promise(() => {});
      },
      release: () => {},
      dispose: async () => {},
    };
    const controller = new AbortController();
    const session = new AgentChatSessionAdapter(turn, chatSession(), 1_000);
    markInstanceRelayAttached("instance-round57");
    const { acquireInstanceLease } = await import("../services/workflow/instance-lease");
    acquireInstanceLease("instance-round57");

    const pending = session.execute({ prompt: "x", signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(hasActiveInstanceLease("instance-round57")).toBe(false);
    expect(globalInstanceRegistry.get("instance-round57")?.relayCount).toBe(0);
  });

  // dispose 仅释放本 turn 的 listener，不能关闭共享 relay 或影响其它用户会话。
  test("dispose 只调用 turn.release", async () => {
    const { turn, session } = adapter();

    await session.dispose();

    expect(turn.released).toBe(1);
  });

  // 真实 PromptTurn 过滤器必须隔离不同 session 的 update，避免组织或用户间消息串流。
  test("真实 PromptTurn 按 sessionId 隔离其他用户消息", async () => {
    let listener: ((event: EngineRelayMessage) => void) | undefined;
    const session: ChatAgentSession = {
      instanceId: "instance-round57",
      dispose: async () => {},
      relayHandle: {
        state: "open",
        send: () => {},
        close: () => {},
        onMessage: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      } as ChatAgentSession["relayHandle"],
    };
    const turn = createPromptTurn(session, "session-user-a");
    const iterator = turn.events()[Symbol.asyncIterator]();
    const next = iterator.next();

    listener?.({
      type: "session_update",
      payload: {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "session-user-b", update: { sessionUpdate: "agent_message_chunk" } },
      },
    } as unknown as EngineRelayMessage);
    listener?.({
      type: "session_update",
      payload: {
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "session-user-a", update: { sessionUpdate: "agent_message_chunk" } },
      },
    } as unknown as EngineRelayMessage);

    await expect(next).resolves.toMatchObject({ value: { payload: { params: { sessionId: "session-user-a" } } } });
    await iterator.return?.();
    turn.release();
  });
});
