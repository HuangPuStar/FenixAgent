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

// 非终端关闭码应继续使用普通断线流程。
test("returns null for non-terminal close codes", () => {
  expect(getTerminalYjsWsErrorCode(1006)).toBeNull();
});
