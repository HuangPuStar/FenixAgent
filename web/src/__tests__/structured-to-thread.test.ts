// web/src/__tests__/structured-to-thread.test.ts
// chatDocEntriesToStructuredMessages 切分回归测试：
// assistant entry 内文本段被工具调用打断时，展示投影必须切分为多条
// assistant_message（保持 "ai → tool×N → ai" 的真实顺序，id 唯一）；
// 连续文本流保持单条消息，无文本直接工具调用不产生空消息。
//
// 对应后端修复：appendEntryText 顺序感知聚合（打断后新建 text:N 块），
// 前端投影按 tool_call 块切分——两层叠加才能正确渲染。

import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyNormalizedEvent,
  createChatDoc,
  createSessionDoc,
  type DocPair,
  type NormalizedEvent,
  type StructuredMessage,
} from "@fenix/chat-channel";
import { chatDocEntriesToStructuredMessages } from "../lib/structured-to-thread";

let pair: DocPair;

function event(type: NormalizedEvent["type"], update: Record<string, unknown> = {}, turnId?: string): NormalizedEvent {
  return { type, update, content: (update.content as Record<string, unknown>) ?? null, turnId };
}

function textOf(m: StructuredMessage): string {
  if (m.type === "assistant_message") return m.chunks.map((c) => c.text).join("");
  return "";
}

beforeEach(() => {
  pair = {
    chat: createChatDoc("rcs_thread", null).ydoc,
    session: createSessionDoc("rcs_thread", null).ydoc,
  };
});

describe("chatDocEntriesToStructuredMessages", () => {
  // 核心回归：ai → tool×10 → ai 必须切分为 三段独立条目
  // （文本段 → 工具组 → 文本段），第二段文本不得与第一段合并显示
  test("splits assistant messages around tool calls preserving order", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "first" } }));
    for (let i = 1; i <= 10; i++) {
      applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: `t${i}`, title: "bash" }));
    }
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "second" } }));

    const messages = chatDocEntriesToStructuredMessages(pair.chat);
    // user + 第一段文本 + 10 工具 + 第二段文本
    expect(messages).toHaveLength(13);

    // 首段沿用 entryId（兼容既有消费者）
    expect(messages[1]).toMatchObject({ type: "assistant_message", id: "turn_1:assistant" });
    expect(textOf(messages[1])).toBe("first");

    // 工具条目按真实顺序插在两段文本之间
    for (let i = 0; i < 10; i++) {
      expect(messages[2 + i].type).toBe("tool_call");
    }

    // 第二段切分为独立消息，id 追加段号保证 React key 唯一
    expect(messages[12]).toMatchObject({ type: "assistant_message", id: "turn_1:assistant#1" });
    expect(textOf(messages[12])).toBe("second");
  });

  // 连续文本流（无工具打断）保持单条消息、单 chunk
  test("continuous text stream stays in a single message", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "a" } }));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "b" } }));

    const messages = chatDocEntriesToStructuredMessages(pair.chat);
    expect(messages).toHaveLength(2);
    const assistant = messages[1];
    // expect 不是类型守卫，显式收窄后再访问 chunks
    if (assistant.type !== "assistant_message") throw new Error("expected assistant message");
    expect(assistant.id).toBe("turn_1:assistant");
    expect(assistant.chunks).toEqual([{ type: "message", text: "ab" }]);
  });

  // 无文本直接工具调用：不得产生空的 assistant_message（切分点仅在文本段之间）
  test("tool call without leading text does not create an empty message", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "late" } }));

    const messages = chatDocEntriesToStructuredMessages(pair.chat);
    // user + tool + 迟到文本段，无空消息
    expect(messages).toHaveLength(3);
    expect(messages[1].type).toBe("tool_call");
    expect(messages[2]).toMatchObject({ type: "assistant_message", id: "turn_1:assistant" });
    expect(textOf(messages[2])).toBe("late");
  });
});
