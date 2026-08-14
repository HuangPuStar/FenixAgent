// packages/acp-server/src/__tests__/aggregator.test.ts
import { beforeEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { applyACPEvent } from "../state/aggregator";

let ydoc: Y.Doc;

beforeEach(() => {
  ydoc = new Y.Doc();
  const meta = ydoc.getMap("meta");
  meta.set("status", "idle");
  meta.set("acpSessionId", "ses_test");
  meta.set("createdAt", Date.now());
  meta.set("updatedAt", Date.now());
  ydoc.getArray("messages");
  ydoc.getMap("streaming");
  ydoc.getMap("tools");
  ydoc.getArray("artifacts");
});

// agent_message_chunk 单个 chunk 应该累加到 streaming.text
test("agent_message_chunk appends to streaming.text", () => {
  applyACPEvent(ydoc, {
    type: "agent_message_chunk",
    payload: { content: { type: "text", text: "Hello" } },
  });
  applyACPEvent(ydoc, {
    type: "agent_message_chunk",
    payload: { content: { type: "text", text: " world" } },
  });

  const stream = ydoc.getMap("streaming") as any;
  const meta = ydoc.getMap("meta") as any;
  expect(stream.get("text")).toBe("Hello world");
  expect(meta.get("status")).toBe("responding");
});

// prompt_complete 应该把 streaming.text flush 到 messages 并清空，同时清除 loading
test("prompt_complete flushes streaming to messages", () => {
  applyACPEvent(ydoc, {
    type: "agent_message_chunk",
    payload: { content: { type: "text", text: "Hello world" } },
  });
  applyACPEvent(ydoc, { type: "prompt_complete" });

  const messages = ydoc.getArray("messages").toArray();
  expect(messages.length).toBe(1);
  const r0 = messages[0] as any;
  expect(r0.get("role")).toBe("assistant");
  expect(r0.get("content")).toBe("Hello world");
  expect(r0.get("seq")).toBe(0);
  const stream = ydoc.getMap("streaming") as any;
  const meta = ydoc.getMap("meta") as any;
  expect(stream.get("text")).toBeUndefined();
  expect(meta.get("status")).toBe("done");
  expect(meta.get("loading")).toBeNull();
});

// tool_call_start 创建 running tool
test("tool_call_start creates running tool entry", () => {
  applyACPEvent(ydoc, {
    type: "tool_call",
    payload: {
      sessionUpdate: "tool_call",
      content: { type: "tool_use", id: "t1", name: "read_file", input: { path: "/a.txt" } },
    },
  });

  const tools = ydoc.getMap("tools") as Y.Map<Y.Map<unknown>>;
  const t1 = tools.get("t1") as any;
  expect(t1).not.toBeNull();
  expect(t1.get("name")).toBe("read_file");
  expect(t1.get("status")).toBe("running");
  const meta = ydoc.getMap("meta") as any;
  expect(meta.get("status")).toBe("tool-calling");
});

// tool_call_result 标记 tool 完成
test("tool_call_result marks tool as done", () => {
  applyACPEvent(ydoc, {
    type: "tool_call",
    payload: { sessionUpdate: "tool_call", content: { type: "tool_use", id: "t1", name: "read_file" } },
  });
  applyACPEvent(ydoc, {
    type: "tool_call_result",
    payload: { id: "t1", output: "file content" },
  });

  const tools = ydoc.getMap("tools") as Y.Map<Y.Map<unknown>>;
  const t1 = tools.get("t1") as any;
  expect(t1.get("status")).toBe("done");
  expect(t1.get("output")).toBe("file content");
});

// user_message 创建 user 角色消息并设置 status 和 loading
test("user_message creates user entry and sets status", () => {
  applyACPEvent(ydoc, {
    type: "user_message_chunk",
    payload: { content: { type: "text", text: "What is this?" } },
  });

  const messages = ydoc.getArray("messages").toArray();
  expect(messages.length).toBe(1);
  const r0 = messages[0] as any;
  expect(r0.get("role")).toBe("user");
  const meta = ydoc.getMap("meta") as any;
  expect(meta.get("status")).toBe("loading");
  const loading = meta.get("loading") as Record<string, unknown> | null;
  expect(loading).not.toBeNull();
  expect(loading!.kind).toBe("session/respond");
  expect(loading!.label).toBe("Agent is thinking...");
  expect(typeof loading!.since).toBe("number");
});

// tool_call_result 中的 URL 应提取为 artifact
test("tool_call_result extracts URLs as artifacts", () => {
  // 先创建 tool
  applyACPEvent(ydoc, {
    type: "tool_call",
    payload: { sessionUpdate: "tool_call", content: { type: "tool_use", id: "t1", name: "download" } },
  });
  applyACPEvent(ydoc, {
    type: "tool_call_result",
    payload: {
      id: "t1",
      output: "Downloaded https://example.com/chart.png successfully",
    },
  });

  const artifacts = ydoc.getArray("artifacts").toArray();
  expect(artifacts.length).toBe(1);
  const a0 = artifacts[0] as any;
  expect(a0.get("url")).toBe("https://example.com/chart.png");
  expect(a0.get("kind")).toBe("image");
});

// 未识别的事件类型不应该改变状态
test("unknown event type does not mutate state", () => {
  const meta = ydoc.getMap("meta") as any;
  const statusBefore = meta.get("status");
  applyACPEvent(ydoc, { type: "unknown_event", payload: {} });
  expect(meta.get("status")).toBe(statusBefore);
});

// 测试 tool_call_update 更新 structuredMessages 状态
test("tool_call_update updates structuredMessages tool_call status", () => {
  const ydoc = new Y.Doc();

  // First create a tool_call entry
  applyACPEvent(ydoc, {
    type: "tool_call",
    payload: {
      sessionUpdate: "tool_call",
      content: { type: "tool_use", id: "tool_1", name: "read_file", input: { path: "/test" } },
    },
  });

  // Then update it
  applyACPEvent(ydoc, {
    type: "tool_call_update",
    payload: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool_1",
      status: "complete",
      rawOutput: { result: "ok" },
    },
  });

  const structuredMessages = ydoc.getArray("structuredMessages") as Y.Array<Y.Map<unknown>>;
  const last = structuredMessages.get(structuredMessages.length - 1);
  expect(last.get("status")).toBe("complete");
  expect(last.get("rawOutput")).toEqual({ result: "ok" });
});

// 测试 tool_call_update 追加 content blocks
test("tool_call_update appends content blocks to tool_call structuredMessages", () => {
  const ydoc = new Y.Doc();

  applyACPEvent(ydoc, {
    type: "tool_call",
    payload: {
      sessionUpdate: "tool_call",
      content: { type: "tool_use", id: "tool_1", name: "bash", input: { cmd: "ls" } },
    },
  });

  applyACPEvent(ydoc, {
    type: "tool_call_update",
    payload: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool_1",
      content: [{ type: "diff", path: "/test.ts", oldText: "old", newText: "new" }],
    },
  });

  const structuredMessages = ydoc.getArray("structuredMessages") as Y.Array<Y.Map<unknown>>;
  const last = structuredMessages.get(structuredMessages.length - 1);
  const content = last.get("content") as Y.Array<Y.Map<unknown>>;
  expect(content.length).toBe(1);
  expect(content.get(0).get("type")).toBe("diff");
});

// 测试 plan 事件写入 structuredMessages
test("plan event creates structuredMessages plan entry", () => {
  const ydoc = new Y.Doc();

  applyACPEvent(ydoc, {
    type: "plan",
    payload: {
      entries: [
        { content: "Read the file", priority: "high", status: "pending" },
        { content: "Fix the bug", priority: "medium", status: "pending" },
      ],
    },
  });

  const structuredMessages = ydoc.getArray("structuredMessages") as Y.Array<Y.Map<unknown>>;
  expect(structuredMessages.length).toBe(1);
  const plan = structuredMessages.get(0);
  expect(plan.get("type")).toBe("plan");
  const entries = plan.get("entries") as Y.Array<Y.Map<unknown>>;
  expect(entries.length).toBe(2);
  expect(entries.get(0).get("content")).toBe("Read the file");
  expect(entries.get(0).get("priority")).toBe("high");
});

// 测试 plan 事件替换已有计划
test("plan event replaces existing structuredMessages plan entry", () => {
  const ydoc = new Y.Doc();

  applyACPEvent(ydoc, {
    type: "plan",
    payload: { entries: [{ content: "Old plan", priority: "low", status: "pending" }] },
  });

  applyACPEvent(ydoc, {
    type: "plan",
    payload: { entries: [{ content: "New plan", priority: "high", status: "in_progress" }] },
  });

  const structuredMessages = ydoc.getArray("structuredMessages") as Y.Array<Y.Map<unknown>>;
  const plans = structuredMessages.toArray().filter((m) => m.get("type") === "plan");
  expect(plans.length).toBe(1);
  const entries = plans[0].get("entries") as Y.Array<Y.Map<unknown>>;
  expect(entries.get(0).get("content")).toBe("New plan");
});

// 测试空 plan 清除已有计划
test("plan event with empty entries clears existing plan", () => {
  const ydoc = new Y.Doc();

  applyACPEvent(ydoc, {
    type: "plan",
    payload: { entries: [{ content: "Some plan", priority: "medium", status: "pending" }] },
  });

  applyACPEvent(ydoc, {
    type: "plan",
    payload: { entries: [] },
  });

  const structuredMessages = ydoc.getArray("structuredMessages") as Y.Array<Y.Map<unknown>>;
  const plans = structuredMessages.toArray().filter((m) => m.get("type") === "plan");
  expect(plans.length).toBe(0);
});

// 测试 tool_call_error 写入 rawOutput
test("tool_call_error writes rawOutput in structuredMessages", () => {
  const ydoc = new Y.Doc();

  applyACPEvent(ydoc, {
    type: "tool_call",
    payload: {
      sessionUpdate: "tool_call",
      content: { type: "tool_use", id: "tool_err", name: "bash", input: { cmd: "rm -rf" } },
    },
  });

  applyACPEvent(ydoc, {
    type: "tool_call_error",
    payload: { id: "tool_err", error: "Permission denied" },
  });

  const structuredMessages = ydoc.getArray("structuredMessages") as Y.Array<Y.Map<unknown>>;
  const last = structuredMessages.get(structuredMessages.length - 1);
  expect(last.get("status")).toBe("error");
  expect(last.get("rawOutput")).toEqual({ error: "Permission denied" });
});

// session_update 终端状态应清除 loading
test("session_update done clears loading", () => {
  // 先设置 loading
  applyACPEvent(ydoc, {
    type: "user_message_chunk",
    payload: { content: { type: "text", text: "do it" } },
  });
  const meta = ydoc.getMap("meta") as any;
  expect(meta.get("loading")).not.toBeNull();

  applyACPEvent(ydoc, {
    type: "session_update",
    payload: { sessionUpdate: "done" },
  });
  expect(meta.get("loading")).toBeNull();
  expect(meta.get("status")).toBe("done");
});

// session_update idle 也应清除 loading
test("session_update idle clears loading", () => {
  applyACPEvent(ydoc, {
    type: "user_message_chunk",
    payload: { content: { type: "text", text: "hello" } },
  });
  const meta = ydoc.getMap("meta") as any;
  expect(meta.get("loading")).not.toBeNull();

  applyACPEvent(ydoc, {
    type: "session_update",
    payload: { sessionUpdate: "idle" },
  });
  expect(meta.get("loading")).toBeNull();
});

// session_update ready 应清除 loading：session/load 历史回放后 relay 广播 ready，
// 回放的历史 user_message_chunk 设置的 loading 必须复位，否则切换会话后前端
// isLoading 永久残留（cancel 按钮/输入禁用无法解除）
test("session_update ready clears loading", () => {
  applyACPEvent(ydoc, {
    type: "user_message_chunk",
    payload: { content: { type: "text", text: "hello" } },
  });
  const meta = ydoc.getMap("meta") as any;
  expect(meta.get("loading")).not.toBeNull();

  applyACPEvent(ydoc, {
    type: "session_update",
    payload: { sessionUpdate: "ready" },
  });
  expect(meta.get("loading")).toBeNull();
  expect(meta.get("status")).toBe("ready");
});

// 回放窗口抑制：suppressLoading 时 user_message_chunk 的消息照常写入，
// 但不得设置 loading（回放的历史消息是数据重建，不是新的 turn）
test("user_message_chunk with suppressLoading writes the message but skips loading", () => {
  applyACPEvent(
    ydoc,
    {
      type: "user_message_chunk",
      payload: { content: { type: "text", text: "history" } },
    },
    { suppressLoading: true },
  );
  const meta = ydoc.getMap("meta") as any;
  // 抑制时不写入 loading 字段（未设置，非 null）
  expect(meta.get("loading")).toBeUndefined();
  // 消息内容仍写入 structuredMessages（历史重建依赖）
  const structuredMessages = ydoc.getArray("structuredMessages");
  expect(structuredMessages.length).toBe(1);
  const last = structuredMessages.get(0) as any;
  expect(last.get("content")).toBe("history");
});

// session_error / error 应清除 loading
test("session_error clears loading", () => {
  applyACPEvent(ydoc, {
    type: "user_message_chunk",
    payload: { content: { type: "text", text: "fail" } },
  });
  const meta = ydoc.getMap("meta") as any;
  expect(meta.get("loading")).not.toBeNull();

  applyACPEvent(ydoc, { type: "session_error", payload: {} });
  expect(meta.get("loading")).toBeNull();
  expect(meta.get("status")).toBe("error");
});

// agent_message_complete 应清除 loading（与 prompt_complete 行为一致）
test("agent_message_complete clears loading", () => {
  applyACPEvent(ydoc, {
    type: "user_message_chunk",
    payload: { content: { type: "text", text: "run" } },
  });
  const meta = ydoc.getMap("meta") as any;
  expect(meta.get("loading")).not.toBeNull();

  applyACPEvent(ydoc, { type: "agent_message_complete" });
  expect(meta.get("loading")).toBeNull();
  expect(meta.get("status")).toBe("done");
});
