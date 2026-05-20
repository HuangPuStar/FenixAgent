import { describe, test, expect, mock, beforeEach } from "bun:test";

// mock better-auth 在 import 前注册
mock.module("../auth/better-auth", () => ({
  auth: {
    api: {
      listMembers: mock(async () => []),
      listOrganizations: mock(async () => []),
      createOrganization: mock(async () => ({ id: "org_auto", name: "Personal" })),
    },
    handler: mock(() => new Response()),
  },
}));

import { setTestOrgContext, clearOrgCache } from "../services/org-context";

describe("loadOrgContext", () => {
  beforeEach(() => {
    setTestOrgContext(null);
    clearOrgCache();
  });

  // 无组织时不应自动创建
  test("loadOrgContext returns null when user has no organizations (no auto-create)", async () => {
    const { loadOrgContext } = await import("../services/org-context");
    const req = new Request("http://localhost/web/test");
    const user = { id: "user_no_org" };
    const result = await loadOrgContext(user, req);
    expect(result).toBeNull();
  });

  // 有 activeOrgId 且用户是成员时返回正确的 AuthContext
  test("loadOrgContext returns context when activeOrgId matches membership", async () => {
    const { loadOrgContext } = await import("../services/org-context");
    const { auth } = await import("../auth/better-auth");
    (auth.api.listMembers as any).mockImplementationOnce(async () => [
      { userId: "user_1", role: "owner" },
    ]);
    const req = new Request("http://localhost/web/test", {
      headers: { "x-active-org-id": "org_1" },
    });
    const result = await loadOrgContext({ id: "user_1" }, req);
    expect(result).toEqual({
      organizationId: "org_1",
      userId: "user_1",
      role: "owner",
    });
  });
});

describe("org-context cache", () => {
  beforeEach(() => {
    setTestOrgContext(null);
    clearOrgCache();
  });

  // 缓存命中时不再查 DB
  test("cache hit returns cached context without DB call", async () => {
    const { loadOrgContext } = await import("../services/org-context");
    const { auth } = await import("../auth/better-auth");

    // 第一次调用：查 DB
    (auth.api.listMembers as any).mockImplementationOnce(async () => [
      { userId: "user_cache", role: "admin" },
    ]);
    const req = new Request("http://localhost/web/test", {
      headers: { "x-active-org-id": "org_cached" },
    });
    const result1 = await loadOrgContext({ id: "user_cache" }, req);
    expect(result1).not.toBeNull();
    expect(result1!.organizationId).toBe("org_cached");

    // 第二次调用：应命中缓存
    const result2 = await loadOrgContext({ id: "user_cache" }, req);
    expect(result2).toEqual(result1);
  });
});
