import { afterEach, describe, expect, mock, test } from "bun:test";

describe("SocketIO Relay Auth Middleware", () => {
  afterEach(() => {
    mock.restore();
  });

  // ── incomingToRequest 参数转换 ──

  // 保留请求方法、路径和头部
  test("incomingToRequest 保留请求方法和路径", async () => {
    const { incomingToRequest } = await import("../../transport/socketio-auth");
    const req = {
      headers: {
        host: "localhost:3000",
        cookie: "session=abc",
        "x-forwarded-proto": "https",
      },
      url: "/socket.io/?EIO=4&transport=websocket",
    };
    const result = incomingToRequest(req as any);
    expect(result.url).toBe("https://localhost:3000/socket.io/?EIO=4&transport=websocket");
  });

  // 无 x-forwarded-proto 时默认 http
  test("incomingToRequest 无 x-forwarded-proto 时默认 http", async () => {
    const { incomingToRequest } = await import("../../transport/socketio-auth");
    const req = {
      headers: { host: "example.com" },
      url: "/test",
    };
    const result = incomingToRequest(req as any);
    expect(result.url).toBe("http://example.com/test");
  });

  // 异常头部处理（数组值）
  test("incomingToRequest 处理数组头部值", async () => {
    const { incomingToRequest } = await import("../../transport/socketio-auth");
    const req = {
      headers: {
        host: "example.com",
        "x-custom": ["v1", "v2"],
      },
      url: "/",
    };
    const result = incomingToRequest(req as any);
    expect(result.headers.get("x-custom")).toBe("v1, v2");
  });

  // ── relayAuthMiddleware 认证流程 ──

  // 无认证 cookie 时返回 unauthorized
  test("无认证 cookie 时 next 收到 unauthorized 错误", async () => {
    mock.module("../../plugins/auth", () => ({
      authenticateRequest: mock(async () => null),
    }));
    // Re-import after mock to get mocked version
    const { relayAuthMiddleware } = await import("../../transport/socketio-auth");

    const next = mock((_err?: Error) => {});
    const socket = {
      request: {
        headers: {},
        url: "/socket.io/?agentId=agent-1&EIO=4",
      },
      handshake: { query: { agentId: "agent-1" } },
      data: {},
    };

    await relayAuthMiddleware(socket as any, next);
    expect(next).toHaveBeenCalled();
    const callArg = (next as any).mock.calls[0][0];
    expect(callArg).toBeInstanceOf(Error);
    expect(callArg.message).toBe("unauthorized");
  });

  // 缺少 agentId 时返回 missing agentId
  test("handshake.query 缺少 agentId 时 next 收到 missing agentId 错误", async () => {
    mock.module("../../plugins/auth", () => ({
      authenticateRequest: mock(async () => ({
        user: { id: "u1" },
        authContext: { organizationId: "org-1" },
      })),
    }));
    const { relayAuthMiddleware } = await import("../../transport/socketio-auth");

    const next = mock((_err?: Error) => {});
    const socket = {
      request: {
        headers: { cookie: "session=abc" },
        url: "/socket.io/?EIO=4",
      },
      handshake: { query: {} },
      data: {},
    };

    await relayAuthMiddleware(socket as any, next);
    expect(next).toHaveBeenCalled();
    const callArg = (next as any).mock.calls[0][0];
    expect(callArg).toBeInstanceOf(Error);
    expect(callArg.message).toBe("missing agentId");
  });

  // 认证通过 + agent 存在且组织权限匹配时 next() 无参
  test("认证通过且 agent 存在时 next() 无参调用", async () => {
    mock.module("../../plugins/auth", () => ({
      authenticateRequest: mock(async () => ({
        user: { id: "user-1" },
        authContext: { organizationId: "org-1" },
      })),
    }));
    // Mock environmentRepo.getById to return a matching agent
    mock.module("../../repositories/environment", () => ({
      environmentRepo: {
        getById: mock(async (_id: string) => ({
          id: "agent-1",
          organizationId: "org-1",
          userId: "user-1",
          agentConfigId: null,
        })),
      },
    }));
    const { relayAuthMiddleware } = await import("../../transport/socketio-auth");

    const next = mock((_err?: Error) => {});
    const socket = {
      request: {
        headers: { cookie: "session=abc" },
        url: "/socket.io/?agentId=agent-1&sessionId=ses-1&EIO=4",
      },
      handshake: { query: { agentId: "agent-1", sessionId: "ses-1" } },
      data: {},
    };

    await relayAuthMiddleware(socket as any, next);
    expect(next).toHaveBeenCalled();
    // next() should be called with NO arguments (success)
    expect((next as any).mock.calls[0]).toHaveLength(0);
    // socket.data should be populated
    expect(socket.data).toEqual({
      authResult: {
        user: { id: "user-1" },
        authContext: { organizationId: "org-1" },
      },
      userId: "user-1",
      agentId: "agent-1",
      sessionId: "ses-1",
    });
  });
});
