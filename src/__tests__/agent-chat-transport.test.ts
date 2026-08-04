/**
 * AgentChatSessionAdapter 测试 — 验证 execute() 的超时兜底、relay_closed 处理
 * 与 idle/activity 观测埋点（C-P1.3 / C-P1.4）。
 *
 * 背景（C-P1.3）：execute() 超时兜底原先只置 settled 标志不 settle Promise，
 * relay_closed 消息被 extractJsonRpc 判空后 continue 跳过，两种场景都会导致
 * workflow 节点永久挂起。本测试用 FakeTurn 直接驱动事件流，验证修复后的
 * 有界失败（NODE_TIMEOUT）与明确失败（relay_closed → exit_code=1）。
 *
 * 背景（C-P1.4）：Workflow 路径全程不产生 idle/activity 观测信号（relayCount 恒 0、
 * 无 touchInstanceActivity 埋点），长任务被 idle/activity 回收误杀。修复在
 * agent-chat-transport 埋点：connect attach、execute settle 出口 detach、
 * iterateEvents 逐条 touch。本测试通过 globalInstanceRegistry 直连 supplement
 * 断言埋点效果（不 mock 模块）。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import { WorkflowErrorCode } from "@fenix/workflow-engine";
import { markInstanceRelayAttached } from "../services/acp-idle-monitor";
import {
  type AgentSession as ChatAgentSession,
  createPromptTurn,
  type PromptTurn,
} from "../services/agent-chat-service";
import { globalInstanceRegistry } from "../services/instance-registry";
import { AgentChatSessionAdapter } from "../services/workflow/agent-chat-transport";
import type { InstanceSupplement } from "../types/store";

// ---------- 测试专用 FakeTurn ----------

/** 测试专用 PromptTurn：消息可手动 push，未结束且队列为空时挂起 */
class FakeTurn implements PromptTurn {
  promptCalls = 0;
  private queue: EngineRelayMessage[] = [];
  private ended = false;
  private failure: Error | null = null;
  private waiters: Array<() => void> = [];

  prompt(): void {
    this.promptCalls++;
  }

  /** 向事件流推送一条消息（迭代器挂起等待时立即唤醒） */
  push(msg: EngineRelayMessage): void {
    this.queue.push(msg);
    this.waiters.shift()?.();
  }

  /** 让事件流立即抛出错误（模拟传输层异常） */
  fail(err: Error): void {
    this.failure = err;
    this.waiters.shift()?.();
  }

  /** 结束事件流（模拟正常收尾） */
  end(): void {
    this.ended = true;
    this.waiters.shift()?.();
  }

  async *events(): AsyncIterable<EngineRelayMessage> {
    while (true) {
      if (this.failure) throw this.failure;
      const msg = this.queue.shift();
      if (msg) {
        yield msg;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** PromptTurn 接口要求；本测试不验证 dispose 语义 */
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/** 按 EngineRelayHandle 最小字段构造 chat AgentSession（Adapter 取 instanceId 字段） */
function makeFakeChatSession(): ChatAgentSession {
  return {
    relayHandle: {
      state: "open",
      send: () => {},
      close: () => {},
    },
    instanceId: "inst-test",
    dispose: async () => {},
  };
}

/** 构造已注册的 supplement（模拟 registerSupplement 后的状态） */
function makeSupplement(overrides: Partial<InstanceSupplement> = {}): InstanceSupplement {
  return {
    userId: "user-1",
    environmentId: "env-1",
    instanceNumber: 1,
    organizationId: "org-1",
    spawnSource: "system",
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: Date.now(),
    ...overrides,
  };
}

// 空闲观察起点：早于所有用例执行时刻的固定基准，用于断言"埋点是否发生"
const IDLE_SINCE_BASELINE = Date.now() - 60_000;

// ---------- 测试 ----------

describe("AgentChatSessionAdapter", () => {
  beforeEach(() => {
    globalInstanceRegistry.clear();
    // 模拟 spawn 后 60s 无任何观测信号的 supplement（C-P1.4 受害场景的初始状态）
    globalInstanceRegistry.register(
      "inst-test",
      makeSupplement({ lastActivityAt: IDLE_SINCE_BASELINE, lastRelayDetachedAt: IDLE_SINCE_BASELINE }),
    );
  });

  // 超时兜底：事件流挂起且无 abort 时，timeoutMs 到点后 Promise 必须 settle 为
  // NODE_TIMEOUT，而不是静默置位导致节点永久挂起
  test("事件流挂起超时 → reject WorkflowError(NODE_TIMEOUT)", async () => {
    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 50);

    const promise = adapter.execute({ prompt: "x" });

    await expect(promise).rejects.toMatchObject({
      name: "WorkflowError",
      code: WorkflowErrorCode.NODE_TIMEOUT,
    });
  });

  // relay_closed（实例回收/手动停止/机器断连）必须被识别为明确失败，
  // 否则事件流永久挂起且无任何失败信号
  test("relay_closed 到达 → 明确失败 exit_code=1", async () => {
    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 1000);

    const promise = adapter.execute({ prompt: "x" });
    turn.push({ type: "relay_closed", payload: { code: "relay_disconnected" } });

    const result = await promise;
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toContain("Agent connection closed (relay_disconnected)");
  });

  // relay_closed 前已产生的部分输出不得丢失，应保留并追加 [Error] 段
  test("先有部分输出再收到 relay_closed → stdout 保留已有文本 + [Error] 段", async () => {
    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 1000);

    const promise = adapter.execute({ prompt: "x" });
    turn.push({
      type: "session_update",
      payload: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { text: "hello" } },
        },
      },
    });
    turn.push({ type: "relay_closed", payload: { code: "relay_error" } });

    const result = await promise;
    expect(result.exit_code).toBe(1);
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("[Error] Agent connection closed (relay_error)");
  });

  // 可达性回归：FakeTurn 直接 push 会绕过 createPromptTurn 的 isTurnMessage 过滤层，
  // 无法证明 relay_closed 在生产链路可达（此前无 jsonrpc 字段的消息在事件源层被丢弃，
  // 导致节点只能挂起到兜底超时）。这里用真实 createPromptTurn + 真实 onMessage 分发验证。
  test("relay_closed 经 createPromptTurn 过滤层到达事件流（可达性回归）", async () => {
    let listener: ((msg: EngineRelayMessage) => void) | null = null;
    const session: ChatAgentSession = {
      instanceId: "inst-test",
      dispose: async () => {},
      relayHandle: {
        state: "open",
        send: () => {},
        close: () => {},
        onMessage: (l: (msg: EngineRelayMessage) => void) => {
          listener = l;
          return () => {
            listener = null;
          };
        },
      } as ChatAgentSession["relayHandle"],
    };
    const turn = createPromptTurn(session, "ses-test");
    const iterator = turn.events()[Symbol.asyncIterator]();
    const pending = iterator.next();
    // createPromptTurn 构造时同步调用 onMessage 注册监听器，此处 listener 必已赋值
    listener!({ type: "relay_closed", payload: { code: "relay_disconnected" } } as EngineRelayMessage);

    const { value } = await pending;
    expect(value).toMatchObject({ type: "relay_closed", payload: { code: "relay_disconnected" } });
    await iterator.return?.();
  });

  // 回归：正常 session/prompt 响应（result）必须照常 settle 为成功
  test("正常 session/prompt 响应 → exit_code=0 且 settle（回归）", async () => {
    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 1000);

    const promise = adapter.execute({ prompt: "x" });
    turn.push({
      jsonrpc: "2.0",
      result: { stopReason: "end_turn", usage: { totalTokens: 10 } },
    } as unknown as EngineRelayMessage);

    const result = await promise;
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.tokens).toEqual({ input: 0, output: 0 });
  });

  // 回归：节点级 abort（timeout ≤ 兜底时长时先触发）仍 reject AbortError
  test("AbortSignal 触发 → reject AbortError（回归）", async () => {
    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 1000);
    const controller = new AbortController();

    const promise = adapter.execute({ prompt: "x", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  // 兜底 settle 后 abort 到达：settled 保护必须吞掉 abort 分支，
  // 不能产生未处理 rejection 或二次 settle
  test("超时 settle 后 abort 触发 → 不产生未处理 rejection", async () => {
    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 50);
    const controller = new AbortController();

    const promise = adapter.execute({ prompt: "x", signal: controller.signal });
    await expect(promise).rejects.toMatchObject({
      name: "WorkflowError",
      code: WorkflowErrorCode.NODE_TIMEOUT,
    });

    controller.abort();
  });

  // C-P1.4：workflow 消费业务消息时更新实例活跃时间，
  // 长任务不会因 activity 硬超时被误杀
  test("业务消息 → lastActivityAt 前进（activity 硬超时不被触发）", async () => {
    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 1000);

    const promise = adapter.execute({ prompt: "x" });
    turn.push({
      type: "session_update",
      payload: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } },
        },
      },
    });
    turn.end();

    const result = await promise;
    expect(result.exit_code).toBe(0);
    // 消息处理时 touch 必然晚于 IDLE_SINCE_BASELINE，埋点生效则断言通过
    expect(globalInstanceRegistry.get("inst-test")?.lastActivityAt).toBeGreaterThan(IDLE_SINCE_BASELINE);
  });

  // C-P1.4：保活消息不计入业务活跃，卡死实例仍保留 activity 硬超时兜底回收出口
  test("仅保活消息 → lastActivityAt 不变", async () => {
    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 1000);

    const promise = adapter.execute({ prompt: "x" });
    turn.push({ type: "keep_alive" });
    turn.end();

    await promise;
    expect(globalInstanceRegistry.get("inst-test")?.lastActivityAt).toBe(IDLE_SINCE_BASELINE);
  });

  // C-P1.4：run 正常结束后 relay 引用计数归零并重新开始 idle 观察窗口
  test("正常结束 → relayCount 归零、lastRelayDetachedAt 重新记录", async () => {
    // 模拟 connect() 的 attach：run 期间 relayCount=1 阻止 idle 回收
    markInstanceRelayAttached("inst-test");
    expect(globalInstanceRegistry.get("inst-test")?.relayCount).toBe(1);

    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 1000);
    const promise = adapter.execute({ prompt: "x" });
    turn.push({ jsonrpc: "2.0", result: { stopReason: "end_turn" } } as unknown as EngineRelayMessage);
    await promise;

    const supplement = globalInstanceRegistry.get("inst-test");
    expect(supplement?.relayCount).toBe(0);
    expect(supplement?.lastRelayDetachedAt).not.toBeNull();
  });

  // C-P1.4：事件流抛错时引用计数同样释放，失败路径不泄漏 relay 计数
  test("事件流抛错 → reject 且 relayCount 归零", async () => {
    markInstanceRelayAttached("inst-test");

    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 1000);
    const promise = adapter.execute({ prompt: "x" });
    turn.fail(new Error("relay stream broken"));

    await expect(promise).rejects.toThrow("relay stream broken");
    expect(globalInstanceRegistry.get("inst-test")?.relayCount).toBe(0);
  });

  // C-P1.4：执行超时兜底触发后引用计数释放，超时实例不残留 relay 计数
  test("执行超时 → relayCount 归零", async () => {
    markInstanceRelayAttached("inst-test");

    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 30);
    const promise = adapter.execute({ prompt: "x" });

    await expect(promise).rejects.toMatchObject({
      name: "WorkflowError",
      code: WorkflowErrorCode.NODE_TIMEOUT,
    });
    expect(globalInstanceRegistry.get("inst-test")?.relayCount).toBe(0);
  });

  // C-P1.4：无 jsonrpc 无 type 的异常消息不中断 execute。其会被保守计为业务活跃
  //（shouldCountInstanceActivity 对未知 type 计数，与 yjs-frontend 路径一致），
  // 但不会破坏事件流解析
  test("异常消息（{}）→ execute 正常结束", async () => {
    const turn = new FakeTurn();
    const adapter = new AgentChatSessionAdapter(turn, makeFakeChatSession(), 1000);

    const promise = adapter.execute({ prompt: "x" });
    turn.push({} as unknown as EngineRelayMessage);
    turn.end();

    const result = await promise;
    expect(result.exit_code).toBe(0);
  });
});
