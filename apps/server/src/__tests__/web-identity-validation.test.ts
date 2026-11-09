import { afterEach, describe, expect, test } from "bun:test";
import { createWebApiKeysRoutes, createWebOrganizationsRoutes } from "@fenix/identity/server";
import { resetAllStubs, stubAuthApi } from "@fenix/platform-sdk/testing";
import { createWebConfigProdViewsRoutes } from "@fenix/resource-prod-view/server";
import { APIError } from "better-auth";
import { Elysia } from "elysia";
import { createWebOpenApiPlugin } from "../openapi";
import { errorPlugin } from "../plugins/error-handler";

const authGuardPlugin = new Elysia({ name: "test-web-identity-validation" })
  .decorate("error", (status: number, body: unknown) => Response.json(body, { status }))
  .state({ authContext: { organizationId: "org-1", userId: "user-1", role: "owner" } })
  .macro({ sessionAuth: () => ({}) });
const app = new Elysia({ prefix: "/web" })
  .use(createWebOpenApiPlugin("test"))
  .use(errorPlugin)
  .use(createWebOrganizationsRoutes({ authGuardPlugin }))
  .use(createWebApiKeysRoutes({ authGuardPlugin }))
  .use(createWebConfigProdViewsRoutes({ authGuardPlugin }));

/** 经真实路由及宿主错误处理器发送请求，BetterAuth 仅替换外部持久化边界。 */
function requestJson(path: string, body: unknown, method = "POST") {
  return app.handle(
    new Request(`http://localhost/web/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

afterEach(() => resetAllStubs());

describe("组织创建参数与冲突", () => {
  // 空白名称与 Slug 必须在进入认证存储前拒绝，并标明错误字段。
  test.each([
    [{ name: "", slug: "" }, "name"],
    [{ name: "", slug: "test-org" }, "name"],
    [{ name: "test-org", slug: "" }, "slug"],
    [{ name: " \t ", slug: "test-org" }, "name"],
    [{ name: "test-org", slug: " \t " }, "slug"],
  ])("拒绝无效组织字段 %j", async (input, field) => {
    const response = await requestJson("organizations", input);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code ?? body.error.type).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain(field);
  });

  // BetterAuth 创建和 Slug 检查的两种冲突码都必须提供可操作的稳定业务错误。
  test.each([
    "ORGANIZATION_ALREADY_EXISTS",
    "ORGANIZATION_SLUG_ALREADY_TAKEN",
  ])("Slug 冲突 %s 返回 409", async (code) => {
    stubAuthApi({
      createOrganization: async () => {
        throw APIError.from("BAD_REQUEST", { code, message: "Organization already exists" });
      },
    });
    const response = await requestJson("organizations", { name: "组织", slug: "existing" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "ORGANIZATION_SLUG_ALREADY_TAKEN" } });
  });

  // 未知存储故障不能被伪装成参数或冲突错误，也不能泄漏内部异常正文。
  test("未知组织创建异常保留 500", async () => {
    stubAuthApi({
      createOrganization: async () => {
        throw new Error("database unavailable");
      },
    });
    const response = await requestJson("organizations", { name: "组织", slug: "valid" });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { message: "Internal server error" } });
  });

  // 合法创建仍透传会话凭据及描述，并返回序列化后的组织信息。
  test("合法组织创建保持成功契约", async () => {
    stubAuthApi({
      createOrganization: async ({ body }: { body: { name: string; slug: string; metadata: unknown } }) => ({
        id: "org-new",
        ...body,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
    });
    const response = await requestJson("organizations", { name: "组织", slug: "valid", description: "说明" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { name: "组织", slug: "valid", metadata: { description: "说明" } },
    });
  });
});

describe("组织更新参数", () => {
  // 顶层与透传 data 都不能绕过非空白约束，非法输入不得触发存储写入。
  test.each([
    { name: "" },
    { name: " \t " },
    { slug: "" },
    { slug: " \t " },
    { data: { name: "" } },
    { data: { name: " \t " } },
    { data: { slug: "" } },
    { data: { slug: " \t " } },
  ])("更新拒绝空白组织字段 %j", async (input) => {
    let called = false;
    stubAuthApi({
      updateOrganization: async () => {
        called = true;
        return { id: "org-1", name: "组织", slug: "valid", createdAt: new Date(0) };
      },
    });
    const response = await requestJson("organizations/org-1", input, "PUT");
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  // 部分更新仍允许省略名称和 Slug，透传的其他组织属性不能被裁剪。
  test.each([
    { name: "新名称" },
    { data: { metadata: { description: "说明" }, logo: "logo.png" } },
  ])("合法组织部分更新保留字段 %j", async (input) => {
    let received: unknown;
    stubAuthApi({
      updateOrganization: async ({ body }: { body: { data: Record<string, unknown> } }) => {
        received = body.data;
        return { id: "org-1", name: "组织", slug: "valid", createdAt: new Date(0) };
      },
    });
    const response = await requestJson("organizations/org-1", input, "PUT");
    expect(response.status).toBe(200);
    expect(received).toEqual("data" in input ? input.data : input);
  });
});

describe("API Key 过期时间", () => {
  // 时间戳 0 及无效日期不得被误当作永久密钥或变成下游 500。
  test.each([
    "2020-01-01T00:00:00.000Z",
    0,
    "",
    "not-a-date",
    Date.now(),
  ])("拒绝无效或已到期时间 %j", async (expiresAt) => {
    const response = await requestJson("api-keys", { name: "key", expiresAt });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
  });

  // 合法未来时间与省略过期时间都保留现有创建行为，组织信息由认证上下文决定。
  test.each([
    undefined,
    new Date(Date.now() + 86_400_000).toISOString(),
    Date.now() + 86_400_000,
  ])("接受合法过期时间 %j", async (expiresAt) => {
    stubAuthApi({
      listApiKeys: async () => [],
      createApiKey: async ({ body }: { body: { expiresIn: number | null; metadata: unknown } }) => ({
        id: "key-1",
        ...body,
      }),
    });
    const response = await requestJson("api-keys", { name: "key", expiresAt });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    if (expiresAt === undefined) expect(body.data.expiresIn).toBeNull();
    else expect(body.data.expiresIn).toBeGreaterThan(0);
    expect(body.data.metadata).toMatchObject({ organizationId: "org-1" });
  });

  // 插件的最短与最长有效期拒绝属于参数错误，不能被宿主兜底成内部故障。
  test.each([
    ["EXPIRES_IN_IS_TOO_SMALL", 3_600_000],
    ["EXPIRES_IN_IS_TOO_LARGE", 366 * 86_400_000],
  ])("插件有效期拒绝 %s 返回 400", async (code, duration) => {
    stubAuthApi({
      listApiKeys: async () => [],
      createApiKey: async () => {
        throw APIError.from("BAD_REQUEST", { code, message: "Plugin expiration rejected" });
      },
    });
    const response = await requestJson("api-keys", { name: "key", expiresAt: Date.now() + duration });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR", message: expect.stringContaining("expiresAt") },
    });
  });

  // 仅转换明确的有效期错误，其他插件故障继续保留原异常并脱敏响应。
  test("未知 API Key 插件错误仍返回 500", async () => {
    stubAuthApi({
      listApiKeys: async () => [],
      createApiKey: async () => {
        throw APIError.from("BAD_REQUEST", { code: "UNEXPECTED_PLUGIN_ERROR", message: "internal detail" });
      },
    });
    const response = await requestJson("api-keys", { name: "key" });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { message: "Internal server error" } });
  });
});

// UUID 格式应由路由 schema 拒绝，不能等数据库报错再被映射为资源不存在。
test.each(["GET", "DELETE"])("%s 非法发布视图 ID 返回 400 参数错误", async (method) => {
  const response = await app.handle(new Request("http://localhost/web/config/prod-views/not-a-uuid", { method }));
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error.code ?? body.error.type).toBe("VALIDATION_ERROR");
});

// OpenAPI 必须描述真实宿主返回的校验错误信封，而不只是业务错误的 code 信封。
test("发布视图 DELETE 文档包含真实 400 校验响应", async () => {
  const response = await app.handle(new Request("http://localhost/web/docs/openapi/web/json"));
  expect(response.status).toBe(200);
  const spec = await response.json();
  const schema = spec.paths["/web/config/prod-views/{id}"].delete.responses["400"].content["application/json"].schema;
  expect(schema.anyOf).toContainEqual(
    expect.objectContaining({
      properties: expect.objectContaining({
        error: expect.objectContaining({
          properties: { type: { type: "string", const: "VALIDATION_ERROR" }, message: { type: "string" } },
        }),
      }),
    }),
  );
});
