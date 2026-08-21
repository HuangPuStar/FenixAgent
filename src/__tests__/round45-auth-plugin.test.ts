import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Elysia from "elysia";
import {
  authenticateRequest,
  authGuardPlugin,
  authPlugin,
  errorResponse,
  resetTestAuth,
  setTestAuth,
} from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { readJson, resetAllStubs, stubAuthApi, stubAuthHandler, stubDb } from "../test-utils/helpers";

const user = { id: "user-1", email: "user-1@example.test", name: "测试用户" };

function authRequest(path: string, init?: RequestInit) {
  return authPlugin.handle(new Request(`http://localhost/api/auth${path}`, init));
}

function jsonRequest(path: string, body: unknown) {
  return authRequest(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function emptyDb(rows: unknown[] = []) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
  };
}

function sessionGuard() {
  return new Elysia().use(authGuardPlugin).get(
    "/protected",
    ({ store }) => ({
      userId: store.user?.id,
      sessionId: store.authSession?.id,
      organizationId: store.authContext?.organizationId,
    }),
    { sessionAuth: true },
  );
}

function uuidGuard() {
  return new Elysia().use(authGuardPlugin).get("/uuid", ({ store }) => store.uuid, { uuidAuth: true });
}

describe("round45 auth plugin", () => {
  beforeEach(() => {
    resetAllStubs();
    resetTestAuth();
    setTestOrgContext(null);
  });

  afterEach(() => {
    setTestOrgContext(null);
    resetTestAuth();
    resetAllStubs();
  });

  // 加密公钥端点必须返回可供前端使用的非空 key。
  test("encryption-key 返回非空 key", async () => {
    const response = await authRequest("/encryption-key");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ key: expect.any(String) });
  });

  // 注册开关端点必须显式返回布尔值。
  test("signup-status 返回布尔开关", async () => {
    const response = await authRequest("/signup-status");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ signupAllowed: expect.any(Boolean) });
  });

  // 非 POST 认证框架请求不应被请求体转换逻辑干扰。
  test("GET 请求原样转交 better-auth", async () => {
    let receivedMethod = "";
    stubAuthHandler((request) => {
      receivedMethod = request.method;
      return new Response("handled", { status: 204 });
    });

    const response = await authRequest("/session");

    expect(response.status).toBe(204);
    expect(receivedMethod).toBe("GET");
  });

  // 不在敏感路由清单内的 POST 请求必须保持原始 JSON。
  test("普通 POST 请求原样转交", async () => {
    let receivedBody: unknown;
    stubAuthHandler(async (request) => {
      receivedBody = await request.json();
      return new Response(null, { status: 204 });
    });

    expect((await jsonRequest("/callback", { value: "保留" })).status).toBe(204);
    expect(receivedBody).toEqual({ value: "保留" });
  });

  // 邮箱登录中的手机号应在转交前去除 +86 前缀与分隔符。
  test("邮箱登录归一化手机号", async () => {
    let receivedBody: unknown;
    stubAuthHandler(async (request) => {
      receivedBody = await request.json();
      return new Response(null, { status: 204 });
    });

    expect((await jsonRequest("/sign-in/email", { phoneNumber: "+86 138-0013-8000" })).status).toBe(204);
    expect(receivedBody).toEqual({ phoneNumber: "13800138000" });
  });

  // 邮箱注册同样需要归一化不带加号的 86 国家码。
  test("邮箱注册归一化 86 国家码", async () => {
    let receivedBody: unknown;
    stubAuthHandler(async (request) => {
      receivedBody = await request.json();
      return new Response(null, { status: 204 });
    });

    expect((await jsonRequest("/sign-up/email", { phoneNumber: "8613800138000" })).status).toBe(204);
    expect(receivedBody).toEqual({ phoneNumber: "13800138000" });
  });

  // 手机号登录必须走同一归一化入口。
  test("手机号登录归一化括号格式", async () => {
    let receivedBody: unknown;
    stubAuthHandler(async (request) => {
      receivedBody = await request.json();
      return new Response(null, { status: 204 });
    });

    expect((await jsonRequest("/sign-in/phone-number", { phoneNumber: "138(0013)8000" })).status).toBe(204);
    expect(receivedBody).toEqual({ phoneNumber: "13800138000" });
  });

  // 无手机号且未解密的敏感请求应直接交给 better-auth。
  test("敏感路由无转换字段时原样转交", async () => {
    let receivedBody: unknown;
    stubAuthHandler(async (request) => {
      receivedBody = await request.json();
      return new Response(null, { status: 204 });
    });

    expect((await jsonRequest("/change-password", { password: "plain" })).status).toBe(204);
    expect(receivedBody).toEqual({ password: "plain" });
  });

  // 敏感路由的非法 JSON 不能阻断框架自身的错误处理。
  test("敏感路由非法 JSON 原请求透传", async () => {
    let receivedText = "";
    stubAuthHandler(async (request) => {
      receivedText = await request.text();
      return new Response(null, { status: 204 });
    });

    const response = await authRequest("/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(204);
    expect(receivedText).toBe("{");
  });

  // 无效手机号的通用认证请求应保留给 better-auth，而不是在插件层抛错。
  test("敏感路由非法手机号原样转交", async () => {
    let receivedBody: unknown;
    stubAuthHandler(async (request) => {
      receivedBody = await request.json();
      return new Response(null, { status: 204 });
    });

    expect((await jsonRequest("/sign-in/email", { phoneNumber: "not-a-phone" })).status).toBe(204);
    expect(receivedBody).toEqual({ phoneNumber: "not-a-phone" });
  });

  // 手机号注册要求 JSON 对象请求体。
  test("手机号注册拒绝非法 JSON", async () => {
    const response = await authRequest("/sign-up/phone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ code: "INVALID_REQUEST", message: "请求体格式不正确" });
  });

  // 手机号注册拒绝缺失姓名。
  test("手机号注册拒绝缺失姓名", async () => {
    const response = await jsonRequest("/sign-up/phone", { phoneNumber: "13800138000", password: "secret" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  // 手机号注册拒绝缺失密码。
  test("手机号注册拒绝缺失密码", async () => {
    const response = await jsonRequest("/sign-up/phone", { name: "张三", phoneNumber: "13800138000" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  // 手机号注册拒绝缺失手机号。
  test("手机号注册拒绝缺失手机号", async () => {
    const response = await jsonRequest("/sign-up/phone", { name: "张三", password: "secret" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  // 手机号注册将手机号格式错误映射为确定的 400 响应。
  test("手机号注册映射非法手机号错误", async () => {
    const response = await jsonRequest("/sign-up/phone", { name: "张三", password: "secret", phoneNumber: "123" });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ code: "INVALID_PHONE_NUMBER", message: "手机号格式不正确" });
  });

  // 已存在手机号必须在调用 better-auth 前被拒绝。
  test("手机号注册拒绝重复手机号", async () => {
    stubDb(emptyDb([{ id: "existing-user" }]));
    let handlerCalled = false;
    stubAuthHandler(() => {
      handlerCalled = true;
      return new Response(null, { status: 201 });
    });

    const response = await jsonRequest("/sign-up/phone", {
      name: "张三",
      password: "secret",
      phoneNumber: "13800138000",
    });

    expect(response.status).toBe(422);
    expect(await readJson(response)).toEqual({ code: "PHONE_NUMBER_EXISTS", message: "该手机号已注册" });
    expect(handlerCalled).toBeFalse();
  });

  // 注册成功必须 trim 姓名、归一化手机号并生成临时邮箱。
  test("手机号注册转换为邮箱注册载荷", async () => {
    stubDb(emptyDb());
    let receivedBody: unknown;
    let receivedPath = "";
    stubAuthHandler(async (request) => {
      receivedPath = new URL(request.url).pathname;
      receivedBody = await request.json();
      return new Response(null, { status: 201 });
    });

    const response = await jsonRequest("/sign-up/phone", {
      name: " 张三 ",
      password: "secret",
      phoneNumber: "+86 138 0013 8000",
    });

    expect(response.status).toBe(201);
    expect(receivedPath).toBe("/api/auth/sign-up/email");
    expect(receivedBody).toEqual({
      name: "张三",
      password: "secret",
      phoneNumber: "13800138000",
      email: "13800138000@fenix.com",
    });
  });

  // test seam 必须短路 session 与 API key 解析。
  test("测试认证 seam 优先返回注入上下文", async () => {
    setTestAuth({ user, authContext: { organizationId: "org-1", userId: user.id, role: "admin" } });
    stubAuthApi({ getSession: async () => null });

    const result = await authenticateRequest(new Request("http://localhost/resource"));

    expect(result).toEqual({
      user,
      authSession: { id: "test-session", userId: user.id, token: "test" },
      authEnvironmentId: null,
      authContext: { organizationId: "org-1", userId: user.id, role: "admin" },
    });
  });

  // test seam 提供的 session 应覆盖默认 session。
  test("测试认证 seam 保留显式 session", async () => {
    setTestAuth({
      user,
      session: { id: "session-9", userId: user.id, token: "token-9" },
      authContext: null,
    });

    expect((await authenticateRequest(new Request("http://localhost/resource")))?.authSession).toEqual({
      id: "session-9",
      userId: user.id,
      token: "token-9",
    });
  });

  // 无 session 且无 token 时认证结果必须为空。
  test("无凭据请求返回 null", async () => {
    stubAuthApi({ getSession: async () => null });

    expect(await authenticateRequest(new Request("http://localhost/resource"))).toBeNull();
  });

  // session 认证优先于 Authorization API key，不应调用 API key 验证。
  test("session 优先于 Authorization token", async () => {
    let verifyCalled = false;
    setTestOrgContext({ organizationId: "org-1", userId: user.id, role: "member" });
    stubAuthApi({
      getSession: async () => ({ user, session: { id: "session-1", userId: user.id, token: "cookie-token" } }),
      verifyApiKey: async () => {
        verifyCalled = true;
        return { valid: false };
      },
    });

    const result = await authenticateRequest(
      new Request("http://localhost/resource", { headers: { Authorization: "Bearer api-key" } }),
    );

    expect(result?.authSession?.id).toBe("session-1");
    expect(verifyCalled).toBeFalse();
  });

  // session guard 应将 seam 用户、session 和组织上下文写入 route store。
  test("session guard 注入认证 store", async () => {
    setTestAuth({ user, authContext: { organizationId: "org-1", userId: user.id, role: "owner" } });

    const response = await sessionGuard().handle(new Request("http://localhost/protected"));

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ userId: user.id, sessionId: "test-session", organizationId: "org-1" });
  });

  // session guard 必须在未认证时统一映射为 401。
  test("session guard 拒绝未认证请求", async () => {
    stubAuthApi({ getSession: async () => null });

    const response = await sessionGuard().handle(new Request("http://localhost/protected"));

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({ error: { type: "unauthorized", message: "Not authenticated" } });
  });

  // uuid guard 拒绝缺少 uuid 的请求。
  test("uuid guard 拒绝缺失 uuid", async () => {
    const response = await uuidGuard().handle(new Request("http://localhost/uuid"));

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({ error: { type: "unauthorized", message: "Missing uuid" } });
  });

  // uuid guard 将查询参数原样注入 store。
  test("uuid guard 注入 uuid", async () => {
    const response = await uuidGuard().handle(new Request("http://localhost/uuid?uuid=job-42"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("job-42");
  });

  // errorResponse 必须产生标准 JSON 响应与指定状态码。
  test("errorResponse 保留状态和 JSON 内容", async () => {
    const response = errorResponse(418, { error: "teapot" });

    expect(response.status).toBe(418);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await readJson(response)).toEqual({ error: "teapot" });
  });
});
