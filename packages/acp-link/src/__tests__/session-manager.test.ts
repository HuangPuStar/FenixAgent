import { describe, expect, test } from "bun:test";
import { SessionManager } from "../client/session-manager";

describe("SessionManager", () => {
  test("constructor does not throw", () => {
    const mgr = new SessionManager("opencode", 5, "/tmp/test");
    expect(mgr).toBeDefined();
  });

  test("hasSession returns false initially", () => {
    const mgr = new SessionManager("nonexistent_command_xyz", 5);
    expect(mgr.hasSession("any")).toBe(false);
  });

  test("getAliveSessionIds returns empty initially", () => {
    const mgr = new SessionManager("nonexistent_command_xyz", 5);
    expect(mgr.getAliveSessionIds()).toEqual([]);
  });

  test("getCapabilities returns null initially", () => {
    const mgr = new SessionManager("nonexistent_command_xyz", 5);
    expect(mgr.getCapabilities()).toBeNull();
  });

  test("setSystemPrompt does not throw", () => {
    const mgr = new SessionManager("nonexistent_command_xyz", 5);
    mgr.setSystemPrompt("test prompt");
  });

  test("endSession does not throw", () => {
    const mgr = new SessionManager("nonexistent_command_xyz", 5);
    mgr.endSession("nonexistent");
  });

  test("stopAll cleans up state", () => {
    const mgr = new SessionManager("nonexistent_command_xyz", 5);
    mgr.stopAll();
    expect(mgr.hasSession("any")).toBe(false);
    expect(mgr.getAliveSessionIds()).toEqual([]);
  });

  // 无连接时 sendData 应立即返回 true 并触发后台 spawn；agent 命令缺失时 spawn 失败不得崩溃进程。
  // 历史版本因 spawn ENOENT 无 error 监听导致未捕获异常崩溃而跳过，session-manager 已修复监听。
  test("sendData returns true when no connection", async () => {
    const mgr = new SessionManager("nonexistent_command_xyz", 5);
    const result = await mgr.sendData("ses_1", { type: "list_sessions" });
    expect(result).toBe(true);
    mgr.stopAll();
  });
});
