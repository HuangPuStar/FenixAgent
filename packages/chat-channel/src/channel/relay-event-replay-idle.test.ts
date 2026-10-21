import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type * as Y from "yjs";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createBoundDocs, createClient, createRelayEvents } from "./connection-test-helpers";
import { REPLAY_IDLE_MS, REPLAY_WINDOW_MS, type RelayMessage } from "./connection-types";
import { relayOn } from "./relay-event-test-helpers";
import { registerSessionSync } from "./session-mutation";

const cleanups: Array<() => Promise<void>> = [];
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function harness() {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const { docManager, chatDoc, sessionDoc } = await createBoundDocs();
  const handler = createRelayEvents(registry, broadcaster, [], { docManager });
  const shared = relayOn("rcs-1");
  const handle = handler.createMessageHandler(shared);
  const session = sessionDoc.getMap("root").get("session") as Y.Map<unknown>;
  registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
  cleanups.push(async () => {
    handler.convergeReplayWindow(shared);
    await docManager.closeChat(shared.rcsSessionId);
    await docManager.closeSession(shared.rcsSessionId);
  });
  const update = (text: string, wrapped = false, sessionId = "ses-1") => {
    const rpc = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
    };
    return handle((wrapped ? { type: "acp", payload: rpc } : rpc) as unknown as RelayMessage);
  };
  handler.openReplayWindow(shared);
  return { registry, docManager, chatDoc, handler, shared, handle, session, update };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("历史回放静默完成", () => {
  // 短历史也必须在静默 200ms 后结束 loading，且尾部批次完整写入。
  test("短历史静默后完成回放并保留正文", async () => {
    const h = await harness();
    await h.handle({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "历史问题" } },
      },
    } as unknown as RelayMessage);
    await h.update("历史正文");
    expect(h.session.get("replayState")).toBe("active");
    await wait(REPLAY_IDLE_MS + 40);
    expect(h.shared.replayWindowUntil).toBeNull();
    expect(h.shared.replayWindowTimer).toBeNull();
    expect(h.session.get("replayState")).toBe("complete");
    expect(h.session.get("activeTurnStatus")).toBe("completed");
    expect(h.session.get("loading")).toBeNull();
    const entries = h.chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    const assistant = [...entries.values()].find((entry) => entry.get("role") === "assistant");
    const blocks = assistant?.get("blocks") as Y.Map<Y.Map<unknown>>;
    expect([...blocks.values()].map((block) => String(block.get("text"))).join("")).toBe("历史正文");
  });

  // 原始和包裹 JSON-RPC 更新共用静默窗口，后到帧不能被首帧的计时截断。
  test("每条更新重新计时，兼容包裹消息", async () => {
    const h = await harness();
    await h.update("第一段");
    await wait(120);
    await h.update("第二段", true);
    await wait(120);
    expect(h.shared.replayWindowUntil).not.toBeNull();
    expect(h.session.get("presenting")).toBe("replaying");
    await wait(120);
    expect(h.session.get("replayState")).toBe("complete");
  });

  // Agent 尚未开始回放时不能把请求发出后的静默误判为历史结束。
  test("首条更新或成功回执到达前保留最长等待", async () => {
    const h = await harness();
    await wait(REPLAY_IDLE_MS + 40);
    expect(h.session.get("presenting")).toBe("replaying");
    expect(h.shared.replayWindowUntil).not.toBeNull();
    await h.update("迟发历史");
    await wait(REPLAY_IDLE_MS + 40);
    expect(h.session.get("replayState")).toBe("complete");
  });

  // 空历史没有更新帧，加载成功后仍需及时解除骨架屏。
  test("零历史在加载成功后的静默窗口结束", async () => {
    const h = await harness();
    registerSessionSync(h.shared, 1, "ses-1");
    await h.handle({ jsonrpc: "2.0", id: 1, result: { sessionId: "ses-1" } } as RelayMessage);
    expect(h.session.get("presenting")).toBe("replaying");
    await wait(REPLAY_IDLE_MS + 40);
    expect(h.session.get("replayState")).toBe("complete");
    expect(h.shared.replayWindowUntil).toBeNull();
  });

  // 被拒绝的加载不能通过静默计时伪造成功完成。
  test("失败回执不会启动短静默完成", async () => {
    const h = await harness();
    registerSessionSync(h.shared, 1, "ses-1");
    await h.handle({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "load failed" } } as RelayMessage);
    await wait(REPLAY_IDLE_MS + 40);
    expect(h.session.get("replayState")).not.toBe("complete");
    expect(h.shared.replayWindowUntil).not.toBeNull();
  });

  // 旧会话通知必须先被归属校验拒绝，不能延长当前会话的等待。
  test("旧会话更新不重置当前静默窗口", async () => {
    const h = await harness();
    await h.update("当前历史");
    await wait(120);
    await h.update("旧历史", false, "ses-old");
    await wait(120);
    expect(h.session.get("replayState")).toBe("complete");
  });

  // 显式完成取消旧计时，快速切换后旧计时不得结束新会话的首帧等待。
  test("显式完成立即结束并取消旧计时", async () => {
    const h = await harness();
    await h.update("历史");
    await h.handle({
      jsonrpc: "2.0",
      method: "session/replay_complete",
      params: { sessionId: "ses-1" },
    } as unknown as RelayMessage);
    expect(h.shared.replayWindowTimer).toBeNull();
    expect(h.session.get("replayState")).toBe("complete");
    await h.docManager.replaceProjection("rcs-1", "ses-next");
    h.handler.openReplayWindow(h.shared, { resampleSkip: true });
    await wait(REPLAY_IDLE_MS + 40);
    expect(h.shared.replayWindowUntil).not.toBeNull();
  });

  // 回放计时只能收敛历史 turn，不能结束用户随后发起的实时回答。
  test("回放静默不会终结后续实时 turn", async () => {
    const h = await harness();
    await h.update("历史");
    await h.docManager.registerUserMessage("rcs-1", "新的问题");
    const turnId = h.session.get("activeTurnId");
    await wait(REPLAY_IDLE_MS + 40);
    expect(h.shared.replayWindowUntil).toBeNull();
    expect(h.session.get("activeTurnId")).toBe(turnId);
    expect(h.session.get("activeTurnStatus")).toBe("accepting");
  });

  // 连续更新不能把原有最长等待向后延长。
  test("静默等待仍受最长回放期限约束", async () => {
    const h = await harness();
    const now = spyOn(Date, "now").mockReturnValue(Date.now() + REPLAY_WINDOW_MS - 40);
    try {
      await h.update("接近期限的历史");
    } finally {
      now.mockRestore();
    }
    await wait(100);
    expect(h.shared.replayWindowUntil).toBeNull();
    expect(h.session.get("replayState")).toBe("complete");
  });
});
