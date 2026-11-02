import { afterEach, expect, test } from "bun:test";
import { encodeYjsUpdateFrame } from "@fenix/chat-channel";
import { DocManager } from "@fenix/chat-channel/server";
import { act } from "react";
import * as Y from "yjs";
import {
  installFakeWebSocket,
  legacySockets,
  renderRuntime,
  restoreFakeWebSocket,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

// Session 实时状态先到也不能提前展示；两份初始快照确认后，持续输出无需等待静默。
test("回复中刷新仅在初始同步确认后快速显示完整历史", async () => {
  installFakeWebSocket();
  const h = renderRuntime();
  const manager = new DocManager({ acpBatchWindowMs: 0 });
  const key = h.latest.current!.rcsSessionKey!;
  const generation = "live-refresh-generation";
  const socket = legacySockets()[0]!;
  const chat = await manager.openChat(key);
  const session = await manager.openSession("user-1", "env-1", key);
  await manager.registerUserMessage(key, "完整历史中的问题");
  manager.processNormalizedEvent(key, { type: "message_delta", update: {}, content: { text: "已输出正文" } });
  manager.flushACPBatch(key);
  const deliver = (name: string, doc: Y.Doc) =>
    act(() =>
      socket.onmessage?.({ data: encodeYjsUpdateFrame(name, generation, Y.encodeStateAsUpdate(doc)) } as MessageEvent),
    );
  const confirm = () =>
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "yjs:sync-complete",
          docs: [`chat:${key}`, `session:${key}`],
          generation,
        }),
      } as MessageEvent),
    );
  const tick = async () =>
    act(async () => {
      await Bun.sleep(40);
    });
  try {
    act(() => socket.open());
    deliver(`session:${key}`, session.ydoc);
    confirm(); // 缺少 Chat 初始快照的控制帧不能充当完整交付证明。
    await tick();
    expect(h.latest.current!.sessionState.structuredMessages).toEqual([]);
    deliver(`chat:${key}`, chat.ydoc);
    for (let index = 0; index < 2; index += 1) {
      manager.processNormalizedEvent(key, { type: "message_delta", update: {}, content: { text: "继续" } });
      manager.flushACPBatch(key);
      deliver(`chat:${key}`, chat.ydoc);
      await tick();
    }
    expect(h.latest.current!.sessionState.structuredMessages).toEqual([]);
    confirm();
    for (let index = 0; index < 3; index += 1) {
      manager.processNormalizedEvent(key, { type: "message_delta", update: {}, content: { text: "实时增量" } });
      manager.flushACPBatch(key);
      deliver(`chat:${key}`, chat.ydoc);
      await tick();
    }
    const messages = h.latest.current!.sessionState.structuredMessages;
    expect(messages.some((message) => message.type === "user_message")).toBe(true);
    expect(
      messages
        .filter((message) => message.type === "assistant_message")
        .flatMap((message) => message.chunks)
        .map((chunk) => chunk.text)
        .join(""),
    ).toContain("已输出正文继续继续实时增量实时增量实时增量");
  } finally {
    h.unmount();
    await manager.closeAll();
  }
});
