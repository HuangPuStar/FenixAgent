import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import organizationsRoute from "../routes/web/organizations";
import { resetAllStubs, stubAuthApi, stubDb } from "../test-utils/helpers";

function createLookupDb(rows: Array<{ id: string }>) {
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

  // 应支持通过手机号查找成员，再继续走 better-auth 组织加成员接口。
  test("POST /web/organizations add-member supports phone numbers", async () => {
    let addMemberBody: Record<string, unknown> | null = null;

    stubDb(createLookupDb([{ id: "member-1" }]));
    stubAuthApi({
      addMember: async ({ body }: { body: Record<string, unknown> }) => {
        addMemberBody = body;
        return { id: "membership-1", userId: "member-1", role: "member" };
      },
    });

    const response = await organizationsRoute.handle(
      new Request("http://localhost/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add-member",
          organizationId: "org-1",
          role: "member",
          identifier: "+86 188 2648 0215",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(addMemberBody as Record<string, unknown> | null).toEqual({
      userId: "member-1",
      role: "member",
      organizationId: "org-1",
    });
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: { id: "membership-1", userId: "member-1", role: "member" },
    });
  });
});
