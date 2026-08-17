import { describe, expect, test } from "bun:test";
import {
  clearChatDocContent,
  clearSessionDocContent,
  createChatDoc,
  createSessionDoc,
  getChatRoot,
  getSessionRoot,
} from "@fenix/chat-channel/server";
import * as Y from "yjs";

describe("clearSessionDocContent", () => {
  // 清空规则必须覆盖 Chat Doc 时间线（entries/toolCalls）与 Session Doc 会话元信息
  // （session/pendingPermissions），保留 schema 骨架并提升 projectionVersion。
  test("clears chat timeline and session metadata while keeping schema skeleton", () => {
    const chat = createChatDoc("rcs_clear", null).ydoc;
    const session = createSessionDoc("rcs_clear", null).ydoc;

    // 写入内容
    (chat.getMap("root").get("entryOrder") as Y.Array<string>).push(["e1"]);
    const entries = chat.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    entries.set("e1", new Y.Map());
    const toolCalls = chat.getMap("root").get("toolCalls") as Y.Map<Y.Map<unknown>>;
    toolCalls.set("t1", new Y.Map());
    (session.getMap("root").get("pendingPermissions") as Y.Map<Y.Map<unknown>>).set("p1", new Y.Map());
    // agent 状态：实例级（capabilities/instanceId）应跨会话切换保留；
    // 会话级 acpSessionId 切换后失效应被清除
    const agent = session.getMap("root").get("agent") as Y.Map<unknown>;
    agent.set("capabilities", new Y.Map([["loadSession", true]]));
    agent.set("instanceId", "inst_1");
    agent.set("acpSessionId", "ses_old");

    clearChatDocContent(chat);
    clearSessionDocContent(session);

    expect((chat.getMap("root").get("entryOrder") as Y.Array<string>).length).toBe(0);
    expect((chat.getMap("root").get("entries") as Y.Map<unknown>).size).toBe(0);
    expect((chat.getMap("root").get("toolCalls") as Y.Map<unknown>).size).toBe(0);
    expect((session.getMap("root").get("session") as Y.Map<unknown>).size).toBe(0);
    expect((session.getMap("root").get("pendingPermissions") as Y.Map<unknown>).size).toBe(0);
    // agent 保留实例级状态（切换后 capabilities 仍可用，前端 supportsLoadSession 不失效）
    expect(agent.get("capabilities")).toBeInstanceOf(Y.Map);
    expect((agent.get("capabilities") as Y.Map<unknown>).get("loadSession")).toBe(true);
    expect(agent.get("instanceId")).toBe("inst_1");
    // 会话绑定的 acpSessionId 清除（旧值失效）
    expect(agent.get("acpSessionId")).toBeUndefined();
    // 骨架保留：schemaVersion 与根键集合不变
    expect(getChatRoot(chat).get("schemaVersion")).toBe(2);
    // Session Doc v3：新增根级 sessions 投影位（clearSessionDocContent 保留该 agent 级数据）
    expect(getSessionRoot(session).get("schemaVersion")).toBe(3);
    expect(typeof getChatRoot(chat).get("projectionVersion")).toBe("number");
  });
});
