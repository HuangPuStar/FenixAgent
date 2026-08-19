import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const originalFetch = globalThis.fetch;
const fetchCalls: Array<[string, RequestInit]> = [];

beforeEach(() => {
  fetchCalls.length = 0;
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    fetchCalls.push([url, init]);
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, data: null }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function expectRequest(index: number, url: string, method: string, body?: unknown) {
  const [actualUrl, init] = fetchCalls[index] ?? [];
  expect(actualUrl).toBe(url);
  expect(init?.method).toBe(method);
  expect(body === undefined ? init?.body : JSON.parse(init?.body as string)).toEqual(body);
}

describe("organization API client", () => {
  // 组织、成员和活跃组织操作必须保留 REST 方法、路径编码与请求数据流。
  test("maps organization and member operations to their encoded REST contracts", async () => {
    const { orgApi } = await import("../api/organizations");

    await orgApi.list();
    await orgApi.get("org/a");
    await orgApi.create({ name: "研发组", slug: "engineering" });
    await orgApi.update("org/a", { name: "平台组" });
    await orgApi.del("org/a");
    await orgApi.setActive("org/a");
    await orgApi.listMembers("org/a");
    await orgApi.searchMemberCandidates("org/a", "张 三");
    await orgApi.addMember("org/a", { userIds: ["user/1"], role: "member" });
    await orgApi.removeMember("org/a", "member/1");
    await orgApi.updateRole("org/a", "member/1", "admin");
    await orgApi.updateMetadata("org/a", { defaultEngine: "claude" });

    expectRequest(0, "/web/organizations", "GET");
    expectRequest(1, "/web/organizations/org%2Fa", "GET");
    expectRequest(2, "/web/organizations", "POST", { name: "研发组", slug: "engineering" });
    expectRequest(3, "/web/organizations/org%2Fa", "PUT", { name: "平台组" });
    expectRequest(4, "/web/organizations/org%2Fa", "DELETE");
    expectRequest(5, "/web/organizations/org%2Fa/set-active", "POST");
    expectRequest(6, "/web/organizations/org%2Fa/members", "GET");
    expectRequest(7, "/web/organizations/org%2Fa/member-candidates?keyword=%E5%BC%A0+%E4%B8%89", "GET");
    expectRequest(8, "/web/organizations/org%2Fa/members", "POST", { userIds: ["user/1"], role: "member" });
    expectRequest(9, "/web/organizations/org%2Fa/members/member%2F1", "DELETE");
    expectRequest(10, "/web/organizations/org%2Fa/members/member%2F1", "PUT", { role: "admin" });
    expectRequest(11, "/web/organizations/org%2Fa", "PUT", { data: { defaultEngine: "claude" } });
  });
});
