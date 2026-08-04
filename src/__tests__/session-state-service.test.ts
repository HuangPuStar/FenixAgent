import { describe, expect, test } from "bun:test";
import {
  clearChatDocContent,
  clearSessionDocContent,
  createChatDoc,
  createSessionDoc,
  getChatRoot,
  getSessionRoot,
} from "@fenix/chat-channel";
import * as Y from "yjs";

describe("clearSessionDocContent", () => {
  // 清空规则必须覆盖 Chat Doc 时间线（entries/toolCalls）与 Session Doc 元信息
  // （session/agent/pendingPermissions），保留 schema 骨架并提升 projectionVersion。
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

    clearChatDocContent(chat);
    clearSessionDocContent(session);

    expect((chat.getMap("root").get("entryOrder") as Y.Array<string>).length).toBe(0);
    expect((chat.getMap("root").get("entries") as Y.Map<unknown>).size).toBe(0);
    expect((chat.getMap("root").get("toolCalls") as Y.Map<unknown>).size).toBe(0);
    expect((session.getMap("root").get("session") as Y.Map<unknown>).size).toBe(0);
    expect((session.getMap("root").get("agent") as Y.Map<unknown>).size).toBe(0);
    expect((session.getMap("root").get("pendingPermissions") as Y.Map<unknown>).size).toBe(0);
    // 骨架保留：schemaVersion 与根键集合不变
    expect(getChatRoot(chat).get("schemaVersion")).toBe(2);
    expect(getSessionRoot(session).get("schemaVersion")).toBe(2);
    expect(typeof getChatRoot(chat).get("projectionVersion")).toBe("number");
  });
});
