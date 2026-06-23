import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import webAgentSites from "../routes/web/agent-sites";
import { clearOrgCache, setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const TEST_APP_ID = "test-app-uuid";
const TEST_REMOTE_APP_ID = "app-abc12345";

function makeAppRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_APP_ID,
    organizationId: "test-org",
    userId: "test-user",
    remoteAppId: TEST_REMOTE_APP_ID,
    name: "my-app",
    description: null,
    platformToken: "tok-xxx.yyy",
    platformTokenId: "tok-001",
    visibility: "private",
    createdAt: new Date("2026-06-23"),
    updatedAt: new Date("2026-06-23"),
    ...overrides,
  };
}

describe("agent-sites L1 routes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetAllStubs();
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-org", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-org", userId: "test-user", role: "owner" });
    // Stub fetch 避免真实网络请求
    globalThis.fetch = (async (_input: string | URL | Request) =>
      new Response(JSON.stringify({ success: true, data: {} }), {
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    clearOrgCache();
    globalThis.fetch = originalFetch;
  });

  test("GET /apps 返回空列表", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request("http://localhost/agent-sites/apps"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  test("GET /apps 返回 app 列表（不含 platformToken）", async () => {
    const row = makeAppRow();
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([row]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request("http://localhost/agent-sites/apps"));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].id).toBe(TEST_APP_ID);
    // 不返回 platformToken
    expect(json.data[0].platformToken).toBeUndefined();
  });

  test("GET /apps/:id org 不匹配返回 404", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeAppRow({ organizationId: "other-org" })]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}`));
    expect(res.status).toBe(404);
  });

  test("GET /apps/:id 匹配返回详情", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeAppRow()]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}`));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("my-app");
  });

  test("DELETE /apps/:id 无写权限返回 403（member 角色）", async () => {
    setTestAuth({
      user: { id: "other-user", email: "other@test.com", name: "Other" },
      authContext: { organizationId: "test-org", userId: "other-user", role: "member" },
    });
    setTestOrgContext({ organizationId: "test-org", userId: "other-user", role: "member" });

    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([makeAppRow()]),
          }),
        }),
      }),
    });
    const res = await webAgentSites.handle(
      new Request(`http://localhost/agent-sites/apps/${TEST_APP_ID}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(403);
  });
});
