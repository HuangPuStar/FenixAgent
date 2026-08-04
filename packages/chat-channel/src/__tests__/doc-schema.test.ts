// packages/chat-channel/src/__tests__/doc-schema.test.ts
// 新 schema（文档 5.2/5.3）结构测试：初始化结构、projectionVersion 演进、
// tombstone 清理、Doc 职责错位纠正（Chat Doc 无状态字段、Session Doc 无时间线字段）。

import { beforeEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { CHAT_DOC_SCHEMA_VERSION, type NormalizedEvent, SESSION_DOC_SCHEMA_VERSION } from "../schema";
import { applyNormalizedEvent, type DocPair } from "../state/aggregator";
import {
  clearChatDocContent,
  clearSessionDocContent,
  getChatRoot,
  getEntryOrder,
  getSessionRoot,
} from "../state/chat-writer";
import { createChatDoc, createSessionDoc } from "../state/factory";

let pair: DocPair;

beforeEach(() => {
  pair = {
    chat: createChatDoc("rcs_test", null).ydoc,
    session: createSessionDoc("rcs_test", null).ydoc,
  };
});

/** 构造规范化事件（测试辅助） */
function event(type: NormalizedEvent["type"], update: Record<string, unknown> = {}, turnId?: string): NormalizedEvent {
  return {
    type,
    update,
    content: (update.content as Record<string, unknown>) ?? null,
    turnId,
  };
}

/** 读取 Chat Doc 根键集合（验证职责边界） */
function chatRootKeys(): string[] {
  return Array.from(getChatRoot(pair.chat).keys()).sort();
}

/** 读取 Session Doc 根键集合 */
function sessionRootKeys(): string[] {
  return Array.from(getSessionRoot(pair.session).keys()).sort();
}

// Chat Doc 初始化后根键只有时间线相关字段（schemaVersion/projectionVersion/entryOrder/entries/toolCalls）
test("chat doc root contains only timeline fields", () => {
  expect(chatRootKeys()).toEqual(["entries", "entryOrder", "projectionVersion", "schemaVersion", "toolCalls"]);
  expect(getChatRoot(pair.chat).get("schemaVersion")).toBe(CHAT_DOC_SCHEMA_VERSION);
  expect(getChatRoot(pair.chat).get("projectionVersion")).toBe(1);
});

// Session Doc 初始化后根键只有元信息字段（session/agent/pendingPermissions）
test("session doc root contains only metadata fields", () => {
  expect(sessionRootKeys()).toEqual(["agent", "pendingPermissions", "projectionVersion", "schemaVersion", "session"]);
  expect(getSessionRoot(pair.session).get("schemaVersion")).toBe(SESSION_DOC_SCHEMA_VERSION);
});

// Doc 职责错位纠正：Chat Doc 不存在任何旧状态字段（agentInfo/sessions/chatMeta/connection/permissions 等）
test("chat doc has no legacy state fields", () => {
  const legacy = [
    "agentInfo",
    "sessions",
    "chatMeta",
    "connection",
    "permissions",
    "capabilities",
    "modelState",
    "modeState",
    "availableCommands",
    "tokenUsage",
    "messages",
    "streaming",
    "tools",
    "artifacts",
    "structuredMessages",
  ];
  for (const field of legacy) {
    expect(chatRootKeys()).not.toContain(field);
    expect(pair.chat.getMap(field).size).toBe(0);
  }
});

// Doc 职责错位纠正：Session Doc 不存在任何时间线字段
test("session doc has no timeline fields", () => {
  const legacy = ["messages", "streaming", "tools", "artifacts", "structuredMessages", "meta"];
  for (const field of legacy) {
    expect(sessionRootKeys()).not.toContain(field);
    expect(pair.session.getMap(field).size).toBe(0);
  }
});

// 每次成功投影后两份 Doc 的 projectionVersion 各 +1（描述镜像进度，与 schemaVersion 无关）
test("projectionVersion bumps on each applied event", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
  expect(getChatRoot(pair.chat).get("projectionVersion")).toBe(3);
  expect(getSessionRoot(pair.session).get("projectionVersion")).toBe(3);

  // 被拒绝的事件（终态后增量）不 bump
  applyNormalizedEvent(pair, event("turn_completed", { usage: { totalTokens: 10 } }));
  const before = getChatRoot(pair.chat).get("projectionVersion") as number;
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "late" } }));
  expect(getChatRoot(pair.chat).get("projectionVersion")).toBe(before);
});

// 完整消息时间线投影：user entry + assistant entry（含 Y.Text 流式块）
test("user message creates user and assistant entries with text blocks", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "Hello" } }));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: " world" } }));

  const order = getEntryOrder(pair.chat).toArray();
  expect(order).toEqual(["turn_1:user", "turn_1:assistant"]);

  const entries = getChatRoot(pair.chat).get("entries") as Y.Map<Y.Map<unknown>>;
  const user = entries.get("turn_1:user")!;
  expect(user.get("kind")).toBe("message");
  expect(user.get("role")).toBe("user");
  expect(user.get("status")).toBe("completed");

  const assistant = entries.get("turn_1:assistant")!;
  expect(assistant.get("status")).toBe("streaming");
  const blocks = assistant.get("blocks") as Y.Map<Y.Map<unknown>>;
  const textBlock = blocks.get("text") as Y.Map<unknown>;
  expect(textBlock.get("type")).toBe("text");
  // 流式文本使用 Y.Text 累积，而非整串替换
  const ytext = textBlock.get("text") as Y.Text;
  expect(ytext.toString()).toBe("Hello world");
});

// 思考块按 summary 可见性投影到 assistant entry
test("reasoning delta appends to reasoning block with summary visibility", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q" } }, "turn_1"));
  applyNormalizedEvent(pair, event("reasoning_delta", { content: { type: "text", text: "think..." } }));

  const entries = getChatRoot(pair.chat).get("entries") as Y.Map<Y.Map<unknown>>;
  const assistant = entries.get("turn_1:assistant")!;
  const blocks = assistant.get("blocks") as Y.Map<Y.Map<unknown>>;
  const reasoning = blocks.get("reasoning") as Y.Map<unknown>;
  expect(reasoning.get("type")).toBe("reasoning");
  expect(reasoning.get("visibility")).toBe("summary");
  expect((reasoning.get("text") as Y.Text).toString()).toBe("think...");
});

// 工具调用投影：toolCalls 收敛在 Chat Doc 根，entry 内挂 tool_call block
test("tool call projects to toolCalls map and entry block", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q" } }, "turn_1"));
  applyNormalizedEvent(
    pair,
    event("tool_call_started", { toolCallId: "t1", title: "read_file", rawInput: { path: "/a" } }),
  );
  applyNormalizedEvent(pair, event("tool_call_completed", { toolCallId: "t1", rawOutput: { text: "ok" } }));

  const toolCalls = getChatRoot(pair.chat).get("toolCalls") as Y.Map<Y.Map<unknown>>;
  const tool = toolCalls.get("t1")!;
  expect(tool.get("name")).toBe("read_file");
  expect(tool.get("status")).toBe("completed");
  expect(tool.get("turnId")).toBe("turn_1");

  const entries = getChatRoot(pair.chat).get("entries") as Y.Map<Y.Map<unknown>>;
  const assistant = entries.get("turn_1:assistant")!;
  const blocks = assistant.get("blocks") as Y.Map<Y.Map<unknown>>;
  expect(blocks.get("tool:t1")?.get("type")).toBe("tool_call");
});

// 权限请求投影到 Session Doc pendingPermissions（pending 状态）
test("permission request projects to session doc pendingPermissions", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q" } }, "turn_1"));
  applyNormalizedEvent(
    pair,
    event("permission_requested", {
      permissionId: "p1",
      title: "Run command",
      options: ["allow_once", "reject_always"],
      toolCallId: "t1",
    }),
  );

  const pending = getSessionRoot(pair.session).get("pendingPermissions") as Y.Map<Y.Map<unknown>>;
  const permission = pending.get("p1")!;
  expect(permission.get("status")).toBe("pending");
  expect(permission.get("title")).toBe("Run command");
  expect(permission.get("options")).toEqual(["allow_once", "deny"]);
  expect(permission.get("turnId")).toBe("turn_1");
  expect(permission.get("toolCallId")).toBe("t1");
});

// Agent 状态与能力投影到 Session Doc agent
test("agent status projects to session doc agent", () => {
  applyNormalizedEvent(
    pair,
    event("agent_status", {
      instanceId: "inst_1",
      acpSessionId: "ses_1",
      status: "ready",
      capabilities: { loadSession: true, promptCapabilities: { image: true } },
    }),
  );

  const agent = getSessionRoot(pair.session).get("agent") as Y.Map<unknown>;
  expect(agent.get("instanceId")).toBe("inst_1");
  expect(agent.get("acpSessionId")).toBe("ses_1");
  expect(agent.get("status")).toBe("ready");
  const caps = agent.get("capabilities") as Y.Map<boolean>;
  expect(caps.get("loadSession")).toBe(true);
});

// tombstone 清理：切换会话时清空两份 Doc 但保留 schema 骨架，projectionVersion 提升
test("clear resets docs keeping schema skeleton and bumping projectionVersion", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));

  pair.chat.transact(() => {
    getChatRoot(pair.chat).set("planSeq", 1);
  });

  const chatVersionBefore = getChatRoot(pair.chat).get("projectionVersion") as number;
  // 使用与 doc-manager 相同的清理原语（领域 tombstone：清内容、留骨架、升版本）
  clearChatDocContent(pair.chat);
  clearSessionDocContent(pair.session);

  // 骨架保留
  expect(getChatRoot(pair.chat).get("schemaVersion")).toBe(CHAT_DOC_SCHEMA_VERSION);
  expect(chatRootKeys()).toEqual(["entries", "entryOrder", "projectionVersion", "schemaVersion", "toolCalls"]);
  expect(getEntryOrder(pair.chat).length).toBe(0);
  expect((getChatRoot(pair.chat).get("entries") as Y.Map<unknown>).size).toBe(0);
  expect((getChatRoot(pair.chat).get("toolCalls") as Y.Map<unknown>).size).toBe(0);
  // planSeq 是投影派生的临时序号，随清理一并移除
  expect(getChatRoot(pair.chat).get("planSeq")).toBeUndefined();
  // projectionVersion 演进
  expect(getChatRoot(pair.chat).get("projectionVersion")).toBeGreaterThan(chatVersionBefore);
  expect(sessionRootKeys()).toEqual(["agent", "pendingPermissions", "projectionVersion", "schemaVersion", "session"]);
});
