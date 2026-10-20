// 新旧双写合并的覆盖次数/用户配对回归：按出现次数退役，不按全局文本并集误删。

import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import { createSyncMessageMerger } from "../hooks/sync-chat-messages";

function user(id: string, content: string, ts = 10000): StructuredMessage {
  return { type: "user_message", id, content, ts, seq: 0 };
}

function assistant(id: string, text: string, ts = 10000): StructuredMessage {
  return { type: "assistant_message", id, chunks: [{ type: "message", text }], ts, seq: 1 };
}

function assistantText(message: StructuredMessage): string {
  return message.type === "assistant_message"
    ? message.chunks.map((chunk) => (chunk.type === "message" ? chunk.text : "")).join("")
    : "";
}

function userText(message: StructuredMessage): string {
  return message.type === "user_message" ? message.content : "";
}

describe("新旧消息合并的覆盖次数", () => {
  // 两轮出现相同助手文本时，一条未配对的新投影文本只能退役一条旧副本（B02）。
  test("异轮同文本助手消息只按覆盖次数退役一条", () => {
    const legacy = [assistant("legacy-a1", "收到", 1), assistant("legacy-a2", "收到", 2)];
    const merged = createSyncMessageMerger()(legacy, [assistant("sync-a1", "收到", 60_000)]);
    expect(merged.map((message) => message.id)).toEqual(["legacy-a2", "sync-a1"]);
  });

  // 新投影确实有两条同文本助手消息时，两条旧副本都退役且不重复显示。
  test("新投影覆盖两条同文本助手消息时全部退役", () => {
    const legacy = [assistant("legacy-a1", "收到", 1), assistant("legacy-a2", "收到", 2)];
    const merged = createSyncMessageMerger()(legacy, [
      assistant("sync-a1", "收到", 60_000),
      assistant("sync-a2", "收到", 60_001),
    ]);
    expect(merged.map((message) => message.id)).toEqual(["sync-a1", "sync-a2"]);
  });

  // 窗口内配对已经消费的那条新投影不能再退役另一条旧消息，未覆盖的旧文本必须保留。
  test("已配对助手消息只抵消同一条旧副本", () => {
    const legacy = [assistant("legacy-a1", "收到", 1), assistant("legacy-a2", "收到", 2)];
    const merged = createSyncMessageMerger()(legacy, [assistant("sync-a1", "收到", 1000)]);
    expect(merged.map((message) => message.id)).toEqual(["legacy-a1", "legacy-a2"]);
    expect(merged.map(assistantText).filter((text) => text === "收到")).toHaveLength(2);
  });
});

describe("新旧消息合并的用户配对", () => {
  // 异 ID、时间差超过 5 秒的同文本用户消息仍是同一次双写，只能显示一条。
  test("异 ID 跨窗口同文本用户消息只保留一条", () => {
    const merged = createSyncMessageMerger()([user("legacy-u", "继续", 1000)], [user("sync-u", "继续", 11_000)]);
    expect(merged.filter((message) => message.type === "user_message")).toHaveLength(1);
  });

  // 两侧各两条相同提问时按顺序配两对，最终仍是两条，不因跨窗口而重复。
  test("两侧各两条相同提问保留两条且不重复", () => {
    const merged = createSyncMessageMerger()(
      [user("legacy-u1", "继续", 1000), user("legacy-u2", "继续", 2000)],
      [user("sync-u1", "继续", 30_000), user("sync-u2", "继续", 31_000)],
    );
    expect(merged.filter((message) => message.type === "user_message")).toHaveLength(2);
    expect(merged.map(userText).filter((text) => text === "继续")).toHaveLength(2);
  });

  // 旧通道两条、新投影一条时只配对一条，另一条合法提问仍保留（B01 不回退）。
  test("旧通道多出的重复提问不被配对吞掉", () => {
    const merged = createSyncMessageMerger()(
      [user("legacy-u1", "继续", 1000), user("legacy-u2", "继续", 2000)],
      [user("sync-u1", "继续", 30_000)],
    );
    expect(merged.filter((message) => message.type === "user_message").map((message) => message.id)).toEqual([
      "legacy-u1",
      "legacy-u2",
    ]);
  });

  // 工具只存在于旧通道，不能阻断同一轮用户消息的配对（B01 之外的常见双写形态）。
  test("用户与助手之间有工具时仍只保留一条用户消息", () => {
    const tool: StructuredMessage = {
      type: "tool_call",
      id: "tool-1",
      title: "Read",
      status: "complete",
      content: [],
    };
    const merged = createSyncMessageMerger()(
      [user("legacy-u", "继续", 1000), tool, assistant("legacy-a", "回答", 1100)],
      [user("sync-u", "继续", 30_000), assistant("sync-a", "回答", 30_100)],
    );
    expect(merged.filter((message) => message.type === "user_message")).toHaveLength(1);
  });

  // 两次合法提问各只在一边有记录时，相邻助手锚点不同，不能被当成同一次双写。
  test("相邻轮次不同的同文本提问各保留一条", () => {
    const merged = createSyncMessageMerger()(
      [user("legacy-q1", "继续", 1000), assistant("legacy-a1", "第一轮回答", 1100)],
      [assistant("sync-a1", "第一轮回答", 1100), user("sync-q2", "继续", 30_000)],
    );
    expect(merged.filter((message) => message.type === "user_message").map((message) => message.id)).toEqual([
      "legacy-q1",
      "sync-q2",
    ]);
  });
});
