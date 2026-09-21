import { describe, expect, test } from "bun:test";
import { shouldAutoReconnectOnVisible } from "../pages/agent-panel/chat-visible-reconnect";

describe("shouldAutoReconnectOnVisible", () => {
  // 首次挂载且初始可见时不重复连接
  test("does not fire on initial mount when visible", () => {
    expect(shouldAutoReconnectOnVisible(true, true, "disconnected", null)).toBe(false);
  });

  // 首次挂载时页面不可见（后台缓存创建）也不触发
  test("does not fire on initial mount when hidden", () => {
    expect(shouldAutoReconnectOnVisible(false, false, "disconnected", null)).toBe(false);
  });

  // 后台被 4001 回收断开后切回前台，应自动触发一次重连
  test("fires on hidden -> visible edge when disconnected", () => {
    expect(shouldAutoReconnectOnVisible(false, true, "disconnected", null)).toBe(true);
  });

  // 后台被 4001/4501 终态关闭进入 error 后切回前台，应自动触发一次重连
  test("fires on hidden -> visible edge when in error state", () => {
    expect(shouldAutoReconnectOnVisible(false, true, "error", "instance_idle_reclaimed")).toBe(true);
    expect(shouldAutoReconnectOnVisible(false, true, "error", "client_keepalive_timeout")).toBe(true);
  });

  // 已连接或正在连接时不重复重连
  test("does not fire when connected or connecting", () => {
    expect(shouldAutoReconnectOnVisible(false, true, "connected", null)).toBe(false);
    expect(shouldAutoReconnectOnVisible(false, true, "connecting", null)).toBe(false);
  });

  // machine_unavailable（4500）保留手动重试，避免无意义循环
  test("does not fire when machine unavailable", () => {
    expect(shouldAutoReconnectOnVisible(false, true, "error", "machine_unavailable")).toBe(false);
  });

  // auto_start_disabled（4502）是配置性永久失败，切回前台自动重连无意义，仅保留手动重试
  test("does not fire when auto start is disabled", () => {
    expect(shouldAutoReconnectOnVisible(false, true, "error", "auto_start_disabled")).toBe(false);
  });

  // launch_spec_build_failed（4502）同样是配置性永久失败，切回前台不自动重连
  test("does not fire when launch spec build failed", () => {
    expect(shouldAutoReconnectOnVisible(false, true, "error", "launch_spec_build_failed")).toBe(false);
  });

  // environment_unavailable（4004）是引用失效终态，重试相同 URL 永远失败，切回前台不自动重连
  test("does not fire when environment is unavailable", () => {
    expect(shouldAutoReconnectOnVisible(false, true, "error", "environment_unavailable")).toBe(false);
  });

  // max_sessions_reached 是配置上限但实例可能随后被释放：切回前台应自动重连一次尝试恢复
  test("fires when max sessions reached so a released instance can be recovered", () => {
    expect(shouldAutoReconnectOnVisible(false, true, "error", "max_sessions_reached")).toBe(true);
  });

  // 停留在可见状态（连续 render）不重复触发
  test("does not fire repeatedly while visible", () => {
    expect(shouldAutoReconnectOnVisible(true, true, "error", null)).toBe(false);
  });
});
