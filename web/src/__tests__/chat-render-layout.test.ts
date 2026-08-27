import { describe, expect, test } from "bun:test";
import { buildChatRenderBlocks, buildChatRenderItems } from "../../components/chat/chat-render-layout";
import type { AssistantMessageEntry, ThreadEntry, ToolCallEntry } from "../lib/types";

function thought(id: string): AssistantMessageEntry {
  return { type: "assistant_message", id, chunks: [{ type: "thought", text: `思考 ${id}` }] };
}

function message(id: string): AssistantMessageEntry {
  return { type: "assistant_message", id, chunks: [{ type: "message", text: `正文 ${id}` }] };
}

function tool(id: string): ToolCallEntry {
  return {
    type: "tool_call",
    toolCall: { id, title: "Read", status: "complete", kind: "read-file" },
  };
}

describe("Chat 渲染布局 ViewModel", () => {
  // 思考、工具、思考属于同一连续活动链，必须统一使用紧凑密度，避免三层独立留白叠加。
  test("将 thinking-tool-thinking 标记为连续活动链", () => {
    const items = buildChatRenderItems([thought("before"), tool("read"), thought("after")]);

    expect(items.map((item) => item.type)).toEqual(["entry", "tool_group", "entry"]);
    expect(items.map((item) => item.density)).toEqual(["activity", "activity", "activity"]);
  });

  // 连续活动项必须收敛为单个轨迹区间，确保左侧竖线只在无正文的工具范围内连续出现。
  test("将连续活动项聚合为一个工具轨迹区间", () => {
    const blocks = buildChatRenderBlocks([
      thought("before"),
      tool("read"),
      thought("middle"),
      tool("write"),
      thought("after"),
      message("answer"),
    ]);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("activity_chain");
    if (blocks[0]?.type !== "activity_chain") throw new Error("expected activity chain");
    expect(blocks[0].items).toHaveLength(5);
    expect(blocks[1]?.type).toBe("item");
  });

  // 带可见正文的助手消息仍保持正文节奏，不能因邻接工具而被错误压缩。
  test("正文消息不会被降级为紧凑活动项", () => {
    const entries: ThreadEntry[] = [message("answer"), tool("read"), thought("after")];
    const items = buildChatRenderItems(entries);

    expect(items[0]?.density).toBe("normal");
    expect(items[1]?.density).toBe("activity");
    expect(items[2]?.density).toBe("activity");
  });
});
