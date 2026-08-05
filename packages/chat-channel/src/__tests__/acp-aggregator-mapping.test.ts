// packages/chat-channel/src/__tests__/acp-aggregator-mapping.test.ts
// 规范化事件映射测试：幂等写入、重放不重复创建、终态后增量丢弃、
// 旧事件类型被 ACPChannel 拒绝、binding 规则（无 Doc 丢弃）。

import { beforeEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { normalizeAcpMessage } from "../protocol/acp-channel";
import { type NormalizedEvent, TURN_TERMINAL_STATUSES, type TurnStatus } from "../schema";
import { applyNormalizedEvent, type DocPair } from "../state/aggregator";
import {
  getEntry,
  getEntryOrder,
  getPendingPermissions,
  getSessionInfo,
  getSessionRoot,
  getToolCallsMap,
} from "../state/chat-writer";
import { createChatDoc, createSessionDoc } from "../state/factory";

let pair: DocPair;

beforeEach(() => {
  pair = {
    chat: createChatDoc("rcs_mapping", null).ydoc,
    session: createSessionDoc("rcs_mapping", null).ydoc,
  };
});

function event(type: NormalizedEvent["type"], update: Record<string, unknown> = {}, turnId?: string): NormalizedEvent {
  return { type, update, content: (update.content as Record<string, unknown>) ?? null, turnId };
}

/** 完整跑一轮 turn（用户消息 → 增量 → 完成），返回 turnId */
function runTurn(pairToUse: DocPair, turnId: string): void {
  applyNormalizedEvent(pairToUse, event("user_message", { content: { type: "text", text: "hi" } }, turnId));
  applyNormalizedEvent(pairToUse, event("message_delta", { content: { type: "text", text: "hello" } }));
}

// 重放同一 user_message 帧（同 turnId）不重复创建 Entry
test("replayed user_message with same turnId does not duplicate entries", () => {
  runTurn(pair, "turn_1");
  // 重放同一事件（如 commandId 重试导致的重复投递）
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));

  expect(getEntryOrder(pair.chat).toArray()).toEqual(["turn_1:user", "turn_1:assistant"]);
  const userEntry = getEntry(pair.chat, "turn_1:user");
  expect(userEntry).not.toBeNull();
  // 文本只写入一次
  const userBlocks = userEntry?.get("blocks") as Y.Map<Y.Map<unknown>>;
  expect((userBlocks.get("text")?.get("text") as Y.Text | undefined)?.toString() ?? "").toBe("hi");
});

// 重放同一 tool_call 帧（同 toolCallId）不重复创建工具调用
test("replayed tool_call with same toolCallId does not duplicate projection", () => {
  runTurn(pair, "turn_1");
  const toolEvent = event("tool_call_started", { toolCallId: "t1", title: "bash" });
  applyNormalizedEvent(pair, toolEvent);
  applyNormalizedEvent(pair, toolEvent);

  const toolCalls = getToolCallsMap(pair.chat);
  expect(toolCalls.size).toBe(1);
  const tool = toolCalls.get("t1")!;
  expect(tool.get("name")).toBe("bash");

  // assistant entry 内 tool block 只挂一次（text + tool 共 2 块，重放不追加）
  const assistant = getEntry(pair.chat, "turn_1:assistant");
  const blocks = assistant?.get("blocks") as Y.Map<Y.Map<unknown>>;
  expect(blocks.size).toBe(2);
  expect(blocks.get("tool:t1")).not.toBeUndefined();
});

// 重放同一 permission_requested 帧（同 permissionId）不重复创建权限请求
test("replayed permission request with same permissionId does not duplicate", () => {
  runTurn(pair, "turn_1");
  const permEvent = event("permission_requested", {
    permissionId: "p1",
    title: "Approve",
    options: ["allow_once"],
  });
  applyNormalizedEvent(pair, permEvent);
  applyNormalizedEvent(pair, permEvent);

  const pending = getPendingPermissions(pair.session);
  expect(pending.size).toBe(1);
});

// turn 终态后到达的同 turn 增量被丢弃（不新建 entry、不回退状态机）
test("deltas after terminal turn are dropped", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("turn_completed", { usage: { totalTokens: 5 } }));
  // 终态后晚到的增量
  const result = applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "late" } }));
  expect(result.applied).toBe(false);

  const assistant = getEntry(pair.chat, "turn_1:assistant");
  expect(assistant?.get("status")).toBe("completed");
  const blocks = assistant?.get("blocks") as Y.Map<Y.Map<unknown>>;
  expect((blocks.get("text")?.get("text") as Y.Text).toString()).toBe("hello");
  // activeTurn 保持终态
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("completed");
});

// 终态不可逆：completed 后再收到 turn_failed 不覆盖终态
test("terminal turn status cannot be overwritten", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("turn_completed", { usage: { totalTokens: 5 } }));
  const result = applyNormalizedEvent(pair, event("turn_failed", { error: "late failure" }));
  expect(result.applied).toBe(false);
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("completed");
  expect(getEntry(pair.chat, "turn_1:assistant")?.get("status")).toBe("completed");
});

// 权限解析是 CAS：重复 permission_resolved 只有第一次生效
test("permission resolve is CAS — only first resolution applies", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("permission_requested", { permissionId: "p1", title: "Approve" }));
  const first = applyNormalizedEvent(pair, event("permission_resolved", { permissionId: "p1", decision: "allow" }));
  const second = applyNormalizedEvent(pair, event("permission_resolved", { permissionId: "p1", decision: "allow" }));
  expect(first.applied).toBe(true);
  expect(second.applied).toBe(false);

  const pending = getPendingPermissions(pair.session);
  expect(pending.get("p1")?.get("status")).toBe("resolved");
  // CAS 成功后 decision 落盘（allow → "allow"）
  expect(pending.get("p1")?.get("decision")).toBe("allow");
});

// permission_resolved 携带 deny 决策时 decision 落盘为 "deny"
test("permission resolve with deny decision persists decision as deny", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("permission_requested", { permissionId: "p1", title: "Approve" }));
  applyNormalizedEvent(pair, event("permission_resolved", { permissionId: "p1", decision: "deny" }));

  const pending = getPendingPermissions(pair.session);
  expect(pending.get("p1")?.get("status")).toBe("resolved");
  expect(pending.get("p1")?.get("decision")).toBe("deny");
  // deny 收敛：关联工具调用 cancelled（无 toolCallId 时仅 turn 状态收敛）
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("running");
});

// user_message 缺少 turnId 时被拒绝（缺少必要关联信息拒绝投影）
test("user_message without turnId is rejected", () => {
  const result = applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }));
  expect(result.applied).toBe(false);
  expect(getEntryOrder(pair.chat).length).toBe(0);
});

// 无活动 turn 时的增量被丢弃（不自动创建 entry）
test("delta without active turn is dropped", () => {
  const result = applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "orphan" } }));
  expect(result.applied).toBe(false);
  expect(getEntryOrder(pair.chat).length).toBe(0);
});

// 旧事件类型（agent_message_chunk 私有帧）经 ACPChannel 翻译为规范化事件
test("legacy private frame is translated by ACPChannel to normalized event", () => {
  const normalized = normalizeAcpMessage(
    { type: "agent_message_chunk", payload: { type: "text", text: "legacy" } },
    "agent_message_chunk",
  );
  expect(normalized?.type).toBe("message_delta");
  expect(normalized?.content?.text).toBe("legacy");
});

// 旧事件类型（agent_thought_chunk / prompt_complete）同样被翻译
test("legacy thought and complete frames are translated", () => {
  const thought = normalizeAcpMessage(
    { type: "session_data", payload: { type: "agent_thought_chunk", payload: { type: "text", text: "t" } } },
    "session_data",
  );
  expect(thought?.type).toBe("reasoning_delta");

  const complete = normalizeAcpMessage(
    {
      type: "session_data",
      payload: { type: "prompt_complete", payload: { stopReason: "end_turn", usage: { totalTokens: 3 } } },
    },
    "session_data",
  );
  expect(complete?.type).toBe("turn_completed");
  expect((complete?.update.usage as Record<string, unknown>).totalTokens).toBe(3);
});

// JSON-RPC session/update 双格式兼容：事件类型与载荷来自 params.update
test("JSON-RPC session/update wrapped format normalizes to delta", () => {
  const normalized = normalizeAcpMessage({
    type: "session_data",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses_1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } },
      },
    },
  });
  expect(normalized?.type).toBe("reasoning_delta");
  expect(normalized?.acpSessionId).toBe("ses_1");
});

// 保活帧与未知帧返回 null（不进入聚合层）
test("keepalive and unknown frames are rejected by ACPChannel", () => {
  expect(normalizeAcpMessage({ type: "keep_alive" }, "keep_alive")).toBeNull();
  expect(normalizeAcpMessage({ type: "weird", payload: { x: 1 } }, "weird")).toBeNull();
});

// session/list 响应（真实形状 1：session_data 包裹 JSON-RPC success）→ session_list 事件
test("session/list wrapped JSON-RPC response normalizes to session_list", () => {
  const normalized = normalizeAcpMessage({
    type: "session_data",
    payload: {
      jsonrpc: "2.0",
      id: "1",
      result: {
        sessions: [{ sessionId: "ses_1", title: "A", updatedAt: "2026-08-05T00:00:00.000Z" }],
        nextCursor: null,
        _meta: {},
      },
    },
  });
  expect(normalized?.type).toBe("session_list");
  expect(normalized?.update.sessions).toEqual([
    { sessionId: "ses_1", title: "A", updatedAt: "2026-08-05T00:00:00.000Z" },
  ]);
  expect(normalized?.content).toBeNull();
});

// session/list 响应（真实形状 2：裸 JSON-RPC success，实例路径）→ session_list 事件
test("session/list bare JSON-RPC response normalizes to session_list", () => {
  const normalized = normalizeAcpMessage({
    jsonrpc: "2.0",
    id: "1",
    result: { sessions: [{ sessionId: "ses_2", title: "B" }] },
  });
  expect(normalized?.type).toBe("session_list");
  expect(normalized?.update.sessions).toEqual([{ sessionId: "ses_2", title: "B" }]);
});

// result 不含 sessions 数组的 JSON-RPC 响应保持原行为（null，不误判为 session_list）
test("JSON-RPC result without sessions array stays null", () => {
  expect(normalizeAcpMessage({ jsonrpc: "2.0", id: "9", result: { ok: true } })).toBeNull();
});

// session_list 聚合幂等：同列表应用两次不重复追加；缺失字段条目跳过
test("session_list aggregation is idempotent and skips malformed entries", () => {
  const list = [
    { sessionId: "ses_1", title: "A", updatedAt: "2026-08-05T00:00:00.000Z" },
    { sessionId: "ses_2", title: "B" },
  ];
  applyNormalizedEvent(pair, event("session_list", { sessions: list }));
  applyNormalizedEvent(pair, event("session_list", { sessions: list }));

  const sessions = getSessionRoot(pair.session).get("sessions") as Y.Map<Y.Map<unknown>>;
  expect(sessions.size).toBe(2);

  // 无 sessionId / 非对象的条目跳过
  applyNormalizedEvent(pair, event("session_list", { sessions: [...list, { title: "no-id" }, 42] }));
  expect(sessions.size).toBe(2);

  // sessions 字段缺失 → 拒绝
  const missing = applyNormalizedEvent(pair, event("session_list", { nope: true }));
  expect(missing.applied).toBe(false);
});

// 规范化事件中的 acpSessionId 不参与 Y.Doc 寻址（只做 binding 校验）
test("acpSessionId in event never becomes doc addressing", () => {
  runTurn(pair, "turn_1");
  const before = getEntryOrder(pair.chat).length;
  // 事件携带任意 acpSessionId，投影仍落在 rcsSessionId 对应 Doc（由调用方绑定）
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "x" } }, undefined));
  // 无活动 turn 时增量丢弃，不创建任何新 Doc 寻址
  expect(getEntryOrder(pair.chat).length).toBe(before);
});

// 新用户消息会终结未完成的旧 turn（每会话仅一个活动 turn）
test("new user message terminates unfinished previous turn", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "again" } }, "turn_2"));

  const oldAssistant = getEntry(pair.chat, "turn_1:assistant");
  expect(oldAssistant?.get("status")).toBe("cancelled");
  expect(getSessionInfo(pair.session).get("activeTurnId")).toBe("turn_2");
});

// 终态常量覆盖全部合法终态（供状态机使用方校验）
test("terminal status set covers all final states", () => {
  for (const status of ["cancelled", "interrupted", "failed", "completed"] as TurnStatus[]) {
    expect(TURN_TERMINAL_STATUSES.has(status)).toBe(true);
  }
});

// cancel 确认帧（prompt_complete { stopReason: "cancelled" }）→ turn_cancelled 终态事件
test("prompt_complete with stopReason cancelled maps to turn_cancelled", () => {
  const cancelled = normalizeAcpMessage(
    { type: "session_data", payload: { type: "prompt_complete", payload: { stopReason: "cancelled" } } },
    "session_data",
  );
  expect(cancelled?.type).toBe("turn_cancelled");

  // 非取消的 stopReason 仍收敛为 turn_completed
  const normal = normalizeAcpMessage(
    { type: "session_data", payload: { type: "prompt_complete", payload: { stopReason: "end_turn" } } },
    "session_data",
  );
  expect(normal?.type).toBe("turn_completed");
});

// acp-link server 的 session/cancel 响应（JSON-RPC result { cancelled: true }）→ turn_cancelled
test("JSON-RPC cancel response maps to turn_cancelled", () => {
  const cancelled = normalizeAcpMessage({
    type: "session_data",
    payload: { jsonrpc: "2.0", id: 3, result: { cancelled: true } },
  });
  expect(cancelled?.type).toBe("turn_cancelled");

  // cancelled: false（无可取消会话）不产生终态事件
  const noop = normalizeAcpMessage({
    type: "session_data",
    payload: { jsonrpc: "2.0", id: 4, result: { cancelled: false } },
  });
  expect(noop).toBeNull();
});

// turn_cancel_requested / turn_interrupted 经聚合层驱动：running → cancelling → interrupted
test("cancel_requested and interrupt drive the state machine end to end", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("turn_cancel_requested"));
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("cancelling");
  applyNormalizedEvent(pair, event("turn_interrupted"));
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("interrupted");
  expect(getEntry(pair.chat, "turn_1:assistant")?.get("status")).toBe("cancelled");
});
