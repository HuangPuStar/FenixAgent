// packages/chat-channel/src/__tests__/doc-manager.test.ts
// DocManager 内存生命周期与会话隔离测试：只覆盖不依赖 Redis、WebSocket 或真实进程的投影边界。

import { beforeEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { type NormalizedEvent } from "../schema";
import {
  getAgentStatus,
  getEntriesMap,
  getEntryOrder,
  getPendingPermissions,
  getPendingQuestions,
  getSessionInfo,
} from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";

let manager: DocManager;

beforeEach(() => {
  manager = new DocManager({ acpBatchWindowMs: 1_000 });
});

/** 构造最小规范化事件，保持测试数据与聚合入口的协议一致。 */
function event(type: NormalizedEvent["type"], update: Record<string, unknown>, turnId?: string): NormalizedEvent {
  return {
    type,
    update,
    content: (update.content as Record<string, unknown>) ?? null,
    turnId,
  };
}

// 未绑定的 session 收到事件必须直接丢弃，不能为其他租户或旧会话隐式创建 Doc。
test("drops events for an unopened session without affecting an opened session", async () => {
  const logs: string[] = [];
  manager = new DocManager({ onLog: (message) => logs.push(message) });
  await manager.openChat("rcs_tenant_a");
  await manager.openSession("user-a", "agent-a", "rcs_tenant_a");

  manager.processNormalizedEvent(
    "rcs_tenant_b",
    event("user_message", { content: { type: "text", text: "must not leak" } }, "turn-b"),
  );

  expect(manager.openedDocCount()).toEqual({ chat: 1, session: 1 });
  expect(manager.getChat("rcs_tenant_b")).toBeUndefined();
  expect(manager.getSession("rcs_tenant_b")).toBeUndefined();
  expect(getEntryOrder(manager.getChatYdoc("rcs_tenant_a")!).toArray()).toEqual([]);
  expect(logs).toEqual(["[DocManager] Session rcs_tenant_b not in memory, event dropped"]);

  await manager.closeAll();
});

// 同一 RCS session 的 Chat 与 Session Doc 必须共享 generation，跨 session 不得共享实例或内容。
test("keeps paired generations and user-message timelines isolated by RCS session", async () => {
  const chatA = await manager.openChat("rcs_tenant_a");
  const sessionA = await manager.openSession("user-a", "agent-a", "rcs_tenant_a");
  const chatB = await manager.openChat("rcs_tenant_b");
  const sessionB = await manager.openSession("user-b", "agent-b", "rcs_tenant_b");

  manager.processNormalizedEvent(
    "rcs_tenant_a",
    event("user_message", { content: { type: "text", text: "private message" } }, "turn-a"),
  );

  expect(manager.getProjectionGeneration("rcs_tenant_a")).toBe(chatA.generation);
  expect(chatA.generation).toBe(sessionA.generation);
  expect(chatB.generation).toBe(sessionB.generation);
  expect(chatA.ydoc).not.toBe(chatB.ydoc);
  expect(sessionA.ydoc).not.toBe(sessionB.ydoc);
  expect(getEntryOrder(chatA.ydoc).toArray()).toHaveLength(2);
  expect(getEntryOrder(chatB.ydoc).toArray()).toEqual([]);

  await manager.closeAll();
});

// 关闭 session 时必须取消其延迟批次；随后重开不得投影关闭前的增量，避免跨生命周期串话。
test("cancels buffered deltas when a session closes before reopening", async () => {
  const chat = await manager.openChat("rcs_reused");
  await manager.openSession("user-a", "agent-a", "rcs_reused");

  manager.processNormalizedEvent(
    "rcs_reused",
    event("message_delta", { content: { type: "text", text: "stale delta" } }),
  );
  await manager.closeSession("rcs_reused");
  await manager.openSession("user-b", "agent-b", "rcs_reused");

  expect(manager.getSession("rcs_reused")).toBeDefined();
  expect(getEntryOrder(chat.ydoc).toArray()).toEqual([]);

  await manager.closeAll();
});

function textOf(managerToRead: DocManager, rcsSessionId: string, turnId: string): string {
  const entry = getEntriesMap(managerToRead.getChatYdoc(rcsSessionId)!).get(`${turnId}:assistant`);
  const blocks = entry?.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
  return (blocks?.get("text")?.get("text") as Y.Text | undefined)?.toString() ?? "";
}

// 同一 RCS session 的连续文本增量必须在批处理窗口内合并，并保持原有流式顺序。
test("batches text deltas for one RCS session without losing their order", async () => {
  manager = new DocManager({ acpBatchWindowMs: 5 });
  await manager.openChat("rcs_batch");
  await manager.openSession("user-1", "agent-1", "rcs_batch");
  const turnId = manager.registerUserMessage("rcs_batch", "question");

  manager.processNormalizedEvent("rcs_batch", event("message_delta", { content: { type: "text", text: "first " } }));
  manager.processNormalizedEvent("rcs_batch", event("message_delta", { content: { type: "text", text: "second" } }));
  await Bun.sleep(15);

  expect(textOf(manager, "rcs_batch", turnId)).toBe("first second");
  await manager.closeAll();
});

// 两个 RCS session 的批处理缓冲必须相互隔离，不能把一个租户的文本写入另一个时间线。
test("keeps buffered text deltas isolated between RCS sessions", async () => {
  manager = new DocManager({ acpBatchWindowMs: 5 });
  for (const rcsSessionId of ["rcs_a", "rcs_b"]) {
    await manager.openChat(rcsSessionId);
    await manager.openSession("user-1", "agent-1", rcsSessionId);
  }
  const turnA = manager.registerUserMessage("rcs_a", "a");
  const turnB = manager.registerUserMessage("rcs_b", "b");

  manager.processNormalizedEvent("rcs_a", event("message_delta", { content: { type: "text", text: "private-a" } }));
  manager.processNormalizedEvent("rcs_b", event("message_delta", { content: { type: "text", text: "private-b" } }));
  await Bun.sleep(15);

  expect(textOf(manager, "rcs_a", turnA)).toBe("private-a");
  expect(textOf(manager, "rcs_b", turnB)).toBe("private-b");
  await manager.closeAll();
});

// 控制类状态更新必须先刷新已经缓冲的文本，避免完成状态先到而吞掉最后的输出。
test("flushes buffered text before applying a terminal state update", async () => {
  manager = new DocManager({ acpBatchWindowMs: 1_000 });
  await manager.openChat("rcs_control");
  await manager.openSession("user-1", "agent-1", "rcs_control");
  const turnId = manager.registerUserMessage("rcs_control", "question");

  manager.processNormalizedEvent(
    "rcs_control",
    event("message_delta", { content: { type: "text", text: "final text" } }),
  );
  manager.processNormalizedEvent("rcs_control", event("turn_completed", {}));

  expect(textOf(manager, "rcs_control", turnId)).toBe("final text");
  expect(getSessionInfo(manager.getSessionYdoc("rcs_control")!).get("activeTurnStatus")).toBe("completed");
  await manager.closeAll();
});

// 有效 agent status 必须只更新对应会话的 Session Doc，不能污染另一条 RCS 连接状态。
test("projects agent status only to its matching RCS session", async () => {
  for (const rcsSessionId of ["rcs_status_a", "rcs_status_b"]) {
    await manager.openChat(rcsSessionId);
    await manager.openSession("user-1", "agent-1", rcsSessionId);
  }

  manager.processNormalizedEvent(
    "rcs_status_a",
    event("agent_status", { instanceId: "instance-a", status: "ready", capabilities: { loadSession: true } }),
  );

  expect(getAgentStatus(manager.getSessionYdoc("rcs_status_a")!).get("instanceId")).toBe("instance-a");
  expect(getAgentStatus(manager.getSessionYdoc("rcs_status_b")!).get("instanceId")).toBeUndefined();
  await manager.closeAll();
});

// 空 capabilities 的重连状态不得覆盖已就绪能力，防止前端错误降级为未初始化。
test("preserves ready capabilities when a reconnect status omits them", async () => {
  await manager.openChat("rcs_reconnect");
  await manager.openSession("user-1", "agent-1", "rcs_reconnect");
  manager.processNormalizedEvent(
    "rcs_reconnect",
    event("agent_status", { status: "ready", capabilities: { loadSession: true } }),
  );
  manager.processNormalizedEvent(
    "rcs_reconnect",
    event("agent_status", { status: "initializing", capabilities: null }),
  );

  const capabilities = getAgentStatus(manager.getSessionYdoc("rcs_reconnect")!).get("capabilities") as Y.Map<unknown>;
  expect(capabilities.toJSON()).toEqual({ loadSession: true });
  expect(getAgentStatus(manager.getSessionYdoc("rcs_reconnect")!).get("status")).toBe("initializing");
  await manager.closeAll();
});

// 权限请求投影成功后必须通知控制面，并以 Session Doc 中实际的过期时间为准。
test("notifies permission scheduling from the projected permission state", async () => {
  const notifications: Array<{ rcsSessionId: string; permissionId: string; expiresAt: string }> = [];
  manager.setPermissionRequestedHandler((rcsSessionId, permission) =>
    notifications.push({ rcsSessionId, ...permission }),
  );
  await manager.openChat("rcs_permission");
  await manager.openSession("user-1", "agent-1", "rcs_permission");
  manager.registerUserMessage("rcs_permission", "question");

  manager.processNormalizedEvent(
    "rcs_permission",
    event("permission_requested", { permissionId: "perm-1", expiresAt: "2030-01-01T00:00:00.000Z" }),
  );

  expect(notifications).toEqual([
    { rcsSessionId: "rcs_permission", permissionId: "perm-1", expiresAt: "2030-01-01T00:00:00.000Z" },
  ]);
  expect(getPendingPermissions(manager.getSessionYdoc("rcs_permission")!).get("perm-1")?.get("status")).toBe("pending");
  await manager.closeAll();
});

// 非法权限载荷必须被拒绝，且不能误触发超时调度或创建悬挂权限。
test("rejects malformed permission requests without scheduling a timer", async () => {
  const notifications: string[] = [];
  manager.setPermissionRequestedHandler((_rcsSessionId, permission) => notifications.push(permission.permissionId));
  await manager.openChat("rcs_invalid_permission");
  await manager.openSession("user-1", "agent-1", "rcs_invalid_permission");
  manager.registerUserMessage("rcs_invalid_permission", "question");

  manager.processNormalizedEvent("rcs_invalid_permission", event("permission_requested", {}));

  expect(notifications).toEqual([]);
  expect(getPendingPermissions(manager.getSessionYdoc("rcs_invalid_permission")!).size).toBe(0);
  await manager.closeAll();
});

// 问题请求投影成功后必须通知控制面，确保 reconnect 后的交互请求仍会按独立 RCS session 过期。
test("notifies question scheduling for the requesting RCS session", async () => {
  const notifications: Array<{ rcsSessionId: string; questionId: string }> = [];
  manager.setQuestionRequestedHandler((rcsSessionId, question) =>
    notifications.push({ rcsSessionId, questionId: question.questionId }),
  );
  await manager.openChat("rcs_question");
  await manager.openSession("user-1", "agent-1", "rcs_question");
  manager.registerUserMessage("rcs_question", "question");

  manager.processNormalizedEvent(
    "rcs_question",
    event("question_requested", { questionId: "question-1", questions: [{ question: "continue?", options: ["yes"] }] }),
  );

  expect(notifications).toEqual([{ rcsSessionId: "rcs_question", questionId: "question-1" }]);
  expect(getPendingQuestions(manager.getSessionYdoc("rcs_question")!).get("question-1")?.get("status")).toBe("pending");
  await manager.closeAll();
});

// 非法问题载荷不能创建待处理条目，避免前端出现永远无法回答的弹窗。
test("rejects malformed question requests without projecting a pending question", async () => {
  await manager.openChat("rcs_invalid_question");
  await manager.openSession("user-1", "agent-1", "rcs_invalid_question");
  manager.registerUserMessage("rcs_invalid_question", "question");

  manager.processNormalizedEvent("rcs_invalid_question", event("question_requested", {}));

  expect(getPendingQuestions(manager.getSessionYdoc("rcs_invalid_question")!).size).toBe(0);
  await manager.closeAll();
});

// 换代必须为同一 RCS session 原子创建同 generation 的新文档，并丢弃旧时间线。
test("replaces an RCS projection with a new generation and empty timeline", async () => {
  const chat = await manager.openChat("rcs_generation");
  await manager.openSession("user-1", "agent-1", "rcs_generation");
  manager.registerUserMessage("rcs_generation", "old message");

  const replacement = await manager.replaceProjection("rcs_generation", "ses-new");

  expect(replacement.generation).not.toBe(chat.generation);
  expect(manager.getProjectionGeneration("rcs_generation")).toBe(replacement.generation);
  expect(getEntryOrder(replacement.chat.ydoc).toArray()).toEqual([]);
  expect(replacement.targetAcpSessionId).toBe("ses-new");
  await manager.closeAll();
});

// closeAll 必须取消所有会话的未落盘批次并释放 Chat/Session 资源，避免关闭后迟到写入。
test("releases every document and cancels pending batches on closeAll", async () => {
  manager = new DocManager({ acpBatchWindowMs: 1_000 });
  await manager.openChat("rcs_close_a");
  await manager.openSession("user-1", "agent-1", "rcs_close_a");
  await manager.openChat("rcs_close_b");
  await manager.openSession("user-1", "agent-1", "rcs_close_b");
  manager.registerUserMessage("rcs_close_a", "question");
  manager.processNormalizedEvent("rcs_close_a", event("message_delta", { content: { type: "text", text: "stale" } }));

  await manager.closeAll();
  await Bun.sleep(5);

  expect(manager.openedDocCount()).toEqual({ chat: 0, session: 0 });
  expect(manager.getChatYdoc("rcs_close_a")).toBeUndefined();
});

// 内存广播必须携带各自的 RCS Doc 名称，防止订阅端将不同会话的增量合并。
test("broadcasts updates with RCS-scoped document names", async () => {
  const broadcasts: string[] = [];
  manager = new DocManager({ onYjsUpdate: (docName) => broadcasts.push(docName) });
  await manager.openChat("rcs_broadcast_a");
  await manager.openSession("user-1", "agent-1", "rcs_broadcast_a");
  await manager.openChat("rcs_broadcast_b");
  await manager.openSession("user-1", "agent-1", "rcs_broadcast_b");
  broadcasts.length = 0;

  manager.registerUserMessage("rcs_broadcast_a", "private message");

  expect(broadcasts).toContain("chat:rcs_broadcast_a");
  expect(broadcasts).not.toContain("chat:rcs_broadcast_b");
  expect(broadcasts).not.toContain("session:rcs_broadcast_b");
  await manager.closeAll();
});
