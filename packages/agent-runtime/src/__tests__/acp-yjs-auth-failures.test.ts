import { expect, test } from "bun:test";
import { AppError } from "@fenix/platform-sdk";
import { createYjsRouteFixture, eventually } from "./acp-yjs-route-fixture";
import { createStubAuthenticateRequest } from "./guard-stubs";

// 依赖故障应可重试，真实鉴权拒绝及限流则保留各自协议关闭码。
test.each([
  ["directory", new Error("fixture membership lookup unavailable"), 1011, "authentication unavailable"],
  ["rate-limit", new AppError("fixture rate limited", "RATE_LIMITED", 429), 4008, "rate_limited"],
  ["forbidden", new AppError("fixture forbidden", "FORBIDDEN", 403), 4003, "unauthorized"],
] as const)("YJS %s 错误映射到明确关闭码", async (_source, error, code, reason) => {
  const h = await createYjsRouteFixture(false, false, async () => {
    throw error;
  });
  try {
    await expect(h.open()).resolves.toBeUndefined();
    expect(h.closes).toEqual([{ code, reason }]);
    expect(h.frames).toEqual([]);
    expect(h.sent).toEqual([]);
  } finally {
    await h.dispose();
  }
});

// 未登录或确实没有组织上下文时仍拒绝访问，不能将失败路径变成权限绕过。
test.each([
  null,
  { user: { id: "user-route" }, authContext: null },
])("YJS 无权限结果 %j 仍关闭 4003", async (result) => {
  const h = await createYjsRouteFixture(false, false, async () => result);
  try {
    await h.open();
    expect(h.closes).toEqual([{ code: 4003, reason: "unauthorized" }]);
    expect(h.frames).toEqual([]);
  } finally {
    await h.dispose();
  }
});

// 真实连接在组织依赖短暂故障时收到可重试关闭，依赖恢复后同一服务可重新完成认证。
test("真实 YJS 连接在组织依赖恢复后可重连", async () => {
  let unavailable = true;
  const authenticate = createStubAuthenticateRequest();
  const h = await createYjsRouteFixture(false, false, async (request) => {
    if (unavailable) throw new Error("fixture membership lookup unavailable");
    return authenticate(request);
  });
  const closes: { code: number; reason: string }[] = [];
  let socket: WebSocket | undefined;
  try {
    h.app.listen({ hostname: "127.0.0.1", port: 0 });
    const port = h.app.server?.port;
    if (!port) throw new Error("Missing live test server port");
    const url = `ws://127.0.0.1:${port}/acp/yjs/env-route?instanceUid=instance-route&rcsSessionId=${h.rcsSessionId}`;
    socket = new WebSocket(url);
    socket.onclose = ({ code, reason }) => closes.push({ code, reason });
    await eventually(() => closes.length === 1);
    expect(closes).toEqual([{ code: 1011, reason: "authentication unavailable" }]);

    unavailable = false;
    let ready = false;
    socket = new WebSocket(url);
    socket.onmessage = ({ data }) => {
      if (typeof data === "string" && JSON.parse(data).type === "yjs:command-epoch") ready = true;
    };
    await eventually(() => ready);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
    await eventually(() => h.controller.registry.clientCount === 0);
  } finally {
    socket?.close();
    await h.app.stop(true);
    await h.dispose();
  }
});

// 外部 relay 复用宿主组织解析，也必须把依赖故障转换为可重试关闭而非留下僵尸连接。
test.each([
  ["directory", new Error("fixture membership lookup unavailable"), 1011, "authentication unavailable"],
  ["rate-limit", new AppError("fixture rate limited", "RATE_LIMITED", 429), 4008, "rate_limited"],
  ["forbidden", new AppError("fixture forbidden", "FORBIDDEN", 403), 4003, "unauthorized"],
] as const)("真实 relay %s 错误映射到明确关闭码", async (_source, error, code, reason) => {
  const h = await createYjsRouteFixture(false, false, async () => {
    throw error;
  });
  let socket: WebSocket | undefined;
  try {
    h.app.listen({ hostname: "127.0.0.1", port: 0 });
    const port = h.app.server?.port;
    if (!port) throw new Error("Missing live test server port");
    let closed: { code: number; reason: string } | undefined;
    socket = new WebSocket(`ws://127.0.0.1:${port}/acp/relay/env-route`);
    socket.onclose = (event) => {
      closed = { code: event.code, reason: event.reason };
    };
    await eventually(() => closed !== undefined);
    expect(closed).toEqual({ code, reason });
  } finally {
    socket?.close();
    await h.app.stop(true);
    await h.dispose();
  }
});
