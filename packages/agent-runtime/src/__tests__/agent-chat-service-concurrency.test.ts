/**
 * agent-chat-service 并发隔离测试（C-P1.2）。
 *
 * 覆盖「同实例共享同一 relay handle」场景：relay 对同一实例的所有监听器
 * 全量 fan-out（无按会话路由），并发 run 的 session/new 握手与事件流必须
 * 通过唯一 rpcId / turnId + 按 sessionId/turnId 过滤实现隔离。
 *
 * 使用纯 fake relay handle（模拟 plugin-opencode relay-handle 的
 * fan-out 广播与首个监听器注册时缓冲回放），不碰 DB、不用 mock.module。
 */
import { describe, expect, test } from "bun:test";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { createAgentSession, createPromptTurn, startPromptTurn } from "../services/agent-chat-service";

/** 模拟 relay-handle 的 sent 消息（JSON-RPC 请求） */
interface SentRpc {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: { sessionId?: string };
}

/**
 * 构造 fake relay handle：模拟 plugin-opencode relay-handle 的行为
 * （全量 fan-out 广播 + 首个监听器注册时回放缓冲）。
 * session/new 按请求 id 回显 ses_A / ses_B（模拟 acp-link 修复后的行为）。
 */
function createFakeRelayHandle() {
  const listeners = new Set<(msg: unknown) => void>();
  const buffer: unknown[] = [];
  let hasListeners = false;
  const sent: unknown[] = [];
  let sessionNewCount = 0;

  const broadcast = (msg: unknown) => {
    if (!hasListeners) {
      buffer.push(msg);
      return;
    }
    for (const l of listeners) l(msg);
  };

  const handle: EngineRelayHandle = {
    state: "open",
    ready: Promise.resolve(),
    close: async () => {},
    send: (msg) => {
      sent.push(msg);
      const m = msg as unknown as { method?: string };
      if (m.method === "session/new") {
        sessionNewCount += 1;
        const sid = sessionNewCount === 1 ? "ses_A" : "ses_B";
        broadcast({
          jsonrpc: "2.0",
          id: (msg as unknown as { id?: number }).id,
          result: { sessionId: sid },
        } as unknown as EngineRelayMessage);
      }
    },
    onMessage(listener) {
      listeners.add(listener as unknown as (msg: unknown) => void);
      const wasEmpty = !hasListeners;
      hasListeners = true;
      if (wasEmpty) {
        for (const m of buffer.splice(0)) {
          for (const l of listeners) l(m);
        }
      }
      return () => {
        listeners.delete(listener as unknown as (msg: unknown) => void);
        hasListeners = listeners.size > 0;
      };
    },
  };

  return { handle, sent, broadcast };
}

type FakeRelay = ReturnType<typeof createFakeRelayHandle>;

/** 从 sent 中提取 session/prompt 请求 */
function promptRequests(relay: FakeRelay): SentRpc[] {
  return relay.sent.filter((m) => (m as SentRpc).method === "session/prompt") as SentRpc[];
}

/** 从 sent 中提取 session/prompt 请求携带的 sessionId（顺序即发送顺序） */
function promptSessionIds(relay: FakeRelay): string[] {
  return promptRequests(relay).map((m) => m.params?.sessionId ?? "");
}

/** 短等待：用于断言「不应收到」的场景（返回 "timeout"） */
function sleep(ms: number): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

/** 基于共享 fake relay handle 创建 AgentSession（模拟 connectRelay 复用的共享 handle） */
function makeSession(handle: EngineRelayHandle) {
  return createAgentSession({ relayHandle: handle, instanceId: "inst" });
}

/** 并发启动两个 startPromptTurn 并各自发送 prompt，返回两个 run */
async function startTwoTurns(relay: FakeRelay) {
  const [ra, rb] = await Promise.all([
    startPromptTurn({ session: makeSession(relay.handle) }),
    startPromptTurn({ session: makeSession(relay.handle) }),
  ]);
  ra.turn.prompt([{ type: "text", text: "a" }]);
  rb.turn.prompt([{ type: "text", text: "b" }]);
  return { ra, rb };
}

describe("并发 startPromptTurn 共享同一 relay handle", () => {
  // 修复前 rpcId 恒为 -1：两个 run 的握手响应互相满足，都拿到先到者的 sessionId
  test("并发两个 startPromptTurn 各自拿到自己的 sessionId", async () => {
    const relay = createFakeRelayHandle();
    const { ra, rb } = await startTwoTurns(relay);
    expect(ra.turn).toBeDefined();
    expect(rb.turn).toBeDefined();
    const ids = promptSessionIds(relay);
    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining(["ses_A", "ses_B"]));
  });

  // 唯一 rpcId 是握手隔离的基础；固定 -1 会让所有并发 run 共享同一响应
  test("并发两个 startPromptTurn 的 rpcId 互不相同且不为 -1", async () => {
    const relay = createFakeRelayHandle();
    await startTwoTurns(relay);
    const newReqs = relay.sent.filter((m) => (m as SentRpc).method === "session/new") as SentRpc[];
    expect(newReqs).toHaveLength(2);
    for (const req of newReqs) {
      expect(req.id).toBeDefined();
      expect(req.id).not.toBe(-1);
    }
    expect(newReqs[0].id).not.toBe(newReqs[1].id);
  });
});

describe("PromptTurn turnId", () => {
  // 修复前 turnId 用 Date.now()：同毫秒并发的 turn 请求 id 碰撞，prompt 响应误匹配
  test("连续创建两个 PromptTurn 的 turnId 互不相同", () => {
    const relay = createFakeRelayHandle();
    const session = makeSession(relay.handle);
    const t1 = createPromptTurn(session, "ses_1");
    const t2 = createPromptTurn(session, "ses_2");
    t1.prompt([{ type: "text", text: "a" }]);
    t2.prompt([{ type: "text", text: "b" }]);
    const ids = promptRequests(relay).map((m) => m.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("事件流隔离", () => {
  // relay 全量 fan-out：他 turn 的 update 也会到达本 turn 监听器，必须按 sessionId 丢弃
  test("注入他 turn 的 session/update 不进本 turn 队列", async () => {
    const relay = createFakeRelayHandle();
    const { ra, rb } = await startTwoTurns(relay);
    const [sidA, sidB] = promptSessionIds(relay);
    expect(sidA).not.toBe(sidB);

    // 广播属于 run B 的 update
    relay.broadcast({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sidB,
        update: { sessionUpdate: "agent_message_chunk", content: { text: "b-text" } },
      },
    });

    // run A 的事件流不应收到（修复前会全量入队）
    const aIt = ra.turn.events()[Symbol.asyncIterator]();
    const aWinner = await Promise.race([aIt.next().then(() => "msg"), sleep(30)]);
    expect(aWinner).toBe("timeout");

    // run B 的事件流收到自己的 update
    const bIt = rb.turn.events()[Symbol.asyncIterator]();
    const bWinner = await Promise.race([bIt.next().then(() => "msg"), sleep(30)]);
    expect(bWinner).toBe("msg");
  });

  // 他 turn 的 prompt 响应不能结束本 turn（修复前 iterateEvents 取第一个 result 即结束）
  test("注入他 turn 的 prompt 响应不结束本 turn", async () => {
    const relay = createFakeRelayHandle();
    const { ra } = await startTwoTurns(relay);
    const [reqA, reqB] = promptRequests(relay);
    const idA = reqA.id!;
    const idB = reqB.id!;
    expect(idA).not.toBe(idB);

    // 广播属于 run B 的完成响应
    relay.broadcast({ jsonrpc: "2.0", id: idB, result: { stopReason: "end_turn", content: [] } });

    // run A 的事件流不应被 B 的响应结束（pending 的 next 保持未完成）
    const aIt = ra.turn.events()[Symbol.asyncIterator]();
    const pendingA = aIt.next();
    const aWinner = await Promise.race([pendingA.then(() => "msg"), sleep(30)]);
    expect(aWinner).toBe("timeout");

    // A 自己的响应到达后，同一个 pending next 才 resolve 且拿到本 turn 的响应
    relay.broadcast({ jsonrpc: "2.0", id: idA, result: { stopReason: "end_turn", content: [] } });
    const aResult = await Promise.race([pendingA, sleep(30)]);
    expect((aResult as { value?: { jsonrpc?: string } }).value?.jsonrpc).toBe("2.0");
  });

  // 传输层 error 与 JSON-RPC 无关，任何 run 都应感知
  test("传输层 error 消息对两个并发 turn 都保留", async () => {
    const relay = createFakeRelayHandle();
    const { ra, rb } = await startTwoTurns(relay);

    relay.broadcast({ type: "error", payload: { message: "boom" } });

    const [am, bm] = await Promise.all([
      ra.turn.events()[Symbol.asyncIterator]().next(),
      rb.turn.events()[Symbol.asyncIterator]().next(),
    ]);
    expect((am.value as { type?: string }).type).toBe("error");
    expect((bm.value as { type?: string }).type).toBe("error");
  });

  // relay-handle 在首个监听器注册时回放缓冲的旧消息；这些消息不属于本 turn，必须过滤
  test("监听器注册前到达的旧消息（缓冲回放）按 id/sessionId 过滤不误收", async () => {
    const relay = createFakeRelayHandle();
    // 注册任何监听器前广播 → 进入 relay 缓冲（首个监听器注册时回放）。
    // 固定大 id 避免与随机偏移的 rpcId 撞号造成偶发失配
    relay.broadcast({ jsonrpc: "2.0", id: 424242, result: { stopReason: "end_turn", content: [] } });
    relay.broadcast({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses_ghost",
        update: { sessionUpdate: "agent_message_chunk", content: { text: "ghost" } },
      },
    });

    const session = makeSession(relay.handle);
    const { turn } = await startPromptTurn({ session });
    turn.prompt([{ type: "text", text: "hello" }]);
    const sid = promptSessionIds(relay)[0];

    // 广播本 turn 的真实 update
    relay.broadcast({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: sid,
        update: { sessionUpdate: "agent_message_chunk", content: { text: "real" } },
      },
    });

    const it = turn.events()[Symbol.asyncIterator]();
    const first = await Promise.race([it.next().then((r) => r.value), sleep(30)]);
    const firstMsg = first as { params?: { update?: { content?: { text?: string } } } };
    // 队列第一个事件必须是本 turn 的 update（缓冲里的旧消息已被过滤）
    expect(firstMsg.params?.update?.content?.text).toBe("real");
  });

  // 包裹格式 {type, payload:{jsonrpc,...}} 是 acp-link 的 relay 信封形态，过滤规则必须双格式兼容
  test("wrapped 格式 {type,payload} 的 session/update 同样按 sessionId 过滤", async () => {
    const relay = createFakeRelayHandle();
    const { ra, rb } = await startTwoTurns(relay);
    const [sidA, sidB] = promptSessionIds(relay);
    expect(sidA).not.toBe(sidB);

    relay.broadcast({
      type: "session_update",
      payload: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: sidB,
          update: { sessionUpdate: "agent_message_chunk", content: { text: "b-text" } },
        },
      },
    });

    // run A 收不到（wrapped 格式同样按 sessionId 过滤）
    const aIt = ra.turn.events()[Symbol.asyncIterator]();
    const aWinner = await Promise.race([aIt.next().then(() => "msg"), sleep(30)]);
    expect(aWinner).toBe("timeout");

    // run B 收到
    const bIt = rb.turn.events()[Symbol.asyncIterator]();
    const bWinner = await Promise.race([bIt.next().then(() => "msg"), sleep(30)]);
    expect(bWinner).toBe("msg");
  });
});
