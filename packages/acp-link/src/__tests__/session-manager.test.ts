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

  // sendData triggers spawn when no connection exists; not testable without real opencode
  test.skip("sendData returns true when no connection", () => {
    const mgr = new SessionManager("nonexistent_command_xyz", 5);
    const result = mgr.sendData("ses_1", { type: "list_sessions" });
    expect(result).toBe(true);
    mgr.stopAll();
  });
});
