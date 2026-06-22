import { describe, expect, test } from "bun:test";
import type { ThreadEntry, ToolCallEntry } from "../lib/types";

const { finalizeRunningToolCalls } = await import("../../components/ChatInterface");

// 构造工具调用条目，便于在测试中复用
function makeToolCall(id: string, status: ToolCallEntry["toolCall"]["status"]): ToolCallEntry {
  return {
    type: "tool_call",
    toolCall: {
      id,
      title: `tool-${id}`,
      status,
      rawInput: {},
    },
  };
}

describe("finalizeRunningToolCalls", () => {
  // 一轮 prompt 结束后，仍为 running 的工具调用应被兜底标记为 complete
  test("running 工具调用在 prompt 结束后被标记为 complete", () => {
    const entries: ThreadEntry[] = [makeToolCall("a", "running"), makeToolCall("b", "running")];

    const result = finalizeRunningToolCalls(entries);

    expect(result).toHaveLength(2);
    expect((result[0] as ToolCallEntry).toolCall.status).toBe("complete");
    expect((result[1] as ToolCallEntry).toolCall.status).toBe("complete");
  });

  // 已是终态或其他非 running 状态的工具调用保持不变
  test("保留 complete/error/canceled/rejected/waiting_for_confirmation 状态", () => {
    const statuses: ToolCallEntry["toolCall"]["status"][] = [
      "complete",
      "error",
      "canceled",
      "rejected",
      "waiting_for_confirmation",
    ];
    const entries: ThreadEntry[] = statuses.map((s, i) => makeToolCall(`s${i}`, s));

    const result = finalizeRunningToolCalls(entries);

    expect(result).toHaveLength(statuses.length);
    for (let i = 0; i < statuses.length; i++) {
      expect((result[i] as ToolCallEntry).toolCall.status).toBe(statuses[i]);
    }
  });

  // 子 agent 嵌套（subEntries）里的 running 工具也应被递归兜底
  test("递归处理 subEntries 中的 running 工具调用", () => {
    const parent = makeToolCall("parent", "complete");
    parent.toolCall.subEntries = [makeToolCall("child-1", "running"), makeToolCall("child-2", "complete")];
    const entries: ThreadEntry[] = [parent];

    const result = finalizeRunningToolCalls(entries);
    const parentResult = result[0] as ToolCallEntry;
    const subEntries = parentResult.toolCall.subEntries!;

    expect(parentResult.toolCall.status).toBe("complete");
    expect((subEntries[0] as ToolCallEntry).toolCall.status).toBe("complete");
    expect((subEntries[1] as ToolCallEntry).toolCall.status).toBe("complete");
  });

  // 没有任何 running 工具调用时应直接返回原数组引用，避免无意义重渲染
  test("无 running 工具调用时返回原数组引用", () => {
    const entries: ThreadEntry[] = [makeToolCall("a", "complete"), makeToolCall("b", "canceled")];

    const result = finalizeRunningToolCalls(entries);

    expect(result).toBe(entries);
  });

  // 空数组与不含工具调用的条目不应抛错
  test("空数组与纯消息条目安全通过", () => {
    const entries: ThreadEntry[] = [
      { type: "user_message", id: "u1", content: "hi" },
      { type: "assistant_message", id: "a1", chunks: [{ type: "message", text: "hello" }] },
    ];

    const result = finalizeRunningToolCalls(entries);

    expect(result).toBe(entries);
  });
});
