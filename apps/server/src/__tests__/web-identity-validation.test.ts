import { afterEach, describe, expect, test } from "bun:test";
import { createWebApiKeysRoutes, createWebOrganizationsRoutes } from "@fenix/identity/server";
import { resetAllStubs, stubAuthApi } from "@fenix/platform-sdk/testing";
import { createWebConfigProdViewsRoutes } from "@fenix/resource-prod-view/server";
import { APIError } from "better-auth";
import { Elysia } from "elysia";
import { errorPlugin } from "../plugins/error-handler";

const authGuardPlugin = new Elysia({ name: "test-web-identity-validation" })
  .decorate("error", (status: number, body: unknown) => Response.json(body, { status }))
  .state({ authContext: { organizationId: "org-1", userId: "user-1", role: "owner" } })
  .macro({ sessionAuth: () => ({}) });
const app = new Elysia({ prefix: "/web" })
  .use(errorPlugin)
  .use(createWebOrganizationsRoutes({ authGuardPlugin }))
  .use(createWebApiKeysRoutes({ authGuardPlugin }))
  .use(createWebConfigProdViewsRoutes({ authGuardPlugin }));

/** 经真实路由及宿主错误处理器发送请求，BetterAuth 仅替换外部持久化边界。 */
function post(path: string, body: unknown) {
  return app.handle(
    new Request(`http://localhost/web/${path}`, {
      method: "POST",
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
    const response = await post("organizations", input);
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
    const response = await post("organizations", { name: "组织", slug: "existing" });
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
    const response = await post("organizations", { name: "组织", slug: "valid" });
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
    const response = await post("organizations", { name: "组织", slug: "valid", description: "说明" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { name: "组织", slug: "valid", metadata: { description: "说明" } },
    });
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
    const response = await post("api-keys", { name: "key", expiresAt });
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
    const response = await post("api-keys", { name: "key", expiresAt });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    if (expiresAt === undefined) expect(body.data.expiresIn).toBeNull();
    else expect(body.data.expiresIn).toBeGreaterThan(0);
    expect(body.data.metadata).toMatchObject({ organizationId: "org-1" });
  });
});

// UUID 格式应由路由 schema 拒绝，不能等数据库报错再被映射为资源不存在。
test("非法发布视图 ID 返回 400 参数错误", async () => {
  const response = await app.handle(new Request("http://localhost/web/config/prod-views/not-a-uuid"));
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error.code ?? body.error.type).toBe("VALIDATION_ERROR");
});
