import { expect, test } from "bun:test";
import { getTerminalYjsWsErrorCode } from "../yjs/yjs-ws";

// 空闲或无活动回收应提示实例已回收，而不是错误地提示冷却或登录失效。
test("maps 4001 to instance_idle_reclaimed", () => {
  expect(getTerminalYjsWsErrorCode(4001)).toBe("instance_idle_reclaimed");
});

// 远程机器断连应沿用稳定的机器不可用错误码。
test("maps 4500 to machine_unavailable", () => {
  expect(getTerminalYjsWsErrorCode(4500)).toBe("machine_unavailable");
});

// 客户端长期未保活应提供可区分的恢复提示。
test("maps 4501 to client_keepalive_timeout", () => {
  expect(getTerminalYjsWsErrorCode(4501)).toBe("client_keepalive_timeout");
});

// 会话/环境引用失效（4004，如 env 已删除）应提示环境不可用，而不是继续无限重连。
test("maps 4004 to environment_unavailable", () => {
  expect(getTerminalYjsWsErrorCode(4004)).toBe("environment_unavailable");
});

// 非终端关闭码应继续使用普通断线流程。
test("returns null for non-terminal close codes", () => {
  expect(getTerminalYjsWsErrorCode(1006)).toBeNull();
});

// 连接数超限的 1013 是终态：重试相同 URL 在配额释放前无意义，须手动恢复。
test("maps 1013 without a resync reason to too_many_connections", () => {
  expect(getTerminalYjsWsErrorCode(1013)).toBe("too_many_connections");
  expect(getTerminalYjsWsErrorCode(1013, "too many connections")).toBe("too_many_connections");
});

// 慢消费者追赶超时的 1013（broadcaster SP-A7）不是终态：客户端自动重连后
// 走全量快照同步恢复，UI 不得展示"须手动恢复"的终态错误。
test("treats the slow consumer resync 1013 as reconnectable", () => {
  expect(getTerminalYjsWsErrorCode(1013, "slow consumer resync timeout")).toBeNull();
});
