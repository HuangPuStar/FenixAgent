import { expect, test } from "bun:test";
import { RCSChatAdapter, normalizeRcsToolCall } from "../lib/rcs-chat-adapter";
import type { ThreadEntry } from "../lib/types";
import type { SessionEvent } from "../types";

function createStateHarness() {
  let entries: ThreadEntry[] = [];
  const setEntries = (update: ThreadEntry[] | ((prev: ThreadEntry[]) => ThreadEntry[])) => {
    entries = typeof update === "function" ? update(entries) : update;
  };
  return {
    getEntries: () => entries,
    setEntries,
  };
}

test("normalizeRcsToolCall unwraps nested MCP tool metadata from rcs wrapper", () => {
  expect(normalizeRcsToolCall("rcs", {
    tool: "kb_kb_search",
    input: { query: "release plan" },
  })).toEqual({
    title: "kb_kb_search",
    rawInput: { query: "release plan" },
    wrappedByRcs: true,
  });
});

test("RCSChatAdapter deduplicates wrapped rcs tool events against embedded tool_use blocks", () => {
  const harness = createStateHarness();
  const adapter = new RCSChatAdapter("session_test", harness.setEntries as never);

  const assistantEvent: SessionEvent = {
    type: "assistant",
    payload: {
      message: {
        content: [
          {
            type: "tool_use",
            id: "embedded-tool-1",
            name: "kb_kb_search",
            input: { query: "release plan" },
          },
        ],
      },
    },
  };

  const wrappedToolUseEvent: SessionEvent = {
    type: "tool_use",
    payload: {
      tool_call_id: "wrapper-tool-1",
      tool_name: "rcs",
      tool_input: {
        tool: "kb_kb_search",
        input: { query: "release plan" },
      },
    },
  };

  const toolResultEvent: SessionEvent = {
    type: "tool_result",
    payload: {
      tool_call_id: "wrapper-tool-1",
      content: "[]",
    },
  };

  (adapter as any).handleEvent(assistantEvent);
  (adapter as any).handleEvent(wrappedToolUseEvent);
  (adapter as any).handleEvent(toolResultEvent);

  const toolCalls = harness.getEntries().filter((entry) => entry.type === "tool_call");
  expect(toolCalls).toHaveLength(1);
  expect(toolCalls[0]?.toolCall.title).toBe("kb_kb_search");
  expect(toolCalls[0]?.toolCall.rawInput).toEqual({ query: "release plan" });
  expect(toolCalls[0]?.toolCall.status).toBe("complete");
});
