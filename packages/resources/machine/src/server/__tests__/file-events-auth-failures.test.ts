import { expect, test } from "bun:test";
import { AppError } from "@fenix/platform-sdk";
import { createWebFileEventsRoutes } from "../routes/web/file-events";

// 文件事件与聊天共用组织认证，依赖异常不能留下已升级但不可工作的连接。
test.each([
  ["directory", new Error("fixture membership lookup unavailable"), 1011, "authentication unavailable"],
  ["rate-limit", new AppError("fixture rate limited", "RATE_LIMITED", 429), 4008, "rate_limited"],
  ["forbidden", new AppError("fixture forbidden", "FORBIDDEN", 403), 4003, "unauthorized"],
] as const)("真实 file-events %s 错误映射到明确关闭码", async (_source, error, code, reason) => {
  const app = createWebFileEventsRoutes({
    authenticateRequest: async () => {
      throw error;
    },
  });
  let socket: WebSocket | undefined;
  try {
    app.listen({ hostname: "127.0.0.1", port: 0 });
    const port = app.server?.port;
    if (!port) throw new Error("Missing live test server port");
    let closed: { code: number; reason: string } | undefined;
    socket = new WebSocket(`ws://127.0.0.1:${port}/file-events/`);
    socket.onclose = (event) => {
      closed = { code: event.code, reason: event.reason };
    };
    const deadline = performance.now() + 2_000;
    while (!closed && performance.now() < deadline) await Bun.sleep(1);
    expect(closed).toEqual({ code, reason });
  } finally {
    socket?.close();
    await app.stop(true);
  }
});
