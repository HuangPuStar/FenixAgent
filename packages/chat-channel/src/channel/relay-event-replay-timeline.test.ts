import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createBoundDocs, createClient, createRelayEvents } from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";
import { relayOn } from "./relay-event-test-helpers";

describe("RelayEventHandler replay window", () => {
  const future = Date.now() + 60_000;
  /** reasoning_delta 等批次化事件在 16ms 合并窗口后 flush，断言前等待 flush */
  const waitFlush = () => new Promise((resolve) => setTimeout(resolve, 30));

  /** 读取指定 role 的全部 Entry 文本（text + reasoning 块拼接） */
  function entriesText(chatDoc: Y.Doc, role: "user" | "assistant"): string {
    const entries = chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    let out = "";
    for (const entry of entries.values()) {
      if (entry.get("role") !== role) continue;
      const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>>;
      for (const block of blocks.values()) {
        const text = block.get("text") as { toString?: () => string } | undefined;
        if (text?.toString) out += text.toString();
      }
    }
    return out;
  }

  /** 统计指定 role 的 Entry 数量（验证双写防护：用户消息不得重复） */
  function countEntriesByRole(chatDoc: Y.Doc, role: "user" | "assistant"): number {
    const entries = chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.get("role") === role) count++;
    }
    return count;
  }

  // 回放窗口到期必须收敛回放 turn（completed）：回放流无终态信号
  // （unstable_resumeSession 只回放 chunk 帧），定时器到点 dispatch turn_completed，
  // 否则回放 turn 永久卡 running、前端一直显示输出中（合成 turn 的终态唯一来源）。
  test("replay window expiry converges the replay turn to completed", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;

    // 窗口内无头回放增量合成回放 turn（模拟 load 后历史回放到达）
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "回放思考" } },
      },
    } as unknown as RelayMessage);
    await waitFlush();
    expect(shared.replayTurnId).not.toBeNull();

    // 窗口到期收敛（定时器回调路径）
    handler.convergeReplayWindow(shared);

    expect(shared.replayWindowUntil).toBeNull();
    expect(shared.replayTurnId).toBeNull();
    const session = sessionDoc.getMap("root").get("session") as Y.Map<unknown>;
    expect(session.get("activeTurnStatus")).toBe("completed");
    // 回放 turn 终态投影：presenting=done，无 loading 与取消（回放是历史回显）
    expect(session.get("presenting")).toBe("done");
    expect(session.get("loading")).toBeNull();
    expect(session.get("canCancel")).toBe(false);
    // assistant entry 收敛终态（非 streaming）
    const entries = chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    for (const entry of entries.values()) {
      if (entry.get("role") === "assistant") expect(entry.get("status")).toBe("completed");
    }
  });

  // 回放内的后续 user_message（窗口内已有活动回放 turn）同样分配新的回放 turnId：
  // 不分配会被聚合层以 missing turnId 拒绝而丢失，回放历史中间的用户消息消失；
  // 旧回放 turn 由聚合层收敛为 completed（回放是自然结束而非用户取消）。
  test("later user_message inside the replay is assigned a new replay turnId", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;

    const sendReplayUserMessage = async (text: string) => {
      await handler.createMessageHandler(shared)({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses-1",
          update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
        },
      } as unknown as RelayMessage);
    };
    await sendReplayUserMessage("历史消息一");
    await sendReplayUserMessage("历史消息二");

    // 两条回放用户消息都不丢失（未分配 turnId 的第二条会被聚合层拒绝）
    expect(countEntriesByRole(chatDoc, "user")).toBe(2);
    expect(entriesText(chatDoc, "user")).toBe("历史消息一历史消息二");
    // 最新回放 turn 处于 accepting，replayTurnId 指向它（到期收敛目标）
    const session = sessionDoc.getMap("root").get("session") as Y.Map<unknown>;
    expect(session.get("activeTurnStatus") as string | null).toBe("accepting");
    expect(shared.replayTurnId).toBe(session.get("activeTurnId") as string | null);
    // 回放 turn 展示态：presenting=loading（accepting 映射）但抑制 loading 指示与停止按钮
    expect(session.get("presenting")).toBe("loading");
    expect(session.get("loading")).toBeNull();
    expect(session.get("canCancel")).toBe(false);
    // 旧回放 turn 的 assistant entry 收敛为 completed（回放自然结束，非 cancelled）
    const entries = chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    const assistantStatuses: unknown[] = [];
    for (const entry of entries.values()) {
      if (entry.get("role") === "assistant") assistantStatuses.push(entry.get("status"));
    }
    expect(assistantStatuses).toContain("completed");
  });
});
