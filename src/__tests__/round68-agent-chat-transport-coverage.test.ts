import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import type { AgentSession as ChatAgentSession, PromptTurn } from "../services/agent-chat-service";
import { globalInstanceRegistry } from "../services/instance-registry";
import { AgentChatSessionAdapter } from "../services/workflow/agent-chat-transport";
import { acquireInstanceLease, clearInstanceLeases, hasActiveInstanceLease } from "../services/workflow/instance-lease";
import type { InstanceSupplement } from "../types/store";

class MemoryTurn implements PromptTurn {
  prompts: Array<Array<{ type: string; text: string; resource?: unknown }>> = [];

  constructor(private readonly queue: EngineRelayMessage[]) {}

  prompt(content: Array<{ type: string; text: string; resource?: unknown }>): void {
    this.prompts.push(content);
  }

  async *events(): AsyncIterable<EngineRelayMessage> {
    yield* this.queue;
  }

  release(): void {}

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

const instanceId = "instance-round68";

function chatSession(): ChatAgentSession {
  return {
    instanceId,
    dispose: async () => {},
    relayHandle: { state: "open", send: () => {}, close: () => {} },
  };
}

function adapter(events: EngineRelayMessage[]): AgentChatSessionAdapter {
  return new AgentChatSessionAdapter(new MemoryTurn(events), chatSession(), 1_000);
}

function sessionUpdate(update: Record<string, unknown>): EngineRelayMessage {
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

function supplement(): InstanceSupplement {
  return {
    userId: "user-round68",
    organizationId: "org-round68",
    environmentId: "env-round68",
    spawnSource: "system",
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: Date.now(),
  };
}

beforeEach(() => {
  globalInstanceRegistry.clear();
  clearInstanceLeases();
  globalInstanceRegistry.register(instanceId, supplement());
});

afterEach(() => {
  globalInstanceRegistry.clear();
  clearInstanceLeases();
});

describe("AgentChatSessionAdapter 未覆盖消息与清理边界", () => {
  // 顶层 RPC error 缺少 message 时必须返回协议定义的默认错误，不能等待执行超时。
  test("顶层 RPC error 缺少 message 时使用默认错误", async () => {
    const response = await adapter([{ jsonrpc: "2.0", error: {} } as unknown as EngineRelayMessage]).execute({
      prompt: "x",
    });

    expect(response).toMatchObject({ exit_code: 1, stdout: "[Error] Agent execution failed" });
  });

  // result 内嵌 error 缺少 message 时同样要保留此前输出并附加默认错误。
  test("内嵌 RPC error 缺少 message 时保留输出并使用默认错误", async () => {
    const response = await adapter([
      sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "部分输出" } }),
      result({ error: {} }),
    ]).execute({ prompt: "x" });

    expect(response).toMatchObject({ exit_code: 1, stdout: "部分输出\n\n[Error] Agent execution failed" });
  });

  // relay error 未携带 message 时仍返回固定脱敏错误，已收集输出可供业务诊断。
  test("传输 error 缺少 message 时返回脱敏错误", async () => {
    const response = await adapter([
      sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "可恢复结果" } }),
      { type: "error", payload: {} } as unknown as EngineRelayMessage,
    ]).execute({ prompt: "x" });

    expect(response).toMatchObject({ exit_code: 1, stdout: "可恢复结果\n\n[Error] Agent execution failed" });
  });

  // 空文本和无标题工具更新是协议噪声，不得产生空消息；缺省工具状态则使用 unknown。
  test("空更新被忽略且工具缺省状态映射为 unknown", async () => {
    const response = await adapter([
      sessionUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "" } }),
      sessionUpdate({ sessionUpdate: "user_message_chunk", content: { text: "" } }),
      sessionUpdate({ sessionUpdate: "tool_call" }),
      sessionUpdate({ sessionUpdate: "tool_call", title: "搜索" }),
      result({ stopReason: "end_turn" }),
    ]).execute({ prompt: "x" });

    expect(response).toMatchObject({
      exit_code: 0,
      stdout: "",
      messages: [{ role: "tool_call", content: "搜索 (unknown)", tool_name: "搜索" }],
    });
  });

  // usage 部分字段缺失时需稳定补零，避免 workflow 消费端收到 undefined token 数。
  test("部分 usage 缺失字段时补零", async () => {
    const response = await adapter([result({ stopReason: "end_turn", usage: { inputTokens: 3 } })]).execute({
      prompt: "x",
    });

    expect(response.tokens).toEqual({ input: 3, output: 0 });
  });

  // execute 成功后必须移除 abort listener，之后 abort 不能再次释放或改变已完成会话的资源状态。
  test("成功 settle 后 abort 不会重复清理 relay 或租约", async () => {
    acquireInstanceLease(instanceId);
    const controller = new AbortController();

    await adapter([result({ stopReason: "end_turn" })]).execute({ prompt: "x", signal: controller.signal });
    controller.abort();

    expect(hasActiveInstanceLease(instanceId)).toBe(false);
    expect(globalInstanceRegistry.get(instanceId)?.relayCount).toBe(0);
  });
});
