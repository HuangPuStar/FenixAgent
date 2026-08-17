// web/src/__tests__/use-chat-state.test.ts
// - computeTokenSnapshot 倒序扫描（SP-B4）行为等价性测试：
//   取 entryOrder 中最后一个带 tokenUsage 的 assistant entry，找到即停；
//   无任何 usage 时返回 null。倒序化后语义与原正向全扫等价，
//   但长会话流式批次不再付 O(N) 全量扫描成本。
// - computeMetaSnapshot 子树级按需派生（SP-B5 / 根因 B5）：sessions /
//   permissions / modelState / modeState / availableCommands / capabilities
//   各自独立缓存——未变子树引用稳定（===），变更子树按 observeDeep dirty
//   标记精准重建（消费者 useMemo 依赖比较得以命中）。

import { describe, expect, test } from "bun:test";
import {
  createSessionDoc,
  setAgentStatus,
  setSessionAvailableCommands,
  setSessionInfo,
  upsertPendingPermission,
} from "@fenix/chat-channel";
import * as Y from "yjs";
import { computeMetaSnapshot, computeTokenSnapshot } from "../hooks/use-chat-state";

/** 在 Chat Doc 中追加一个 message entry（kind/role 可选携带 tokenUsage） */
function appendEntry(ydoc: Y.Doc, entryId: string, role: "user" | "assistant", tokenUsage?: unknown) {
  ydoc.transact(() => {
    const root = ydoc.getMap("root");
    const order = root.get("entryOrder") as Y.Array<string>;
    const entries = root.get("entries") as Y.Map<Y.Map<unknown>>;
    const entry = new Y.Map<unknown>();
    entry.set("kind", "message");
    entry.set("role", role);
    if (tokenUsage !== undefined) entry.set("tokenUsage", tokenUsage);
    entries.set(entryId, entry);
    order.push([entryId]);
  });
}

/** 初始化 Chat Doc 骨架（root.entryOrder + root.entries） */
function createChatDoc(): Y.Doc {
  const ydoc = new Y.Doc();
  ydoc.transact(() => {
    const root = ydoc.getMap("root");
    root.set("entryOrder", new Y.Array<string>());
    root.set("entries", new Y.Map<Y.Map<unknown>>());
  });
  return ydoc;
}

describe("computeTokenSnapshot 倒序扫描", () => {
  // 多条 usage 取时间线上最后一条：tokenUsage 随 turn 终态追加，
  // UI 必须展示最近一次 turn 的真实用量而非历史值
  test("多条 usage 取最后一条", () => {
    const ydoc = createChatDoc();
    appendEntry(ydoc, "e1", "user");
    appendEntry(ydoc, "e2", "assistant", { totalTokens: 10 });
    appendEntry(ydoc, "e3", "user");
    appendEntry(ydoc, "e4", "assistant", { totalTokens: 99, outputTokens: 42 });

    expect(computeTokenSnapshot(ydoc).tokenUsage).toEqual({ totalTokens: 99, outputTokens: 42 });
  });

  // 中间有 usage、尾部 assistant 无 usage：取最后一个命中的（倒序找到即停语义），
  // 不因尾部未携带 usage 的 assistant entry 而回退为 null
  test("尾部 assistant 无 usage 时取更早的最后一个 usage", () => {
    const ydoc = createChatDoc();
    appendEntry(ydoc, "e1", "assistant", { totalTokens: 7 });
    appendEntry(ydoc, "e2", "assistant");

    expect(computeTokenSnapshot(ydoc).tokenUsage).toEqual({ totalTokens: 7 });
  });

  // 无任何 usage：返回 null（输入框/ContextPanel 的空态兜底）
  test("无 usage 返回 null", () => {
    const ydoc = createChatDoc();
    appendEntry(ydoc, "e1", "user");
    appendEntry(ydoc, "e2", "assistant");

    expect(computeTokenSnapshot(ydoc).tokenUsage).toBeNull();
  });

  // 空 doc（快照未到达）：早退返回 null，不抛 Yjs "Invalid access"
  test("Chat Doc 未同步时返回 null", () => {
    const ydoc = new Y.Doc();
    expect(computeTokenSnapshot(ydoc).tokenUsage).toBeNull();
  });

  // user entry 即使携带 tokenUsage 也不参与判定（usage 只属于 assistant turn）
  test("user entry 的 tokenUsage 不被采纳", () => {
    const ydoc = createChatDoc();
    appendEntry(ydoc, "e1", "user", { totalTokens: 5 });

    expect(computeTokenSnapshot(ydoc).tokenUsage).toBeNull();
  });
});

// ── computeMetaSnapshot 子树级按需派生（SP-B5）──

/**
 * 写入 modelState（镜像 setSessionModelState 的存储形状：session.modelState
 * 为嵌套 Y.Map{currentModelId, availableModels: Y.Array<Y.Map>}）。
 * 直接构造而非调用包内 writer：setSessionModelState 未在包导出面暴露。
 */
function writeModelState(
  ydoc: Y.Doc,
  state: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> },
): void {
  const session = ydoc.getMap("root").get("session") as Y.Map<unknown>;
  const models = new Y.Array<Y.Map<unknown>>();
  for (const m of state.availableModels) {
    const entry = new Y.Map<unknown>();
    entry.set("modelId", m.modelId);
    entry.set("name", m.name);
    models.push([entry]);
  }
  const modelState = new Y.Map<unknown>();
  modelState.set("currentModelId", state.currentModelId);
  modelState.set("availableModels", models);
  session.set("modelState", modelState);
}

/** 构造一份带基础元数据的 Session Doc（session + agent + sessions + 权限 + 模型态） */
function createMetaDoc(): Y.Doc {
  const ydoc = createSessionDoc("rcs_meta", null).ydoc;
  setSessionInfo(ydoc, { sessionId: "ses-1", title: "工作会话", status: "ready" });
  setAgentStatus(ydoc, { instanceId: "inst-1", capabilities: { promptCapabilities: true } });
  writeModelState(ydoc, {
    currentModelId: "m1",
    availableModels: [
      { modelId: "m1", name: "Model One" },
      { modelId: "m2", name: "Model Two" },
    ],
  });
  const sessions = ydoc.getMap("root").get("sessions") as Y.Map<Y.Map<unknown>>;
  ydoc.transact(() => {
    for (const [sid, title] of [
      ["ses-1", "会话一"],
      ["ses-2", "会话二"],
    ] as const) {
      const entry = new Y.Map<unknown>();
      entry.set("title", title);
      entry.set("updatedAt", "2026-08-17T00:00:00.000Z");
      sessions.set(sid, entry);
    }
  });
  upsertPendingPermission(ydoc, {
    permissionId: "p1",
    turnId: "turn_1",
    toolCallId: null,
    title: "运行命令",
    description: null,
    options: ["allow_once", "deny"],
    status: "pending",
    decision: null,
    expiresAt: "2026-08-17T01:00:00.000Z",
  });
  return ydoc;
}

describe("computeMetaSnapshot 子树级按需派生", () => {
  // sessions map 单独变化：只重建 sessions 子树，其余子树引用稳定（===）
  test("sessions 变更只重建 sessions 子树", () => {
    const ydoc = createMetaDoc();
    const before = computeMetaSnapshot(ydoc);

    const sessions = ydoc.getMap("root").get("sessions") as Y.Map<Y.Map<unknown>>;
    const entry = new Y.Map<unknown>();
    entry.set("title", "会话三");
    sessions.set("ses-3", entry);
    const after = computeMetaSnapshot(ydoc);

    expect(after.sessions.map((s) => s.sessionId)).toEqual(["ses-1", "ses-2", "ses-3"]);
    expect(after.sessions).not.toBe(before.sessions);
    expect(after.modelState).toBe(before.modelState);
    expect(after.permissions).toBe(before.permissions);
    expect(after.capabilities).toBe(before.capabilities);
  });

  // 嵌套子树（session.modelState）变化：只重建 modelState，sessions 等其余子树复用引用
  test("modelState 变更只重建 modelState 子树", () => {
    const ydoc = createMetaDoc();
    const before = computeMetaSnapshot(ydoc);

    writeModelState(ydoc, { currentModelId: "m2", availableModels: [{ modelId: "m2", name: "Model Two" }] });
    const after = computeMetaSnapshot(ydoc);

    expect(after.modelState?.currentModelId).toBe("m2");
    expect(after.modelState).not.toBe(before.modelState);
    expect(after.sessions).toBe(before.sessions);
    expect(after.permissions).toBe(before.permissions);
  });

  // 权限决议（pending → resolved）只重建 permissions 子树
  test("permission 决议只重建 permissions 子树", () => {
    const ydoc = createMetaDoc();
    const before = computeMetaSnapshot(ydoc);
    expect(before.permissions[0]?.status).toBe("pending");

    const pending = ydoc.getMap("root").get("pendingPermissions") as Y.Map<Y.Map<unknown>>;
    pending.get("p1")?.set("status", "resolved");
    pending.get("p1")?.set("decision", "deny");
    const after = computeMetaSnapshot(ydoc);

    expect(after.permissions[0]?.status).toBe("denied");
    expect(after.permissions).not.toBe(before.permissions);
    expect(after.sessions).toBe(before.sessions);
    expect(after.modelState).toBe(before.modelState);
  });

  // agent capabilities 变化只重建 capabilities；availableCommands 同理独立
  test("capabilities 与 availableCommands 独立派生", () => {
    const ydoc = createMetaDoc();
    const before = computeMetaSnapshot(ydoc);

    setAgentStatus(ydoc, { capabilities: { promptCapabilities: true, loadSession: true } });
    const mid = computeMetaSnapshot(ydoc);
    expect(mid.capabilities).not.toBe(before.capabilities);
    expect(mid.capabilities?.loadSession).toBe(true);
    expect(mid.sessions).toBe(before.sessions);

    setSessionAvailableCommands(ydoc, [{ name: "/plan", description: "制定计划" }]);
    const after = computeMetaSnapshot(ydoc);
    expect(after.availableCommands.map((c) => c.name)).toEqual(["/plan"]);
    expect(after.capabilities).toBe(mid.capabilities);
    expect(after.sessions).toBe(before.sessions);
  });

  // sessionId 变化联动 sessions 子树（active 标记与兜底条目依赖当前会话）
  test("sessionId 变化联动 sessions 重建", () => {
    const ydoc = createMetaDoc();
    const before = computeMetaSnapshot(ydoc);
    expect(before.sessions.find((s) => s.sessionId === "ses-1")?.status).toBe("active");

    setSessionInfo(ydoc, { sessionId: "ses-2" });
    const after = computeMetaSnapshot(ydoc);
    expect(after.sessionId).toBe("ses-2");
    expect(after.sessions.find((s) => s.sessionId === "ses-2")?.status).toBe("active");
    expect(after.sessions).not.toBe(before.sessions);
    expect(after.modelState).toBe(before.modelState);
  });

  // 无关标量（session.status）变化：全部子树引用稳定（标量每次直读，无缓存）。
  // 注：session.title 是 sessions 兜底条目的标题来源，按设计会联动 sessions 重建
  test("无缓存标量变化不影响子树引用", () => {
    const ydoc = createMetaDoc();
    const before = computeMetaSnapshot(ydoc);

    setSessionInfo(ydoc, { status: "responding" });
    const after = computeMetaSnapshot(ydoc);

    expect(after.status).toBe("responding");
    expect(after.sessions).toBe(before.sessions);
    expect(after.permissions).toBe(before.permissions);
    expect(after.modelState).toBe(before.modelState);
    expect(after.capabilities).toBe(before.capabilities);
    expect(after.availableCommands).toBe(before.availableCommands);
  });
});
