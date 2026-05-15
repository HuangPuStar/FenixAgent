import { describe, test, expect, beforeEach } from "bun:test";
import { ACPPending } from "../../acp/pending";

// ACPPending request/response 关联测试
describe("ACPPending", () => {
  let pending: ACPPending;

  beforeEach(() => {
    pending = new ACPPending();
  });

  // 测试 sendAndWait + tryResolve 正常流程
  test("sendAndWait + tryResolve — resolves on match", async () => {
    let sentRequest: any = null;
    const promise = pending.sendAndWait(
      (req) => { sentRequest = req; },
      "list_sessions",
      { cwd: "/tmp" },
      "session_list",
      5000,
    );

    expect(sentRequest).toEqual({ cwd: "/tmp" });

    const response = { sessions: [{ sessionId: "s1", cwd: "/tmp" }] };
    const matched = pending.tryResolve("session_list", response);
    expect(matched).toBe(true);

    const result = await promise;
    expect(result.sessions.length).toBe(1);
  });

  // 测试 tryResolve 不匹配返回 false
  test("tryResolve — no match returns false", () => {
    pending.sendAndWait(
      () => {},
      "list_sessions",
      {},
      "session_list",
      5000,
    ).catch(() => {});
    const matched = pending.tryResolve("session_loaded", "ses_1");
    expect(matched).toBe(false);
  });

  // 测试超时自动 reject
  test("sendAndWait — timeout rejects", async () => {
    const promise = pending.sendAndWait(
      () => {},
      "list_sessions",
      {},
      "session_list",
      100,
    );
    await expect(promise).rejects.toThrow("list_sessions timed out");
  });

  // 测试同类型去重
  test("sendAndWait — deduplicates same requestType", () => {
    const p1 = pending.sendAndWait(() => {}, "list_sessions", {}, "session_list", 5000);
    const p2 = pending.sendAndWait(() => {}, "list_sessions", {}, "session_list", 5000);
    expect(p1).toBe(p2);
    // 清理：resolve the pending
    pending.tryResolve("session_list", { sessions: [] });
  });

  // 测试 rejectAll
  test("rejectAll — rejects all pending", async () => {
    const p1 = pending.sendAndWait(() => {}, "list_sessions", {}, "session_list", 5000);
    const p2 = pending.sendAndWait(() => {}, "session_loaded", {}, "session_loaded", 5000);

    pending.rejectAll(new Error("disconnected"));

    await expect(p1).rejects.toThrow("disconnected");
    await expect(p2).rejects.toThrow("disconnected");
    expect(pending.hasPending).toBe(false);
  });

  // 测试 resendAll
  test("resendAll — re-sends all pending requests", () => {
    const sent: any[] = [];
    pending.sendAndWait((req) => sent.push({ type: "list", req }), "list_sessions", { a: 1 }, "session_list", 5000);
    pending.sendAndWait((req) => sent.push({ type: "load", req }), "session_loaded", { id: "s1" }, "session_loaded", 5000);

    sent.length = 0;
    pending.resendAll();

    expect(sent.length).toBe(2);
    expect(sent[0].type).toBe("list");
    expect(sent[1].type).toBe("load");

    // 清理
    pending.tryResolve("session_list", {});
    pending.tryResolve("session_loaded", "");
  });

  // 测试 hasPending
  test("hasPending — tracks pending count", () => {
    expect(pending.hasPending).toBe(false);
    pending.sendAndWait(() => {}, "list_sessions", {}, "session_list", 5000).catch(() => {});
    expect(pending.hasPending).toBe(true);
    pending.tryResolve("session_list", {});
    expect(pending.hasPending).toBe(false);
  });
});
