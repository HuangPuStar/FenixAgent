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
      listUserApiKeys: async () => ({
        items: [
          {
            id: "key-1",
            name: "automation",
            prefix: "rcs_",
            start: "rcs_se",
            userId: "user-1",
            organizationId: "org-1",
            role: "admin",
            createdAt: new Date("2026-06-17T00:00:00.000Z"),
            expiresAt: null,
            metadata: { organizationId: "org-1", role: "admin" },
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
      listUserOrganizations: async () => ({
        items: [
          {
            id: "org-1",
            name: "System Org",
            slug: "system-org",
            logo: null,
            metadata: null,
            createdAt: new Date("2026-06-17T00:00:00.000Z"),
            role: "admin",
            memberId: "mem-1",
            memberCreatedAt: new Date("2026-06-18T00:00:00.000Z"),
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
      createUser: async () => ({
        id: "user-1",
        name: "System User",
        email: "system@example.com",
        emailVerified: true,
        phoneNumber: "18826480215",
        phoneNumberVerified: false,
        createdAt: new Date("2026-06-17T00:00:00.000Z"),
        updatedAt: new Date("2026-06-17T00:00:00.000Z"),
      }),
      deleteUser: async () => ({ deleted: true }),
      resetUserPassword: async () => ({ updated: true }),
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
        start: "rcs_se",
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
        emailVerified: true,
        phoneNumber: "+86 188 2648 0215",
        name: "System User",
        password: "super-secret",
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "user-1",
      name: "System User",
      email: "system@example.com",
      emailVerified: true,
      phoneNumber: "18826480215",
      phoneNumberVerified: false,
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
    });
  });

  // 系统级用户创建接口应支持仅通过手机号创建可登录用户。
  test("POST /api/system/users supports phone-only user creation", async () => {
    const res = await request("/api/system/users", {
      method: "POST",
      headers: {
        Authorization: "Bearer sys-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "System User",
        phoneNumber: "18826480215",
        password: "super-secret",
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "user-1",
      name: "System User",
      email: "system@example.com",
      emailVerified: true,
      phoneNumber: "18826480215",
      phoneNumberVerified: false,
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
    });
  });

  // 系统级用户创建接口应支持显式设置手机号验证状态。
  test("POST /api/system/users accepts phoneNumberVerified", async () => {
    stubSystemApi({
      createUser: async (input: {
        email?: string;
        phoneNumber?: string;
        phoneNumberVerified?: boolean;
        name: string;
        password: string;
        emailVerified?: boolean;
      }) => ({
        id: "user-1",
        name: input.name,
        email: input.email ?? "18826480215@fenix.com",
        emailVerified: input.emailVerified ?? false,
        phoneNumber: input.phoneNumber ?? null,
        phoneNumberVerified: input.phoneNumberVerified ?? false,
        createdAt: new Date("2026-06-17T00:00:00.000Z"),
        updatedAt: new Date("2026-06-17T00:00:00.000Z"),
      }),
    });

    const res = await request("/api/system/users", {
      method: "POST",
      headers: {
        Authorization: "Bearer sys-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Verified Phone User",
        phoneNumber: "18826480215",
        phoneNumberVerified: true,
        password: "super-secret",
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "user-1",
      name: "Verified Phone User",
      email: "18826480215@fenix.com",
      emailVerified: false,
      phoneNumber: "18826480215",
      phoneNumberVerified: true,
      createdAt: "2026-06-17T00:00:00.000Z",
      updatedAt: "2026-06-17T00:00:00.000Z",
    });
  });

  // 系统级用户 API key 列表接口应返回脱敏后的 key 列表与分页信息。
  test("GET /api/system/users/:id/api-keys lists user API keys", async () => {
    const res = await request("/api/system/users/user-1/api-keys?page=1&pageSize=20", {
      headers: { Authorization: "Bearer sys-key-1" },
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      items: [
        {
          id: "key-1",
          name: "automation",
          prefix: "rcs_",
          start: "rcs_se",
          userId: "user-1",
          organizationId: "org-1",
          role: "admin",
          createdAt: "2026-06-17T00:00:00.000Z",
          expiresAt: null,
          metadata: { organizationId: "org-1", role: "admin" },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
  });

  // 系统级用户组织列表接口应返回组织信息及该用户的成员角色上下文。
  test("GET /api/system/users/:id/organizations lists user organizations", async () => {
    const res = await request("/api/system/users/user-1/organizations?page=1&pageSize=20", {
      headers: { Authorization: "Bearer sys-key-2" },
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      items: [
        {
          id: "org-1",
          name: "System Org",
          slug: "system-org",
          logo: null,
          metadata: null,
          createdAt: "2026-06-17T00:00:00.000Z",
          role: "admin",
          memberId: "mem-1",
          memberCreatedAt: "2026-06-18T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
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
      start: "rcs_se",
      userId: "user-1",
      organizationId: "org-1",
      role: "admin",
      createdAt: "2026-06-17T00:00:00.000Z",
      expiresAt: null,
      metadata: { organizationId: "org-1", role: "admin" },
    });
  });

  // 代用户创建 API Key 时，如果用户不属于目标组织，应返回禁止访问错误。
  test("POST /api/system/api-keys rejects non-member user", async () => {
    stubSystemApi({
      createUserApiKey: async () => {
        throw new Error("User 'user-2' is not a member of organization 'org-1'");
      },
    });

    const res = await request("/api/system/api-keys", {
      method: "POST",
      headers: {
        Authorization: "Bearer sys-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-2",
        organizationId: "org-1",
        role: "member",
        name: "automation",
        expiresIn: null,
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "User 'user-2' is not a member of organization 'org-1'",
      },
    });
  });

  // 代用户创建 API Key 时，重名应返回冲突错误，避免同一用户名下出现无法区分的 key。
  test("POST /api/system/api-keys rejects duplicate names", async () => {
    stubSystemApi({
      createUserApiKey: async () => {
        throw new Error("API key name 'automation' already exists for user 'user-1'");
      },
    });

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

    expect(res.status).toBe(409);
    expect(json).toEqual({
      error: {
        code: "CONFLICT",
        message: "API key name 'automation' already exists for user 'user-1'",
      },
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

  // 系统级密码重置接口应支持通过邮箱重置密码。
  test("POST /api/system/users/reset-password resets user password by email", async () => {
    stubSystemApi({
      resetUserPassword: async () => ({ updated: true }),
    } as never);

    const res = await request("/api/system/users/reset-password", {
      method: "POST",
      headers: {
        Authorization: "Bearer sys-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "system@example.com",
        password: "new-super-secret",
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ updated: true });
  });

  // 系统级密码重置接口在手机号找不到用户时应返回 404。
  test("POST /api/system/users/reset-password returns 404 when phone user is missing", async () => {
    stubSystemApi({
      resetUserPassword: async () => {
        throw new Error("User '18800000000' not found");
      },
    } as never);

    const res = await request("/api/system/users/reset-password", {
      method: "POST",
      headers: {
        Authorization: "Bearer sys-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phoneNumber: "18800000000",
        password: "new-super-secret",
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "User '18800000000' not found",
      },
    });
  });

  // 系统级密码重置接口要求 userId、email、phoneNumber 三选一。
  test("POST /api/system/users/reset-password rejects multiple identifiers", async () => {
    const res = await request("/api/system/users/reset-password", {
      method: "POST",
      headers: {
        Authorization: "Bearer sys-key-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: "user-1",
        email: "system@example.com",
        password: "new-super-secret",
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json).toEqual({
      type: "validation",
      on: "body",
      property: "userId",
      message: "userId、email 和 phoneNumber 只能提供一个",
      found: {
        userId: "user-1",
        email: "system@example.com",
        password: "new-super-secret",
      },
      errors: [
        {
          code: "custom",
          message: "userId、email 和 phoneNumber 只能提供一个",
          path: ["userId"],
        },
      ],
    });
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
