import { describe, expect, test } from "bun:test";
import { SessionManager } from "../client/session-manager";

describe("SessionManager", () => {
  test("startSession 返回 started", async () => {
    const mgr = new SessionManager("echo", 5);
    const result = await mgr.startSession("ses_1");
    expect(result).toBe("started");
    expect(mgr.activeCount).toBe(1);
    mgr.stopAll();
  });

  test("startSession 超限返回 queued", async () => {
    const mgr = new SessionManager("echo", 1);
    const r1 = await mgr.startSession("ses_1");
    expect(r1).toBe("started");
    const r2 = await mgr.startSession("ses_2");
    expect(r2).toBe("queued");
    expect(mgr.activeCount).toBe(1);
    mgr.stopAll();
  });

  test("startSession 幂等", async () => {
    const mgr = new SessionManager("echo", 5);
    const r1 = await mgr.startSession("ses_1");
    const r2 = await mgr.startSession("ses_1");
    expect(r1).toBe("started");
    expect(r2).toBe("started");
    expect(mgr.activeCount).toBe(1);
    mgr.stopAll();
  });

  test("getAliveSessionIds 返回存活列表", async () => {
    const mgr = new SessionManager("echo", 5);
    await mgr.startSession("A");
    await mgr.startSession("B");
    const ids = mgr.getAliveSessionIds();
    expect(ids).toContain("A");
    expect(ids).toContain("B");
    mgr.stopAll();
  });

  test("hasSession 检查存在", async () => {
    const mgr = new SessionManager("echo", 5);
    await mgr.startSession("ses_1");
    expect(mgr.hasSession("ses_1")).toBe(true);
    expect(mgr.hasSession("nonexistent")).toBe(false);
    mgr.stopAll();
  });

  test("sendData 不抛异常", async () => {
    const mgr = new SessionManager("echo", 5);
    const result = mgr.sendData("ses_new", { type: "test" });
    expect(result).toBe(true);
    mgr.stopAll();
  });

  test("endSession 不抛异常", async () => {
    const mgr = new SessionManager("echo", 5);
    await mgr.endSession("nonexistent");
    // 不抛异常
    expect(true).toBe(true);
  });

  test("stopAll 清理所有 session", async () => {
    const mgr = new SessionManager("echo", 5);
    await mgr.startSession("A");
    await mgr.startSession("B");
    mgr.stopAll();
    expect(mgr.activeCount).toBe(0);
  });
});
