import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubSystemApi } from "../test-utils/helpers";

const apiSystemRoute = (await import("../routes/api/system")).default;

function request(path: string, init?: RequestInit) {
  return apiSystemRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API System Routes", () => {
  const originalKeys = process.env.RCS_SYSTEM_API_KEYS;

  beforeEach(() => {
    resetAllStubs();
    process.env.RCS_SYSTEM_API_KEYS = "sys-key-1,sys-key-2";
    stubSystemApi({
      listUsers: async () => [],
      getUserById: async () => null,
      createUser: async () => ({
        id: "user-1",
        name: "System User",
        email: "system@example.com",
        emailVerified: true,
        createdAt: new Date("2026-06-17T00:00:00.000Z"),
        updatedAt: new Date("2026-06-17T00:00:00.000Z"),
      }),
      deleteUser: async () => ({ deleted: true }),
      listOrganizations: async () => [],
      getOrganizationById: async () => null,
      createOrganization: async () => ({
        id: "org-1",
        name: "System Org",
        slug: "system-org",
        logo: null,
        metadata: null,
        createdAt: new Date("2026-06-17T00:00:00.000Z"),
      }),
      deleteOrganization: async () => ({ deleted: true }),
      addOrganizationMember: async () => ({
        id: "mem-1",
        organizationId: "org-1",
        userId: "user-1",
        role: "admin",
        createdAt: new Date("2026-06-17T00:00:00.000Z"),
      }),
      createUserApiKey: async () => ({
        id: "key-1",
        name: "automation",
        prefix: "rcs_",
        key: "rcs_secret_plaintext",
        start: "rcs_",
        userId: "user-1",
        organizationId: "org-1",
        role: "admin",
        createdAt: new Date("2026-06-17T00:00:00.000Z"),
        expiresAt: null,
        metadata: { organizationId: "org-1", role: "admin" },
      }),
      deleteUserApiKey: async () => ({ deleted: true }),
    });
  });

  afterEach(() => {
    process.env.RCS_SYSTEM_API_KEYS = originalKeys;
  });

  // 未携带系统级 key 时，应阻止访问系统级接口。
  test("GET /api/system/users requires system API key", async () => {
    const res = await request("/api/system/users?page=1&pageSize=10");
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json).toEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid system API key" },
    });
  });

  // 系统级用户创建接口应返回新建用户详情。
  test("POST /api/system/users creates user with system API key", async () => {
    const res = await request("/api/system/users", {
      method: "POST",
      headers: {
        Authorization: "Bearer sys-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "system@example.com",
        name: "System User",
        password: "super-secret",
        emailVerified: true,
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "user-1",
      name: "System User",
      email: "system@example.com",
      emailVerified: true,
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
    });
  });

  // 系统级组织成员添加接口应返回新成员信息。
  test("POST /api/system/organizations/:id/members adds member", async () => {
    const res = await request("/api/system/organizations/org-1/members", {
      method: "POST",
      headers: {
        Authorization: "Bearer sys-key-2",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
        role: "admin",
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "mem-1",
      organizationId: "org-1",
      userId: "user-1",
      role: "admin",
      createdAt: "2026-06-17T00:00:00.000Z",
    });
  });

  // 代用户创建 API Key 时，应返回明文 key 与归属上下文。
  test("POST /api/system/api-keys creates scoped user API key", async () => {
    const res = await request("/api/system/api-keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer sys-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
        organizationId: "org-1",
        role: "admin",
        name: "automation",
        expiresIn: null,
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "key-1",
      name: "automation",
      prefix: "rcs_",
      key: "rcs_secret_plaintext",
      start: "rcs_",
      userId: "user-1",
      organizationId: "org-1",
      role: "admin",
      createdAt: "2026-06-17T00:00:00.000Z",
      expiresAt: null,
      metadata: { organizationId: "org-1", role: "admin" },
    });
  });

  // 系统级删除用户接口应返回稳定删除结果。
  test("DELETE /api/system/users/:id deletes user", async () => {
    const res = await request("/api/system/users/user-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer sys-key-1" },
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ deleted: true });
  });

  // 系统级删除组织接口应返回稳定删除结果。
  test("DELETE /api/system/organizations/:id deletes organization", async () => {
    const res = await request("/api/system/organizations/org-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer sys-key-1" },
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ deleted: true });
  });

  // 系统级删除用户 API key 接口应返回稳定删除结果。
  test("DELETE /api/system/api-keys/:id deletes user API key", async () => {
    const res = await request("/api/system/api-keys/key-1", {
      method: "DELETE",
      headers: { Authorization: "Bearer sys-key-2" },
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ deleted: true });
  });
});
