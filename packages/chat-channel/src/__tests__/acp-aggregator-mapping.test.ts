// packages/chat-channel/src/__tests__/acp-aggregator-mapping.test.ts
// 规范化事件映射测试：幂等写入、重放不重复创建、终态后增量丢弃、
// 旧事件类型被 ACPChannel 拒绝、binding 规则（无 Doc 丢弃）。

import { beforeEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { normalizeAcpMessage } from "../protocol/acp-channel";
import {
  type NonPeriNormalizedEventType,
  type NormalizedEvent,
  type NormalizedPeriTaskEvent,
  PERI_TASK_FALLBACK_TITLE,
  PERI_TASK_SUMMARY_MAX,
  PERI_TASK_VIEW_MAX,
  TURN_TERMINAL_STATUSES,
  type TurnStatus,
} from "../schema";
import { applyNormalizedEvent, type DocPair } from "../state/aggregator";
import {
  ensureEntry,
  getEntry,
  getEntryOrder,
  getPendingPermissions,
  getPeriTaskOrder,
  getPeriTasksMap,
  getSessionInfo,
  getSessionRoot,
  getToolCallsMap,
  setActiveTurn,
  setEntryStatus,
  setSessionInfo,
} from "../state/chat-writer";
import { createChatDoc, createSessionDoc } from "../state/factory";

let pair: DocPair;

beforeEach(() => {
  pair = {
    chat: createChatDoc("rcs_mapping", null).ydoc,
    session: createSessionDoc("rcs_mapping", null).ydoc,
  };
});

function event(
  type: NonPeriNormalizedEventType,
  update: Record<string, unknown> = {},
  turnId?: string,
): NormalizedEvent {
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

// Peri 通过标准 ACP metadata 标记子 Agent；其工具调用不得进入主 Chat Doc。
// 测试 params._meta 身份透传与 Chat Doc 隔离。
test("subagent tool call with ACP metadata does not leak into main entry", () => {
  const normalized = normalizeAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "ses_1",
      _meta: { peri: { sourceAgentId: "child_agent_1" } },
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "sub_tool",
        title: "Bash",
        status: "running",
      },
    },
  });
  expect(normalized?.sourceAgentId).toBe("child_agent_1");

  runTurn(pair, "turn_1");
  const result = applyNormalizedEvent(pair, normalized!);
  expect(result.applied).toBe(false);
  expect(getToolCallsMap(pair.chat).has("sub_tool")).toBe(false);
  const assistant = getEntry(pair.chat, "turn_1:assistant");
  const blocks = assistant?.get("blocks") as Y.Map<Y.Map<unknown>>;
  expect(blocks.get("tool:sub_tool")).toBeUndefined();
});

// 子 Agent 文本即使带有有效内容，也不得追加到主 Agent assistant entry。
test("subagent message with ACP metadata does not leak into main entry", () => {
  const normalized = normalizeAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "ses_1",
      _meta: { peri: { sourceAgentId: "child_agent_1" } },
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "child-only" },
      },
    },
  });
  expect(normalized?.sourceAgentId).toBe("child_agent_1");

  runTurn(pair, "turn_1");
  const assistant = getEntry(pair.chat, "turn_1:assistant");
  const blocks = assistant?.get("blocks") as Y.Map<Y.Map<unknown>>;
  const text = blocks.get("text")?.get("text") as Y.Text;
  const before = text.toString();
  expect(applyNormalizedEvent(pair, normalized!).applied).toBe(false);
  expect(text.toString()).toBe(before);
});

// SubAgent reasoning 使用同一 metadata 契约，也不得进入主 reasoning block。
test("subagent reasoning with ACP metadata does not leak into main entry", () => {
  const normalized = normalizeAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "ses_1",
      _meta: { peri: { sourceAgentId: "child_agent_1" } },
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "child-reasoning" },
      },
    },
  });
  runTurn(pair, "turn_1");
  expect(applyNormalizedEvent(pair, normalized!).applied).toBe(false);
});

// SubAgent tool update/end 与 start 使用相同稳定实例 ID，均不得创建根级工具投影。
test("subagent tool update with ACP metadata does not leak into main entry", () => {
  const normalized = normalizeAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "ses_1",
      _meta: { peri: { sourceAgentId: "child_agent_1" } },
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "sub_tool_update",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "done" } }],
      },
    },
  });
  expect(normalized?.sourceAgentId).toBe("child_agent_1");
  runTurn(pair, "turn_1");
  expect(applyNormalizedEvent(pair, normalized!).applied).toBe(false);
  expect(getToolCallsMap(pair.chat).has("sub_tool_update")).toBe(false);
});

// 主 Agent 历史恢复不携带来源 metadata，工具调用必须正常恢复。
test("history main-agent session update keeps tool call", () => {
  const normalized = normalizeAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "ses_1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "history_tool",
        title: "Read",
        status: "completed",
      },
    },
  });
  expect(normalized?.sourceAgentId).toBeNull();

  runTurn(pair, "turn_replay_1");
  expect(applyNormalizedEvent(pair, normalized!).applied).toBe(true);
  expect(getToolCallsMap(pair.chat).has("history_tool")).toBe(true);
});

// 兼容路径收到 TodoWrite 工具帧时必须拒绝普通工具投影，避免与标准 Plan 双显。
test("history TodoWrite standard tool content does not create tool projection", () => {
  const todos = [{ content: "修复工具显示", status: "in_progress", activeForm: "正在修复工具显示" }];
  const normalized = normalizeAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "ses_1",
      update: {
        sessionUpdate: "tool_call",
        content: { id: "history_todo", type: "tool_use", name: "TodoWrite", input: { todos } },
      },
    },
  });

  runTurn(pair, "turn_replay_1");
  expect(applyNormalizedEvent(pair, normalized!)).toEqual({
    applied: false,
    reason: "TodoWrite is represented by ACP plan",
  });
  expect(getToolCallsMap(pair.chat).has("history_todo")).toBe(false);
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

// 工具状态不可逆（CAS）：completed 后迟到的 tool_call_updated 不得回退状态——
// 网络乱序/重放下 updated 帧晚于终态帧到达时，无条件覆盖会让前端工具永久转圈
test("tool_call_updated cannot revert a terminal tool status", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
  applyNormalizedEvent(pair, event("tool_call_completed", { toolCallId: "t1", title: "bash" }));

  const toolCalls = getToolCallsMap(pair.chat);
  expect(toolCalls.get("t1")?.get("status")).toBe("completed");

  // 迟到的 updated 帧（running）：拒绝，不回退
  const reverted = applyNormalizedEvent(pair, event("tool_call_updated", { toolCallId: "t1", title: "bash" }));
  expect(reverted.applied).toBe(false);
  expect(toolCalls.get("t1")?.get("status")).toBe("completed");

  // 同状态重放（completed → completed）：幂等放行
  const replay = applyNormalizedEvent(pair, event("tool_call_completed", { toolCallId: "t1", title: "bash" }));
  expect(replay.applied).toBe(true);
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
  // activeTurn 保持终态，展示态投影同步为 done（无 loading、不可取消）
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("completed");
  expect(getSessionInfo(pair.session).get("presenting")).toBe("done");
  expect(getSessionInfo(pair.session).get("loading")).toBeNull();
  expect(getSessionInfo(pair.session).get("canCancel")).toBe(false);
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

// 标准 ACP ToolCallUpdate.status 序列化为 snake_case "failed"（ToolCallStatus::Failed，
// 见 agent-client-protocol schema tool_call.rs），必须与私有帧 "error" 收敛为
// tool_call_failed——否则标准工具失败被误判为 started，错误永不进入聚合层
test("标准 ACP tool_call_update status=failed 归一化为 tool_call_failed", () => {
  const normalized = normalizeAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "ses_1",
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" },
    },
  });
  expect(normalized?.type).toBe("tool_call_failed");
  expect(normalized?.acpSessionId).toBe("ses_1");
});

// available_commands_update 通知（agent 启动后下发）归一化为 session_updated，
// 载荷保留 availableCommands，聚合层投影到 Session Doc session map
test("available_commands_update normalizes to session_updated and projects commands", () => {
  const normalized = normalizeAcpMessage({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "ses_1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "help", description: "Show help" },
          { name: "clear", description: "Clear chat", input: { hint: "no args" } },
        ],
      },
    },
  });
  expect(normalized?.type).toBe("session_updated");
  const cmds = normalized?.update.availableCommands as Array<{ name: string; description: string }>;
  expect(cmds).toHaveLength(2);
  expect(cmds[0]?.name).toBe("help");

  const result = applyNormalizedEvent(pair, normalized!);
  expect(result.applied).toBe(true);
  const session = getSessionRoot(pair.session).get("session") as Y.Map<unknown>;
  const availableCommands = session.get("availableCommands") as Y.Array<Y.Map<unknown>>;
  expect(availableCommands.length).toBe(2);
  expect(availableCommands.get(0)?.get("name")).toBe("help");
  expect(availableCommands.get(1)?.get("input")).toEqual({ hint: "no args" });
  // 命令投影不覆盖会话其他元信息
  expect(session.get("sessionId")).toBeUndefined();
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

// session_list 响应（即使空列表）写入列表权威确认标记：前端 bootstrap 据此区分
// "确认无会话"（可安全自动创建）与"列表未到达"（空列表不可信，不得据空列表创建）
test("session_list marks sessionListLoaded even when the list is empty", () => {
  expect(getSessionRoot(pair.session).get("sessionListLoaded")).toBeUndefined();
  applyNormalizedEvent(pair, event("session_list", { sessions: [] }));
  expect(getSessionRoot(pair.session).get("sessionListLoaded")).toBe(true);
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

// 连续 prompt 时旧 turn 的迟到终态（携带 turnId 且与当前活动 turn 不一致）不得终结新 turn：
// 用户连发消息后前一条的 turn_completed 才到达（乱序/回放收敛），若按 active turn 归位
// 会把新 turn 提前置终态，其后全部增量被 canWriteToTurn 丢弃、答案永远不出现。
test("terminal with stale turnId does not terminate the new turn", () => {
  runTurn(pair, "turn_1");
  // 用户连发第二条消息：turn_1 收敛 cancelled，活动 turn 切到 turn_2
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "again" } }, "turn_2"));
  expect(getSessionInfo(pair.session).get("activeTurnId")).toBe("turn_2");

  // turn_1 的迟到终态（携带 turnId=turn_1）到达：stale 校验拒绝，活动 turn 保持 accepting
  applyNormalizedEvent(pair, event("turn_completed", {}, "turn_1"));
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("accepting");

  // turn_2 的增量仍可写入（未被终态封锁），答案正常投影
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "answer" } }));
  expect(getEntry(pair.chat, "turn_2:assistant")?.get("status")).toBe("streaming");
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("running");
  // 展示态投影同步：真实 turn running → responding + loading 非空 + 可取消
  const running = getSessionInfo(pair.session);
  expect(running.get("presenting")).toBe("responding");
  expect(running.get("loading")).toEqual({ kind: "session/respond", since: running.get("activeTurnUpdatedAt") });
  expect(running.get("canCancel")).toBe(true);
});

// 终态携带的 turnId 与活动 turn 一致时正常应用（归属校验不误伤正确的终态）。
test("terminal with matching turnId terminates the active turn", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("turn_completed", {}, "turn_1"));

  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("completed");
  // 终态投影：presenting=done、loading=null、canCancel=false
  const session = getSessionInfo(pair.session);
  expect(session.get("presenting")).toBe("done");
  expect(session.get("loading")).toBeNull();
  expect(session.get("canCancel")).toBe(false);
  expect(getEntry(pair.chat, "turn_1:assistant")?.get("status")).toBe("completed");
});

// 同一 turn 的 plan 是可更新状态，后续快照原位覆盖而非追加多个执行计划面板
test("plan updates replace the current turn plan instead of appending entries", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(
    pair,
    event("plan", {
      entries: [{ content: "inspect files", priority: "medium", status: "in_progress" }],
    }),
  );
  applyNormalizedEvent(
    pair,
    event("plan", {
      entries: [{ content: "inspect files", priority: "medium", status: "completed" }],
    }),
  );

  expect(getEntryOrder(pair.chat).toArray()).toEqual(["turn_1:user", "turn_1:assistant", "plan:turn_1"]);
  expect(getEntry(pair.chat, "plan:turn_1")?.get("planEntries")).toEqual([
    { content: "inspect files", priority: "medium", status: "completed" },
  ]);
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
  // cancelling 投影：仍显示 loading（取消进行中）但不可再取消，防重复点击
  const cancelling = getSessionInfo(pair.session);
  expect(cancelling.get("presenting")).toBe("loading");
  expect(cancelling.get("loading")).not.toBeNull();
  expect(cancelling.get("canCancel")).toBe(false);
  applyNormalizedEvent(pair, event("turn_interrupted"));
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("interrupted");
  // interrupted 终态投影：done，无 loading 与取消
  const interrupted = getSessionInfo(pair.session);
  expect(interrupted.get("presenting")).toBe("done");
  expect(interrupted.get("loading")).toBeNull();
  expect(interrupted.get("canCancel")).toBe(false);
  expect(getEntry(pair.chat, "turn_1:assistant")?.get("status")).toBe("cancelled");
});

// 核心回归：ai → tool×N → ai 场景下两段文本必须分离为独立块。
// 修复前 blockId 固定为 "text"，工具调用后的第二段文本被追加到第一段块，
// 渲染表现为 ai1+2 tool×N；修复后按「顺序相邻」聚合，被打断则新建 text:N 块。
test("text deltas separated by tool calls split into distinct text blocks", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  // 连续文本流应保持单块聚合（不碎片化）
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: " world" } }));

  // 10 个工具调用插入文本流中间
  for (let i = 1; i <= 10; i++) {
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: `t${i}`, title: "bash" }));
  }

  // 工具完成后继续输出文本 → 必须新建 text:1，不得并入第一段
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "after tools" } }));

  const assistant = getEntry(pair.chat, "turn_1:assistant")!;
  const blocks = assistant.get("blocks") as Y.Map<Y.Map<unknown>>;
  const blockOrder = (assistant.get("blockOrder") as Y.Array<string>).toArray();

  expect(blockOrder).toEqual(["text", ...Array.from({ length: 10 }, (_, i) => `tool:t${i + 1}`), "text:1"]);
  expect((blocks.get("text")?.get("text") as Y.Text | undefined)?.toString()).toBe("hello world");
  expect((blocks.get("text:1")?.get("text") as Y.Text | undefined)?.toString()).toBe("after tools");
});

// 多重打断：文本流被工具调用打断两次 → 生成 text / text:1 / text:2 三个独立块
test("multiple interruptions create sequentially numbered text blocks", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "a" } }));
  applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "b" } }));
  applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t2", title: "bash" }));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "c" } }));

  const assistant = getEntry(pair.chat, "turn_1:assistant")!;
  const blocks = assistant.get("blocks") as Y.Map<Y.Map<unknown>>;
  const blockOrder = (assistant.get("blockOrder") as Y.Array<string>).toArray();

  expect(blockOrder).toEqual(["text", "tool:t1", "text:1", "tool:t2", "text:2"]);
  expect((blocks.get("text")?.get("text") as Y.Text | undefined)?.toString()).toBe("a");
  expect((blocks.get("text:1")?.get("text") as Y.Text | undefined)?.toString()).toBe("b");
  expect((blocks.get("text:2")?.get("text") as Y.Text | undefined)?.toString()).toBe("c");
});

// reasoning 与 text 交错：类型不同互不聚合，各自独立编号，visibility 保持
test("reasoning and text interleaving stays in separate blocks", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("reasoning_delta", { content: { type: "reasoning", text: "think1" } }));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "answer1" } }));
  applyNormalizedEvent(pair, event("reasoning_delta", { content: { type: "reasoning", text: "think2" } }));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "answer2" } }));

  const assistant = getEntry(pair.chat, "turn_1:assistant")!;
  const blocks = assistant.get("blocks") as Y.Map<Y.Map<unknown>>;
  const blockOrder = (assistant.get("blockOrder") as Y.Array<string>).toArray();

  expect(blockOrder).toEqual(["reasoning", "text", "reasoning:1", "text:1"]);
  // reasoning 块保持 summary visibility（新建块时同样透传）
  expect(blocks.get("reasoning")?.get("visibility")).toBe("summary");
  expect(blocks.get("reasoning:1")?.get("visibility")).toBe("summary");
  expect((blocks.get("reasoning")?.get("text") as Y.Text | undefined)?.toString()).toBe("think1");
  expect((blocks.get("text:1")?.get("text") as Y.Text | undefined)?.toString()).toBe("answer2");
});

// SP-A3 验收：连续 apply 相同状态的 delta，Session Doc update 计数不随 delta
// 数增长——status 已 streaming、turn 已 running 后，每帧增量对 Session Doc 的
// 冗余写入（setEntryStatus/setActiveTurn 同值 + projectionVersion）全部短路
test("repeated steady-state deltas do not grow session doc update count", () => {
  runTurn(pair, "turn_1"); // user_message + 首个增量（accepting→running）

  let sessionUpdates = 0;
  pair.session.on("update", () => sessionUpdates++);
  for (let i = 0; i < 50; i++) {
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "x" } }));
  }
  expect(sessionUpdates).toBe(0);
});

// SP-A3 验收：setEntryStatus 同值短路零 update；终态 completedAt 首写语义保留
// （短路不得吞掉历史数据缺失 completedAt 时的补写，也不得覆盖已有值）
test("setEntryStatus short-circuits same value and preserves completedAt first-write", () => {
  ensureEntry(pair.chat, { entryId: "e1", turnId: "t1", kind: "message", role: "assistant" });
  let chatUpdates = 0;
  pair.chat.on("update", () => chatUpdates++);

  // pending → streaming 是真实状态迁移：1 次 update
  pair.chat.transact(() => setEntryStatus(pair.chat, "e1", "streaming"));
  expect(chatUpdates).toBe(1);

  // 同值重复设置（流式每帧路径）：零 update
  for (let i = 0; i < 50; i++) pair.chat.transact(() => setEntryStatus(pair.chat, "e1", "streaming"));
  expect(chatUpdates).toBe(1);

  // 终态首写：status 迁移 + completedAt 首次写入（同一事务 1 次 update）
  pair.chat.transact(() => setEntryStatus(pair.chat, "e1", "completed"));
  expect(chatUpdates).toBe(2);
  const entry = getEntry(pair.chat, "e1")!;
  expect(entry.get("status")).toBe("completed");
  expect(entry.get("completedAt")).toBeTruthy();

  // 终态同值重放：零 update 且 completedAt 不被覆盖（收敛/幂等语义不变）
  const completedAt = entry.get("completedAt");
  for (let i = 0; i < 10; i++) pair.chat.transact(() => setEntryStatus(pair.chat, "e1", "completed"));
  expect(chatUpdates).toBe(2);
  expect(entry.get("completedAt")).toBe(completedAt);
});

// SP-A3 验收：setActiveTurn / setSessionInfo 相同值短路——turnId/turnStatus 未变
// 时五组键（activeTurnUpdatedAt/updatedAt/展示态三字段）零重写；patch 无变化时
// 不写 updatedAt
test("setActiveTurn and setSessionInfo short-circuit identical writes", () => {
  setActiveTurn(pair.session, "turn_1", "running");
  setSessionInfo(pair.session, { title: "T" });

  let sessionUpdates = 0;
  pair.session.on("update", () => sessionUpdates++);

  // 相同 turnId + turnStatus：activeTurnUpdatedAt 不再每帧刷新（loading.since
  // 稳定在状态迁移时刻，语义不变）
  for (let i = 0; i < 20; i++) setActiveTurn(pair.session, "turn_1", "running");
  expect(sessionUpdates).toBe(0);

  // 相同 patch：字段级比较后零写入（updatedAt 不刷新）
  for (let i = 0; i < 20; i++) setSessionInfo(pair.session, { title: "T" });
  expect(sessionUpdates).toBe(0);

  // 真实变化（状态迁移）仍正常写入
  setActiveTurn(pair.session, "turn_1", "completed");
  expect(sessionUpdates).toBeGreaterThan(0);
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("completed");
});

// ════════════════════════════════════════════════════════════════════
// Peri Task View（切片 0B + 1）：wire 规范化与 Session Doc 投影
// ════════════════════════════════════════════════════════════════════

// ── normalize 契约：peri/agent_event（Subagent 生命周期）──

// 裸 JSON-RPC subagent_started → peri_task_started（taskId=instance_id，title=agent_name）
test("normalize peri/agent_event subagent_started (bare jsonrpc)", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: {
      sessionId: "ses_1",
      event_json: JSON.stringify({
        type: "subagent_started",
        value: { agent_name: "coder", instance_id: "inst_1", is_background: false },
      }),
    },
  };
  const normalized = normalizeAcpMessage(raw);
  expect(normalized).not.toBeNull();
  const peri = normalized as NormalizedPeriTaskEvent;
  expect(peri.type).toBe("peri_task_started");
  if (peri.type !== "peri_task_started") return;
  expect(peri.taskId).toBe("inst_1");
  expect(peri.kind).toBe("subagent");
  expect(peri.title).toBe("coder");
  expect(peri.isBackground).toBe(false);
  expect(peri.acpSessionId).toBe("ses_1");
});

// 包裹格式 { type: "session_data", payload: jsonrpc } 同样识别（extractJsonRpc 双格式）
test("normalize peri/agent_event inside session_data wrapper", () => {
  const wrapped = {
    type: "session_data",
    payload: {
      jsonrpc: "2.0",
      method: "peri/agent_event",
      params: {
        sessionId: "ses_1",
        event_json: JSON.stringify({
          type: "subagent_stopped",
          value: { agent_name: "coder", instance_id: "inst_1", result: "done", is_error: false },
        }),
      },
    },
  };
  const normalized = normalizeAcpMessage(wrapped);
  expect(normalized).not.toBeNull();
  const peri = normalized as NormalizedPeriTaskEvent;
  expect(peri.type).toBe("peri_task_completed");
  if (peri.type !== "peri_task_completed") return;
  expect(peri.taskId).toBe("inst_1");
  expect(peri.success).toBe(true);
  expect(peri.summary).toBe("done");
  expect(peri.acpSessionId).toBe("ses_1");
});

// subagent_stopped 的 is_error=true → success=false（failed 终态源）
test("normalize subagent_stopped with is_error maps success=false", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: {
      sessionId: "ses_1",
      event_json: JSON.stringify({
        type: "subagent_stopped",
        value: { agent_name: "coder", instance_id: "inst_2", result: "boom", is_error: true },
      }),
    },
  };
  const peri = normalizeAcpMessage(raw) as NormalizedPeriTaskEvent;
  if (peri.type !== "peri_task_completed") throw new Error("expected peri_task_completed");
  expect(peri.success).toBe(false);
});

// 外部 result/output_preview 在写入 Y.Doc 前擦除常见秘密、URL 与本机路径
test("normalize redacts sensitive task summaries before projection", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: {
      sessionId: "ses_1",
      event_json: JSON.stringify({
        type: "subagent_stopped",
        value: {
          agent_name: "coder",
          instance_id: "inst_secret",
          result: "token=live-secret https://internal.example/a /Users/alice/private.txt safe",
          is_error: false,
        },
      }),
    },
  };
  const peri = normalizeAcpMessage(raw) as NormalizedPeriTaskEvent;
  if (peri.type !== "peri_task_completed") throw new Error("expected peri_task_completed");
  expect(peri.summary).toBe("[REDACTED_SECRET] [REDACTED_URL] [REDACTED_PATH] safe");
});

// Task View 维持硬上限，并优先淘汰最早的终态任务而保留运行中任务
test("peri task projection evicts terminal tasks at the bounded limit", () => {
  for (let index = 0; index < PERI_TASK_VIEW_MAX; index += 1) {
    applyNormalizedEvent(pair, {
      type: "peri_task_started",
      update: {},
      content: null,
      taskId: `running_${index}`,
      kind: "background",
      taskSubtype: "shell",
      title: `Task ${index}`,
      summary: null,
      sourceStartedAt: null,
      receivedAt: new Date(index).toISOString(),
      isBackground: true,
      detailAvailability: "unavailable",
    });
  }
  applyNormalizedEvent(pair, {
    type: "peri_task_completed",
    update: {},
    content: null,
    taskId: "terminal_first",
    kind: "background",
    success: true,
    summary: "done",
    durationMs: 1,
    receivedAt: new Date(PERI_TASK_VIEW_MAX).toISOString(),
    detailAvailability: "preview",
  });

  expect(getPeriTasksMap(pair.session).size).toBe(PERI_TASK_VIEW_MAX);
  expect(getPeriTaskOrder(pair.session).length).toBe(PERI_TASK_VIEW_MAX);
  expect(getPeriTasksMap(pair.session).has("terminal_first")).toBe(false);
  expect(getPeriTasksMap(pair.session).has("running_0")).toBe(true);
});

// 非法 event_json（非 JSON）→ null（不拒绝主链路、不生成 unknown Task）
test("normalize rejects non-JSON event_json", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: { sessionId: "ses_1", event_json: "{not-json" },
  };
  expect(normalizeAcpMessage(raw)).toBeNull();
});

// 缺 instance_id / 缺 value → null
test("normalize rejects peri/agent_event missing instance_id or value", () => {
  const noInstance = {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: {
      sessionId: "ses_1",
      event_json: JSON.stringify({ type: "subagent_started", value: { agent_name: "x" } }),
    },
  };
  expect(normalizeAcpMessage(noInstance)).toBeNull();
  const noValue = {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: { sessionId: "ses_1", event_json: JSON.stringify({ type: "subagent_started" }) },
  };
  expect(normalizeAcpMessage(noValue)).toBeNull();
});

// 未知 agent event type（如 compact_completed）→ null，不暴露为 Task
test("normalize ignores unknown peri/agent_event types", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: {
      sessionId: "ses_1",
      event_json: JSON.stringify({ type: "compact_completed", value: { summary: "x", messages_json: "[]" } }),
    },
  };
  expect(normalizeAcpMessage(raw)).toBeNull();
});

// 被拒绝的 peri payload（缺 instance_id）即使携带 token/path sentinel 也不进入
// 任何结构化输出：normalize 返回 null，拒绝路径不记录 raw payload（规格 §一.5/§五）
test("normalize rejects malformed payload without leaking raw sentinels", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: {
      sessionId: "ses_1",
      event_json: JSON.stringify({
        type: "subagent_stopped",
        value: { result: "done" },
        access_token: "secret-token-abc",
        error: { path: "/etc/passwd", stack: "at handler" },
      }),
    },
  };
  expect(normalizeAcpMessage(raw)).toBeNull();
});

// 长 result 按 code point 截断至摘要上限，且不会切断多字节字符
test("normalize truncates subagent result to summary bound safely", () => {
  const long = `${"a".repeat(PERI_TASK_SUMMARY_MAX + 100)}😀`;
  const raw = {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: {
      sessionId: "ses_1",
      event_json: JSON.stringify({
        type: "subagent_stopped",
        value: { agent_name: "c", instance_id: "inst_3", result: long, is_error: false },
      }),
    },
  };
  const peri = normalizeAcpMessage(raw) as NormalizedPeriTaskEvent;
  if (peri.type !== "peri_task_completed") throw new Error("expected peri_task_completed");
  expect(peri.summary?.length).toBe(PERI_TASK_SUMMARY_MAX);
});

// ── normalize 契约：peri/unstable_event（Background Task）──

// bg-task-started → peri_task_started（kind=background，taskSubtype=kind，started_at 透传）
test("normalize peri/unstable_event bg-task-started", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/unstable_event",
    params: {
      sessionId: "ses_1",
      event: "bg-task-started",
      data: { task_id: "t1", kind: "shell", summary: "run tests", started_at: "2026-08-01T00:00:00.000Z" },
    },
  };
  const peri = normalizeAcpMessage(raw) as NormalizedPeriTaskEvent;
  expect(peri.type).toBe("peri_task_started");
  if (peri.type !== "peri_task_started") return;
  expect(peri.taskId).toBe("t1");
  expect(peri.kind).toBe("background");
  expect(peri.taskSubtype).toBe("shell");
  expect(peri.title).toBe("run tests");
  expect(peri.sourceStartedAt).toBe("2026-08-01T00:00:00.000Z");
  expect(peri.isBackground).toBe(true);
});

// bg-task-completed → peri_task_completed（success / output_preview 有界 / duration_ms）
test("normalize peri/unstable_event bg-task-completed", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/unstable_event",
    params: {
      sessionId: "ses_1",
      event: "bg-task-completed",
      data: { task_id: "t1", kind: "agent", success: true, output_preview: "ok", duration_ms: 1234 },
    },
  };
  const peri = normalizeAcpMessage(raw) as NormalizedPeriTaskEvent;
  expect(peri.type).toBe("peri_task_completed");
  if (peri.type !== "peri_task_completed") return;
  expect(peri.taskId).toBe("t1");
  expect(peri.success).toBe(true);
  expect(peri.summary).toBe("ok");
  expect(peri.durationMs).toBe(1234);
});

// bg-task-cancelled → peri_task_cancelled（reason 不进入事件，只留固定 reasonCode）
test("normalize peri/unstable_event bg-task-cancelled drops raw reason", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/unstable_event",
    params: {
      sessionId: "ses_1",
      event: "bg-task-cancelled",
      data: { task_id: "t1", reason: "user-killed-机密路径" },
    },
  };
  const peri = normalizeAcpMessage(raw) as NormalizedPeriTaskEvent;
  expect(peri.type).toBe("peri_task_cancelled");
  if (peri.type !== "peri_task_cancelled") return;
  expect(peri.reasonCode).toBe("cancelled");
  expect(JSON.stringify(peri)).not.toContain("user-killed");
});

// 非法 kind（allowlist 之外）→ taskSubtype 降级 null，不拒绝事件
test("normalize rejects unknown bg-task kind to null subtype", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/unstable_event",
    params: { sessionId: "ses_1", event: "bg-task-started", data: { task_id: "t1", kind: "evil", summary: "s" } },
  };
  const peri = normalizeAcpMessage(raw) as NormalizedPeriTaskEvent;
  if (peri.type !== "peri_task_started") throw new Error("expected peri_task_started");
  expect(peri.taskSubtype).toBeNull();
});

// 非法 timestamp / duration：started_at 非法不拒绝事件（聚合层降级 receivedAt）；
// duration_ms 非法 → null
test("normalize accepts event with invalid timestamp and duration", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/unstable_event",
    params: {
      sessionId: "ses_1",
      event: "bg-task-started",
      data: { task_id: "t1", kind: "shell", summary: "s", started_at: "not-a-date" },
    },
  };
  const started = normalizeAcpMessage(raw) as NormalizedPeriTaskEvent;
  if (started.type !== "peri_task_started") throw new Error("expected peri_task_started");
  expect(started.sourceStartedAt).toBe("not-a-date"); // 透传，聚合层校验

  const completed = {
    jsonrpc: "2.0",
    method: "peri/unstable_event",
    params: {
      sessionId: "ses_1",
      event: "bg-task-completed",
      data: { task_id: "t1", kind: "shell", success: true, output_preview: "p", duration_ms: "NaN" },
    },
  };
  const done = normalizeAcpMessage(completed) as NormalizedPeriTaskEvent;
  if (done.type !== "peri_task_completed") throw new Error("expected peri_task_completed");
  expect(done.durationMs).toBeNull();
});

// 未知 unstable event 名 → null（不生成 unknown Task）
test("normalize ignores unknown peri/unstable_event event names", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/unstable_event",
    params: { sessionId: "ses_1", event: "bg-task-snapshot", data: { task_id: "t1" } },
  };
  expect(normalizeAcpMessage(raw)).toBeNull();
});

// 错误 method `peri/unstable-event`（横线别名）不被识别 → null
test("normalize does not recognize hyphented method alias", () => {
  const raw = {
    jsonrpc: "2.0",
    method: "peri/unstable-event",
    params: { sessionId: "ses_1", event: "bg-task-started", data: { task_id: "t1" } },
  };
  expect(normalizeAcpMessage(raw)).toBeNull();
});

// ── aggregator 投影：Peri Task View 状态机 ──

/** 构造 peri_task_started 规范化事件（测试辅助） */
function periStarted(overrides: Partial<NormalizedPeriTaskEvent> = {}): NormalizedPeriTaskEvent {
  return {
    type: "peri_task_started",
    update: {},
    content: null,
    taskId: "t1",
    kind: "background",
    taskSubtype: "shell",
    title: "run tests",
    summary: "run tests",
    sourceStartedAt: "2026-08-01T00:00:00.000Z",
    receivedAt: "2026-08-01T00:01:00.000Z",
    isBackground: true,
    detailAvailability: "preview",
    ...overrides,
  } as NormalizedPeriTaskEvent;
}

/** 构造 peri_task_completed 规范化事件（测试辅助） */
function periCompleted(overrides: Partial<NormalizedPeriTaskEvent> = {}): NormalizedPeriTaskEvent {
  return {
    type: "peri_task_completed",
    update: {},
    content: null,
    taskId: "t1",
    kind: "background",
    success: true,
    summary: "ok",
    durationMs: 100,
    receivedAt: "2026-08-01T00:02:00.000Z",
    detailAvailability: "preview",
    ...overrides,
  } as NormalizedPeriTaskEvent;
}

// started → running 创建，taskOrder append；无 active turn 也可写入（与 turn 解耦）
test("peri task started projects running view without an active turn", () => {
  applyNormalizedEvent(pair, periStarted());
  const tasks = getPeriTasksMap(pair.session);
  expect(tasks.size).toBe(1);
  const task = tasks.get("t1")!;
  expect(task.get("status")).toBe("running");
  expect(task.get("kind")).toBe("background");
  expect(task.get("taskSubtype")).toBe("shell");
  expect(task.get("title")).toBe("run tests");
  expect(task.get("startedAt")).toBe("2026-08-01T00:00:00.000Z");
  expect(getPeriTaskOrder(pair.session).toArray()).toEqual(["t1"]);
});

// completed 后 started 到达 → 忽略（终态不可回退）
test("peri task started after terminal is ignored", () => {
  applyNormalizedEvent(pair, periStarted());
  applyNormalizedEvent(pair, periCompleted());
  const result = applyNormalizedEvent(pair, periStarted());
  expect(result.applied).toBe(false);
  const task = getPeriTasksMap(pair.session).get("t1")!;
  expect(task.get("status")).toBe("completed");
  // taskOrder 不重排
  expect(getPeriTaskOrder(pair.session).toArray()).toEqual(["t1"]);
});

// 重复 started 不重复创建（taskOrder 不追加第二次）
test("duplicate peri task started does not duplicate order", () => {
  applyNormalizedEvent(pair, periStarted());
  const result = applyNormalizedEvent(pair, periStarted());
  expect(result.applied).toBe(true);
  expect(getPeriTasksMap(pair.session).size).toBe(1);
  expect(getPeriTaskOrder(pair.session).toArray()).toEqual(["t1"]);
});

// completed-before-started（terminal-first）：先创建终态，晚到的 started 忽略
test("peri task completed-before-started creates terminal view", () => {
  applyNormalizedEvent(pair, periCompleted());
  const tasks = getPeriTasksMap(pair.session);
  expect(tasks.get("t1")?.get("status")).toBe("completed");
  expect(tasks.get("t1")?.get("title")).toBe(PERI_TASK_FALLBACK_TITLE);
  // 晚到 started：忽略，保留首次终态
  const result = applyNormalizedEvent(pair, periStarted());
  expect(result.applied).toBe(false);
  expect(tasks.get("t1")?.get("status")).toBe("completed");
  expect(getPeriTaskOrder(pair.session).toArray()).toEqual(["t1"]);
});

// running + terminal → terminal（completedAt = receivedAt，不反推 startedAt）
test("peri task running transitions to terminal on completed", () => {
  applyNormalizedEvent(pair, periStarted());
  applyNormalizedEvent(pair, periCompleted({ receivedAt: "2026-08-01T00:05:00.000Z" }));
  const task = getPeriTasksMap(pair.session).get("t1")!;
  expect(task.get("status")).toBe("completed");
  expect(task.get("completedAt")).toBe("2026-08-01T00:05:00.000Z");
  // startedAt 保持 started 事件提供的合法 started_at
  expect(task.get("startedAt")).toBe("2026-08-01T00:00:00.000Z");
});

// 失败（success=false）→ failed 终态
test("peri task failed maps success=false to failed status", () => {
  applyNormalizedEvent(pair, periStarted());
  applyNormalizedEvent(pair, periCompleted({ success: false }));
  expect(getPeriTasksMap(pair.session).get("t1")?.get("status")).toBe("failed");
});

// 相同终态重复到达 → 幂等忽略（不补写）
test("peri task duplicate terminal is ignored", () => {
  applyNormalizedEvent(pair, periCompleted());
  const result = applyNormalizedEvent(pair, periCompleted());
  expect(result.applied).toBe(false);
  expect(getPeriTasksMap(pair.session).get("t1")?.get("status")).toBe("completed");
});

// 不同终态冲突（completed vs cancelled）→ 保留首次终态，返回脱敏冲突 reason
// （reason 不含任何 payload / token 字段）
test("peri task terminal conflict keeps first terminal with sanitized reason", () => {
  applyNormalizedEvent(pair, periCompleted());
  const cancelled = {
    type: "peri_task_cancelled",
    update: {},
    content: null,
    taskId: "t1",
    kind: "background",
    reasonCode: "cancelled",
    receivedAt: "2026-08-01T00:03:00.000Z",
    detailAvailability: "unavailable",
  } as NormalizedPeriTaskEvent;
  const result = applyNormalizedEvent(pair, cancelled);
  expect(result.applied).toBe(false);
  expect(result.reason).toContain("terminal conflict");
  expect(result.reason).not.toContain("t1");
  expect(getPeriTasksMap(pair.session).get("t1")?.get("status")).toBe("completed");
});

// subagent 生命周期：started（title=agent_name）→ stopped（completed）且 stopped
// 不覆盖 started 提供的 title / isBackground（identity 字段保留）
test("peri subagent completed preserves started identity fields", () => {
  applyNormalizedEvent(pair, periStarted({ kind: "subagent", taskSubtype: null, title: "coder", isBackground: false }));
  applyNormalizedEvent(pair, periCompleted({ kind: "subagent", taskSubtype: null, title: "", summary: "result text" }));
  const task = getPeriTasksMap(pair.session).get("t1")!;
  expect(task.get("status")).toBe("completed");
  expect(task.get("title")).toBe("coder"); // started 提供的 title 不被覆盖
  expect(task.get("isBackground")).toBe(false); // 终态事件无 is_background，不覆盖
  expect(task.get("summary")).toBe("result text");
});

// 非法 started_at（background）：降级为 receivedAt，不拒绝事件
test("peri task invalid started_at falls back to receivedAt", () => {
  applyNormalizedEvent(pair, periStarted({ sourceStartedAt: "not-a-date", receivedAt: "2026-08-01T00:01:00.000Z" }));
  const task = getPeriTasksMap(pair.session).get("t1")!;
  expect(task.get("startedAt")).toBe("2026-08-01T00:01:00.000Z");
});
