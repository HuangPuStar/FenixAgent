import { beforeEach, describe, expect, test } from "bun:test";
import { ACPPending } from "../../client/pending.js";

// ACPPending JSON-RPC ID 匹配测试
describe("ACPPending", () => {
  let pending: ACPPending;

  beforeEach(() => {
    pending = new ACPPending();
  });

  // 测试 register + tryResolve 正常流程
  test("register + tryResolve — resolves on match", async () => {
    const promise = pending.register("session_list_1", { method: "session/list", params: { cwd: "/tmp" } }, 5000);

    const response = { sessions: [{ sessionId: "s1", cwd: "/tmp" }] };
    const matched = pending.tryResolve("session_list_1", response);
    expect(matched).toBe(true);

    const result = await promise;
    expect((result as { sessions: Array<{ sessionId: string }> }).sessions.length).toBe(1);
  });

  // 测试 tryResolve 不匹配返回 false
  test("tryResolve — no match returns false", () => {
    pending.register(1, {}, 5000).catch(() => {});
    const matched = pending.tryResolve(999, "ses_1");
    expect(matched).toBe(false);
  });

  // 超时已移除——请求等待直到 response 到达或连接断开时由 rejectAll 统一清理

  // 测试同 ID 去重
  test("register — deduplicates same id", () => {
    const p1 = pending.register(1, {}, 5000);
    const p2 = pending.register(1, {}, 5000);
    expect(p1).toBe(p2);
    // 清理：resolve the pending
    pending.tryResolve(1, { sessions: [] });
  });

  // 测试 rejectAll
  test("rejectAll — rejects all pending", async () => {
    const p1 = pending.register(1, {}, 5000);
    const p2 = pending.register(2, {}, 5000);

    pending.rejectAll(new Error("disconnected"));

    await expect(p1).rejects.toThrow("disconnected");
    await expect(p2).rejects.toThrow("disconnected");
    expect(pending.hasPending).toBe(false);
  });

  // 测试 getPendingRequests
  test("getPendingRequests — returns all pending requests", async () => {
    const p1 = pending.register(1, { method: "session/list" }, 5000);
    const p2 = pending.register(2, { method: "session/load" }, 5000);

    const requests = pending.getPendingRequests();
    expect(requests.length).toBe(2);
    expect(requests[0].id).toBe(1);
    expect(requests[1].id).toBe(2);

    // 清理
    pending.rejectAll(new Error("cleanup"));
    await expect(p1).rejects.toThrow("cleanup");
    await expect(p2).rejects.toThrow("cleanup");
  });

  // 测试 hasPending
  test("hasPending — tracks pending count", () => {
    expect(pending.hasPending).toBe(false);
    pending.register(1, {}, 5000).catch(() => {});
    expect(pending.hasPending).toBe(true);
    pending.tryResolve(1, {});
    expect(pending.hasPending).toBe(false);
  });
});
