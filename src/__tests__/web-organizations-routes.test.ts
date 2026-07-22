import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import organizationsRoute from "../routes/web/organizations";
import { resetAllStubs, stubAuthApi, stubDb } from "../test-utils/helpers";

function createSequentialDb(responses: unknown[]) {
  let callIndex = 0;

  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => responses[callIndex++],
          execute: async () => responses[callIndex++],
        }),
      }),
    }),
  };
}

describe("web organizations routes", () => {
  beforeEach(() => {
    setTestAuth({
      user: { id: "owner-1", email: "owner@fenix.com", name: "owner" },
      authContext: { organizationId: "org-1", userId: "owner-1", role: "owner" },
    });
  });

  afterEach(() => {
    resetAllStubs();
    resetTestAuth();
  });

  // 批量添加成员时应逐个调用底层 addMember，并返回全部新增成员。
  test("POST /web/organizations/:id/members supports batch userIds", async () => {
    const addMemberBodies: Array<Record<string, unknown>> = [];

    stubAuthApi({
      addMember: async ({ body }: { body: Record<string, unknown> }) => {
        addMemberBodies.push(body);
        return {
          id: `membership-${String(body.userId)}`,
          userId: body.userId,
          role: body.role,
        };
      },
    });

    const response = await organizationsRoute.handle(
      new Request("http://localhost/organizations/org-1/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "member",
          userIds: ["member-1", "member-2"],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(addMemberBodies).toEqual([
      { userId: "member-1", role: "member", organizationId: "org-1" },
      { userId: "member-2", role: "member", organizationId: "org-1" },
    ]);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: [
        { id: "membership-member-1", userId: "member-1", role: "member" },
        { id: "membership-member-2", userId: "member-2", role: "member" },
      ],
    });
  });

  // 搜索候选成员时应返回邮箱和手机号，并标记已在当前组织内的用户不可重复添加。
  test("GET /web/organizations/:id/member-candidates returns searchable users with membership flags", async () => {
    stubDb(
      createSequentialDb([
        [
          { id: "user-1", name: "Alice", email: "alice@fenix.com", phoneNumber: "+8613800138000" },
          { id: "user-2", name: "Alice", email: "alice2@fenix.com", phoneNumber: null },
        ],
        [{ userId: "user-2" }],
      ]),
    );

    const response = await organizationsRoute.handle(
      new Request("http://localhost/organizations/org-1/member-candidates?keyword=alice", {
        method: "GET",
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: [
        {
          id: "user-1",
          name: "Alice",
          email: "alice@fenix.com",
          phoneNumber: "+8613800138000",
          isMember: false,
        },
        {
          id: "user-2",
          name: "Alice",
          email: "alice2@fenix.com",
          phoneNumber: null,
          isMember: true,
        },
      ],
    });
  });
});
