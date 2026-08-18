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
  getSessionRoot,
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

// 展示态投影（Q12）：setActiveTurn 同步投影 session.presenting / loading / canCancel，
// 前端只读不再自行派生——真实 turn running 展示 responding+loading+可取消，回放 turn
// turn_replay_* 展示 replaying 且抑制 loading/canCancel，idle 与终态均无 loading/取消。
test("setActiveTurn projects presenting/loading/canCancel for frontend consumption", () => {
  // accepting（消息刚发出）：展示 loading，可取消
  setActiveTurn(pair.session, "turn_live_1", "accepting");
  const accepting = getSessionInfo(pair.session);
  expect(accepting.get("presenting")).toBe("loading");
  expect(accepting.get("loading")).toEqual({ kind: "session/respond", since: accepting.get("activeTurnUpdatedAt") });
  expect(accepting.get("canCancel")).toBe(true);

  // 真实 turn running（正文流式输出期间）：展示 responding，loading 非空，可取消
  setActiveTurn(pair.session, "turn_live_1", "running");
  const running = getSessionInfo(pair.session);
  expect(running.get("presenting")).toBe("responding");
  expect(running.get("loading")).toEqual({ kind: "session/respond", since: running.get("activeTurnUpdatedAt") });
  expect(running.get("canCancel")).toBe(true);

  // awaiting_permission（权限卡住）：展示 waiting-user，可取消但无 loading 指示
  setActiveTurn(pair.session, "turn_live_1", "awaiting_permission");
  const waiting = getSessionInfo(pair.session);
  expect(waiting.get("presenting")).toBe("waiting-user");
  expect(waiting.get("loading")).toBeNull();
  expect(waiting.get("canCancel")).toBe(true);

  // 回放 turn running（历史回显而非实时输出）：展示 replaying，抑制伪 loading 与停止按钮
  setActiveTurn(pair.session, "turn_replay_123", "running");
  const replay = getSessionInfo(pair.session);
  expect(replay.get("presenting")).toBe("replaying");
  expect(replay.get("loading")).toBeNull();
  expect(replay.get("canCancel")).toBe(false);

  // 清空 turn（无活动 turn）：展示 idle，无 loading 与取消
  setActiveTurn(pair.session, null, null);
  const idle = getSessionInfo(pair.session);
  expect(idle.get("presenting")).toBe("idle");
  expect(idle.get("loading")).toBeNull();
  expect(idle.get("canCancel")).toBe(false);

  // 终态与失败：展示 done/error，无 loading 与取消
  setActiveTurn(pair.session, "turn_live_1", "completed");
  const done = getSessionInfo(pair.session);
  expect(done.get("presenting")).toBe("done");
  expect(done.get("loading")).toBeNull();
  expect(done.get("canCancel")).toBe(false);
  setActiveTurn(pair.session, "turn_live_1", "failed");
  expect(getSessionInfo(pair.session).get("presenting")).toBe("error");
});

// ── Peri Task 与 turn 状态机解耦（切片 1）──

/** 构造 background task started 规范化事件（与 protocol/acp-channel 输出字段一致） */
function periBackgroundStarted(taskId: string): NormalizedEvent {
  return {
    type: "peri_task_started",
    update: {},
    content: null,
    taskId,
    kind: "background",
    taskSubtype: "shell",
    title: "run tests",
    summary: "started",
    sourceStartedAt: null,
    receivedAt: "2026-08-18T00:00:00.000Z",
    isBackground: true,
    detailAvailability: "preview",
  };
}

// Peri Task 是独立于 turn 的会话级投影：active turn 存在时 background task 可写入，
// 且不得影响 turn 状态机（不误收敛 active turn、不改变 presenting）
test("peri background task does not converge or alter the active turn", () => {
  setActiveTurn(pair.session, "turn_live_1", "running");
  const before = getSessionInfo(pair.session);
  expect(before.get("presenting")).toBe("responding");

  applyNormalizedEvent(pair, periBackgroundStarted("bg_1"));

  const tasks = getSessionRoot(pair.session).get("tasks") as Y.Map<Y.Map<unknown>>;
  expect(tasks.size).toBe(1);
  expect(tasks.get("bg_1")?.get("status")).toBe("running");
  // turn 状态不变（未被 peri 事件终结/恢复）
  const after = getSessionInfo(pair.session);
  expect(after.get("activeTurnId")).toBe("turn_live_1");
  expect(after.get("activeTurnStatus")).toBe("running");
  expect(after.get("presenting")).toBe("responding");
});

// turn 已终态（completed）后，background task 生命周期仍可独立推进：
// task 终态写入不依赖 turn 存在，消息时间线已收敛也不影响任务投影
test("peri background task terminal still projects after turn terminal", () => {
  setActiveTurn(pair.session, "turn_1", "completed");
  applyNormalizedEvent(pair, periBackgroundStarted("bg_1"));
  applyNormalizedEvent(pair, {
    type: "peri_task_completed",
    update: {},
    content: null,
    taskId: "bg_1",
    kind: "background",
    success: true,
    summary: "output preview",
    durationMs: 1200,
    receivedAt: "2026-08-18T00:01:00.000Z",
    detailAvailability: "preview",
  });

  const tasks = getSessionRoot(pair.session).get("tasks") as Y.Map<Y.Map<unknown>>;
  expect(tasks.get("bg_1")?.get("status")).toBe("completed");
  expect(tasks.get("bg_1")?.get("summary")).toBe("output preview");
  // turn 状态机不受影响
  expect(getSessionInfo(pair.session).get("activeTurnStatus")).toBe("completed");
});
