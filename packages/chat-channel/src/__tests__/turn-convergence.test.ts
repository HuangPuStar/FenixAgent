// turn 收敛语义测试（H1/H2/H3/H6/M2）：
// 「turn 离开活动态」统一经 convergeTurnExit 收敛（assistant entry 终态 +
// 权限失效 + 工具收敛）；权限决议/过期按 turnId 归属校验；用户连发清理旧 turn
// 残留；历史 turn 重放不顶掉当前 turn。这些边界是权限/工具状态反复出错的根因区。

import { beforeEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { type NormalizedEvent } from "../schema";
import { applyNormalizedEvent, type DocPair } from "../state/aggregator";
import {
  getEntry,
  getPendingPermissions,
  getSessionInfo,
  getToolCallsMap,
  setActiveTurn,
  upsertPendingPermission,
  upsertToolCall,
} from "../state/chat-writer";
import { createChatDoc, createSessionDoc } from "../state/factory";
import { applyPermissionResolution } from "../state/permission";

let pair: DocPair;

beforeEach(() => {
  pair = {
    chat: createChatDoc("rcs_converge", null).ydoc,
    session: createSessionDoc("rcs_converge", null).ydoc,
  };
});

function event(type: NormalizedEvent["type"], update: Record<string, unknown> = {}, turnId?: string): NormalizedEvent {
  return {
    type,
    update,
    content: (update.content as Record<string, unknown>) ?? null,
    turnId,
  };
}

/** 完整跑一轮 turn（用户消息 → 增量 → 完成），返回 turnId */
function runTurn(pairToUse: DocPair, turnId: string): void {
  applyNormalizedEvent(pairToUse, event("user_message", { content: { type: "text", text: "hi" } }, turnId));
  applyNormalizedEvent(pairToUse, event("message_delta", { content: { type: "text", text: "hello" } }));
}

// H2：权限决议按 permission.turnId 归属收敛——权限属于旧 turn 而 active 已是新
// turn 时（用户拖沓点击/控制面迟发），决议只迁移自身，不得把新 turn 的
// awaiting_permission 恢复为 running（否则新 turn 在权限未被批准时被误恢复执行）
test("stale permission resolution does not resume the new turn", () => {
  // 直接构造控制面场景：旧 turn 的权限仍 pending，active 已切到新 turn
  upsertPendingPermission(pair.session, {
    permissionId: "p1",
    turnId: "turn_1",
    toolCallId: null,
    title: "Approve",
    description: null,
    options: ["allow_once", "deny"],
    status: "pending",
    decision: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  setActiveTurn(pair.session, "turn_2", "awaiting_permission");

  expect(applyPermissionResolution(pair, "p1", "allow")).toBe(true);
  // p1 自身 CAS 迁移成功（语义不变）
  expect(getPendingPermissions(pair.session).get("p1")?.get("status")).toBe("resolved");
  // 但 turn 状态机不被旧决议恢复
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("awaiting_permission");
});

// H2：旧 turn 的迟到决议不得收敛新 turn 的工具——即使决议携带的 toolCallId
// 恰好命中新 turn 的工具（异常数据），turnId 归属校验也必须拒绝触碰
test("stale permission resolution does not cancel tools of the new turn", () => {
  upsertToolCall(pair.chat, {
    toolCallId: "t2",
    turnId: "turn_2",
    name: "bash",
    status: "running",
    arguments: null,
    result: undefined,
  });
  upsertPendingPermission(pair.session, {
    permissionId: "p1",
    turnId: "turn_1",
    toolCallId: "t2",
    title: "Approve",
    description: null,
    options: ["allow_once", "deny"],
    status: "pending",
    decision: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  setActiveTurn(pair.session, "turn_2", "awaiting_permission");

  applyPermissionResolution(pair, "p1", "deny");
  expect(getToolCallsMap(pair.chat).get("t2")?.get("status")).toBe("running");
});

// H3：权限全部失效 → turn 退出经 convergeTurnExit 统一收敛——assistant entry
// 一并置 cancelled（修复前 entry 永久 streaming，前端"一直在等待"）
test("expiring the last permission converges the turn exit via single entry", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("permission_requested", { permissionId: "p1", title: "Approve" }));
  applyNormalizedEvent(pair, event("permission_expired", { permissionId: "p1" }));

  expect(getPendingPermissions(pair.session).get("p1")?.get("status")).toBe("expired");
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("cancelled");
  expect(getEntry(pair.chat, "turn_1:assistant")?.get("status")).toBe("cancelled");
});

// H6：turn 终态收敛 running 工具 → cancelled（agent 取消后不再发工具终态帧，
// running 是死状态；修复前只收敛 awaiting_permission，running 永久转圈）
test("turn terminal converges running tools to cancelled", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
  expect(getToolCallsMap(pair.chat).get("t1")?.get("status")).toBe("running");

  applyNormalizedEvent(pair, event("turn_cancelled", {}));
  expect(getToolCallsMap(pair.chat).get("t1")?.get("status")).toBe("cancelled");
  expect(getEntry(pair.chat, "turn_1:assistant")?.get("status")).toBe("cancelled");
});

// H6：awaiting_permission 工具随 turn 终态收敛为 cancelled（既有行为保持）
test("turn terminal cancels awaiting_permission tools", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
  applyNormalizedEvent(
    pair,
    event("permission_requested", {
      permissionId: "p1",
      title: "Approve",
      toolCallId: "t1",
    }),
  );
  expect(getToolCallsMap(pair.chat).get("t1")?.get("status")).toBe("awaiting_permission");

  applyNormalizedEvent(pair, event("turn_cancelled", {}));
  expect(getToolCallsMap(pair.chat).get("t1")?.get("status")).toBe("cancelled");
});

// H1：用户连发时旧 turn 的权限残留清理——convergeTurnExit 在 applyUserMessage
// 的旧 turn 收敛路径生效（修复前只置 entry 终态，pending 权限残留可被旧决议
// 重新激活，前端残留过期授权按钮）
test("new user message expires pending permissions of the previous turn", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("permission_requested", { permissionId: "p1", title: "Approve" }));
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "again" } }, "turn_2"));

  expect(getPendingPermissions(pair.session).get("p1")?.get("status")).toBe("expired");
  expect(getSessionInfo(pair.session).get("activeTurnId")).toBe("turn_2");
});

// H1：用户连发时旧 turn 的 running 工具一并收敛为 cancelled（同一收敛路径）
test("new user message cancels running tools of the previous turn", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "again" } }, "turn_2"));

  expect(getToolCallsMap(pair.chat).get("t1")?.get("status")).toBe("cancelled");
  expect(getSessionInfo(pair.session).get("activeTurnId")).toBe("turn_2");
});

// M2：历史 turn 的 user_message 重放不顶掉当前 turn——幂等判定按 user entry
// 存在性而非 active.turnId（修复前按 active 判定，历史回放会把 active 顶回旧
// turn，其后当前 turn 的全部增量被丢弃、答案永远不出现）
test("replayed user_message of an old turn does not hijack the active turn", () => {
  runTurn(pair, "turn_1");
  applyNormalizedEvent(pair, event("turn_completed", { usage: { totalTokens: 3 } }, "turn_1"));
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q2" } }, "turn_2"));
  expect(getSessionInfo(pair.session).get("activeTurnId")).toBe("turn_2");

  // 历史回放重发 turn_1 的 user_message：entry 已存在 → 拒绝
  const replay = applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q1" } }, "turn_1"));
  expect(replay.applied).toBe(false);
  expect(getSessionInfo(pair.session).get("activeTurnId")).toBe("turn_2");

  // turn_1 的 user entry 未被重复创建/改写（文本仍是首次写入的 "hi"）
  const userBlocks = getEntry(pair.chat, "turn_1:user")?.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
  expect((userBlocks?.get("text")?.get("text") as Y.Text | undefined)?.toString() ?? "").toBe("hi");
});
