// packages/acp-server/src/__tests__/chat-writer.test.ts
import { beforeEach, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  addPermission,
  addSession,
  resolvePermission,
  setActiveSession,
  setAgentInfo,
  setConnectionStatus,
  updateSession,
} from "../chat-writer";

let ydoc: Y.Doc;

beforeEach(() => {
  ydoc = new Y.Doc();
  ydoc.getMap("agentInfo");
  ydoc.getArray("sessions");
  ydoc.getMap("chatMeta");
  ydoc.getMap("connection");
  ydoc.getArray("permissions");
});

// setConnectionStatus 更新 connection Map
test("setConnectionStatus updates connection map", () => {
  setConnectionStatus(ydoc, { status: "connected", since: 1234567890 });
  const conn = ydoc.getMap("connection") as any;
  expect(conn.get("status")).toBe("connected");
  expect(conn.get("since")).toBe(1234567890);
});

// setAgentInfo 设置 agent 信息含 model
test("setAgentInfo sets agent info with model", () => {
  setAgentInfo(ydoc, {
    id: "agent_1",
    name: "Test Agent",
    model: { id: "gpt-4", name: "GPT-4" },
  });
  const info = ydoc.getMap("agentInfo") as any;
  expect(info.get("id")).toBe("agent_1");
  const model = info.get("model") as Y.Map<unknown>;
  const m0 = model as any;
  expect(m0.get("id")).toBe("gpt-4");
});

// addSession 追加 sessions 并去重
test("addSession appends to sessions array and deduplicates", () => {
  addSession(ydoc, {
    sessionId: "ses_1",
    title: "Session 1",
    preview: "Hello...",
    status: "active",
    lastMsgTs: 100,
  });
  addSession(ydoc, {
    sessionId: "ses_1",
    title: "Session 1 dup",
    preview: "",
    status: "done",
    lastMsgTs: 200,
  });

  const sessions = ydoc.getArray("sessions").toArray();
  expect(sessions.length).toBe(1);
  const s0 = sessions[0] as any;
  expect(s0.get("sessionId")).toBe("ses_1");
  expect(s0.get("title")).toBe("Session 1");
});

// updateSession 更新已有 session
test("updateSession patches existing session", () => {
  addSession(ydoc, {
    sessionId: "ses_1",
    title: "Original",
    preview: "",
    status: "idle",
    lastMsgTs: 100,
  });
  updateSession(ydoc, "ses_1", { title: "Updated", status: "done" });

  const sessions = ydoc.getArray("sessions").toArray();
  const s0 = sessions[0] as any;
  expect(s0.get("title")).toBe("Updated");
  expect(s0.get("status")).toBe("done");
});

// setActiveSession 更新 chatMeta 并清除 switching
test("setActiveSession updates chatMeta and clears switching flag", () => {
  ydoc.getMap("chatMeta").set("isSwitchingSession", true);
  setActiveSession(ydoc, "ses_B");
  const chatMeta = ydoc.getMap("chatMeta") as any;
  expect(chatMeta.get("activeSessionId")).toBe("ses_B");
  expect(chatMeta.get("isSwitchingSession")).toBe(false);
});

// addPermission + resolvePermission 管理权限数组
test("addPermission and resolvePermission manage permissions array", () => {
  addPermission(ydoc, {
    id: "perm_1",
    tool: "read_file",
    args: { path: "/secret.txt" },
    level: "ask",
    status: "pending",
    ts: 111,
  });
  addPermission(ydoc, {
    id: "perm_2",
    tool: "write_file",
    args: {},
    level: "ask",
    status: "pending",
    ts: 222,
  });

  const perms = ydoc.getArray("permissions").toArray();
  expect(perms.length).toBe(2);

  resolvePermission(ydoc, "perm_1", "approved");
  const p0 = perms[0] as any;
  const p1 = perms[1] as any;
  expect(p0.get("status")).toBe("approved");
  expect(p1.get("status")).toBe("pending");
});
