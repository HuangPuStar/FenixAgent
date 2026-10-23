import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import { createSyncMessageMerger } from "../hooks/sync-chat-messages";

type Assistant = Extract<StructuredMessage, { type: "assistant_message" }>;
function assistant(id: string, text: string, ts = 10000): Assistant {
  return { type: "assistant_message", id, chunks: [{ type: "message", text }], ts, seq: 1 };
}
function tool(id: string): StructuredMessage {
  return { type: "tool_call", id, title: "Read", status: "complete", content: [] };
}
function textOf(message: StructuredMessage): string {
  return message.type === "assistant_message"
    ? message.chunks
        .filter((chunk) => chunk.type === "message")
        .map((chunk) => chunk.text)
        .join("")
    : "";
}
function body(messages: readonly StructuredMessage[]): string {
  return messages.map(textOf).join("");
}
function ids(messages: readonly StructuredMessage[]): string[] {
  return messages.map((message) => message.id);
}
function view(messages: readonly StructuredMessage[]): string[] {
  return messages.map((message) =>
    message.type === "assistant_message" ? `${message.id}=${textOf(message)}` : `${message.type}:${message.id}`,
  );
}

describe("旧格式降级保真", () => {
  // fallback 保留原始 chunk 与错误位置，不把 thought 扁平挪到整段正文前。
  test("fallback 保留 thought 与 error", () => {
    const first: Assistant = {
      ...assistant("e", "A"),
      chunks: [
        { type: "thought", text: "THINK" },
        { type: "message", text: "A" },
      ],
      error: { type: "AGENT_RUNTIME.PROMPT_REJECTED", id: "err-1", message: "ERR" },
    };
    const merged = createSyncMessageMerger()(
      [first, tool("t1"), tool("t2"), assistant("e#2", "C")],
      [assistant("e", "ABC", 0)],
    );
    const mergedAssistant = merged.find((message): message is Assistant => message.type === "assistant_message");
    expect(mergedAssistant?.chunks).toContainEqual({ type: "thought", text: "THINK" });
    expect(body(merged)).toBe("ABC");
    expect(view(merged)).toEqual(["e=A", "tool_call:t1", "tool_call:t2", "e#2=BC"]);
    expect(mergedAssistant?.chunks).toEqual([
      { type: "thought", text: "THINK" },
      { type: "message", text: "A" },
    ]);
    expect(mergedAssistant?.error).toEqual({ type: "AGENT_RUNTIME.PROMPT_REJECTED", id: "err-1", message: "ERR" });
    expect(merged.filter((message) => message.type === "tool_call").map((message) => message.id)).toEqual(["t1", "t2"]);
  });
});

describe("缺口属性检查（200 轮 × 7 种缺段组合）", () => {
  // 任意缺段组合下，正文必须完整可见、工具顺序不变；这是 1400 次断言的仓库内可复现证据。
  test("任意缺段组合正文完整且工具顺序稳定", () => {
    let checks = 0;
    for (let round = 0; round < 200; round += 1) {
      const segments = [`s${round}a`, `s${round}b`, `s${round}c`];
      const full: StructuredMessage[] = [
        assistant("e", segments[0]!),
        tool("t1"),
        assistant("e#1", segments[1]!),
        tool("t2"),
        assistant("e#2", segments[2]!),
      ];
      const sync = [assistant("e", segments.join(""), 0)];
      for (let mask = 1; mask < 8; mask += 1) {
        const paged = full.filter((message) => {
          if (message.id === "e") return (mask & 1) === 0;
          if (message.id === "e#1") return (mask & 2) === 0;
          if (message.id === "e#2") return (mask & 4) === 0;
          return true;
        });
        const merged = createSyncMessageMerger()(paged, sync);
        expect(body(merged)).toBe(segments.join(""));
        expect(merged.filter((message) => message.type === "tool_call").map((message) => message.id)).toEqual([
          "t1",
          "t2",
        ]);
        expect(new Set(ids(merged)).size).toBe(ids(merged).length);
        checks += 1;
      }
    }
    expect(checks).toBe(1400);
  });
});
