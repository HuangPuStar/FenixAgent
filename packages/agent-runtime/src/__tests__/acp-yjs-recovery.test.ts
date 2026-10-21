import { describe, expect, test } from "bun:test";
import { decodeYjsSyncFrame, MAX_YJS_SYNC_PAYLOAD_BYTES } from "@fenix/chat-channel";
import * as Y from "yjs";
import { createYjsRouteFixture, eventually } from "./acp-yjs-route-fixture";

describe("YJS 路由端到端握手与输入绑定", () => {
  // 同步尚未完成即断线时，旧 open 不能再发 relay connect 或提交就绪状态。
  test("初始握手中关闭连接不会继续提交 relay 就绪", async () => {
    const h = await createYjsRouteFixture();
    try {
      h.setReply(false);
      const opening = h.open();
      await eventually(() => h.text().some((frame) => frame.type === "yjs:sync-request"));
      h.disconnect();
      await opening;
      expect(h.sent.some((frame) => frame.type === "connect")).toBe(false);
      expect(h.text().some((frame) => frame.type === "yjs:sync-complete")).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  // 大文档已有同代缓存时，必须在真实入站队列中处理 state-vector，不能先等全量兜底失败。
  test("9MiB 历史通过小差量完成初始握手", async () => {
    const h = await createYjsRouteFixture(true);
    try {
      expect(Y.encodeStateAsUpdate(h.chat.ydoc).byteLength).toBeGreaterThan(MAX_YJS_SYNC_PAYLOAD_BYTES);
      await h.open();
      expect(h.text().filter((frame) => frame.type === "yjs:history-incomplete")).toEqual([]);
      expect(h.text().filter((frame) => frame.type === "yjs:sync-complete")).toHaveLength(1);
      const updates = h.frames.filter((frame): frame is Uint8Array => frame instanceof Uint8Array);
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.every((frame) => frame.byteLength < 1024)).toBe(true);
      expect(h.cached.get(`chat:${h.rcsSessionId}`)?.getText("history").toString()).toBe(
        h.chat.ydoc.getText("history").toString(),
      );
      expect(h.closes).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  // 未完成的同代握手仍可由迟到的差量回复结算；generation 不匹配的回复不能伪造完成证明。
  test("超时后同代 state-vector 恢复完成，异代回复保持失败", async () => {
    const h = await createYjsRouteFixture(true);
    try {
      h.setReply(true, "wrong-generation");
      await h.open();
      expect(h.text().filter((frame) => frame.type === "yjs:history-incomplete")).toHaveLength(1);
      expect(h.text().filter((frame) => frame.type === "yjs:sync-complete")).toHaveLength(0);
      h.setReply(true);
      h.sendVectors();
      await eventually(() => h.text().some((frame) => frame.type === "yjs:sync-complete"));
      expect(h.text().filter((frame) => frame.type === "yjs:sync-complete")).toHaveLength(1);
      expect(
        h.frames.some((frame) => frame instanceof Uint8Array && decodeYjsSyncFrame(frame)?.type === "update"),
      ).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  // load 等待期间的旧 prompt 会在外层队列等待，出队后仍须核对用户预期会话并拒绝副作用。
  test("外层队列延迟的旧页面输入不改投新会话，确认新会话后可发送", async () => {
    const h = await createYjsRouteFixture();
    try {
      await h.open();
      h.action({ action: "load_session", sessionId: "ses-a", commandId: "initial-load" });
      await eventually(() => h.sent.some((rpc) => rpc.method === "session/load"));
      await h.respond(h.sent.find((rpc) => rpc.method === "session/load")?.id, { sessionId: "ses-a" });
      await eventually(() => h.ack("initial-load"));
      h.action({ action: "load_session", sessionId: "ses-b", commandId: "switch-b" });
      await eventually(() => h.sent.filter((rpc) => rpc.method === "session/load").length === 2);
      h.action({
        action: "send_prompt",
        sessionId: "ses-a",
        commandId: "old-page",
        content: [{ type: "text", text: "old context" }],
      });
      await h.respond(h.sent.filter((rpc) => rpc.method === "session/load")[1]?.id, { sessionId: "ses-b" });
      await eventually(() =>
        h.text().some((frame) => frame.type === "action_error" && frame.commandId === h.commandId("old-page")),
      );
      expect(
        h.text().find((frame) => frame.type === "action_error" && frame.commandId === h.commandId("old-page")),
      ).toMatchObject({
        error: { type: "ACTION.VERSION_CONFLICT" },
      });
      expect(h.sent.filter((rpc) => rpc.method === "session/prompt")).toEqual([]);
      expect(h.manager.hasTimelineContent(h.rcsSessionId)).toBe(false);
      h.action({
        action: "send_prompt",
        sessionId: "ses-b",
        commandId: "confirmed-b",
        content: [{ type: "text", text: "new context" }],
      });
      await eventually(() => h.ack("confirmed-b"));
      expect(h.sent.filter((rpc) => rpc.method === "session/prompt")).toHaveLength(1);
      expect(h.sent.find((rpc) => rpc.method === "session/prompt")?.params).toMatchObject({ sessionId: "ses-b" });
    } finally {
      await h.dispose();
    }
  });
});
