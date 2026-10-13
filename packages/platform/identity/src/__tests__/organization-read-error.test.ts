import { describe, expect, test } from "bun:test";
import { APIError } from "better-auth";
import { Elysia } from "elysia";
import { createWebOrganizationsRoutes, organizationReadError } from "../routes/web/organizations";

describe("organization read error mapping", () => {
  // BetterAuth 对非成员抛出的 403 必须保持拒绝语义，且响应不回显其内部错误正文。
  test("maps a BetterAuth non-member error to a 403 web envelope", () => {
    const denial = APIError.from("FORBIDDEN", {
      code: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
      message: "You are not a member of this organization",
    });

    expect(organizationReadError(denial)).toEqual({
      status: 403,
      body: { success: false, error: { code: "FORBIDDEN", message: "Access denied" } },
    });
  });

  // BetterAuth 明确隐藏的组织保持 404，不能被误映射为服务器异常。
  test("maps a BetterAuth hidden resource error to 404", () => {
    const hidden = APIError.from("NOT_FOUND", { code: "ORGANIZATION_NOT_FOUND", message: "Organization not found" });

    expect(organizationReadError(hidden)).toEqual({
      status: 404,
      body: { success: false, error: { code: "NOT_FOUND", message: "Organization not found" } },
    });
  });

  // 未知服务错误继续交给既有错误处理链，避免把故障伪装成权限不足。
  test("leaves unrelated errors untouched", () => {
    expect(organizationReadError(new Error("database unavailable"))).toBeNull();
    expect(organizationReadError(APIError.from("INTERNAL_SERVER_ERROR", { message: "upstream failed" }))).toBeNull();
  });

  // 两条只读组织端点都必须把 BetterAuth 的非成员异常返回为 HTTP 403，而非宿主默认 500。
  test("returns 403 for non-member organization detail and member list requests", async () => {
    const denial = APIError.from("FORBIDDEN", {
      code: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
      message: "You are not a member of this organization",
    });
    const guard = new Elysia({ name: "test-organization-auth" })
      .decorate({
        error(status: number, body: unknown) {
          return Response.json(body, { status });
        },
      })
      .state({ authContext: { organizationId: "own-org" } })
      .macro({
        sessionAuth() {
          return {};
        },
      });
    const routes = createWebOrganizationsRoutes(
      { authGuardPlugin: guard },
      {
        getFullOrganization: async () => {
          throw denial;
        },
        listMembers: async () => {
          throw denial;
        },
      },
    );

    for (const path of ["/organizations/other-org", "/organizations/other-org/members"]) {
      const response = await routes.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        success: false,
        error: { code: "FORBIDDEN", message: "Access denied" },
      });
    }
  });
});
