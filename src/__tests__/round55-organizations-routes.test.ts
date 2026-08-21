import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import organizationsRoute from "../routes/web/organizations";
import { readJson, resetAllStubs, stubAuthApi, stubDb } from "../test-utils/helpers";

type Organization = {
  id: string;
  name: string;
  slug: string;
  createdAt: string | number | Date;
  metadata?: Record<string, unknown> | null;
};

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: "org-1",
    name: "研发团队",
    slug: "engineering",
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

function request(path: string, init?: RequestInit) {
  return organizationsRoute.handle(new Request(`http://localhost${path}`, init));
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json();
}

function json(path: string, method: string, body: Record<string, unknown>) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authenticate(organizationId = "org-1", role: "owner" | "admin" | "member" = "owner") {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "测试用户" },
    authContext: { organizationId, userId: "user-1", role },
  });
}

function executeDb(responses: unknown[]) {
  let index = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          execute: async () => responses[index++],
          limit: async () => responses[index++],
        }),
      }),
    }),
  };
}

describe("round55 Web 组织路由", () => {
  beforeEach(() => {
    authenticate();
  });

  afterEach(() => {
    resetAllStubs();
    resetTestAuth();
  });

  // 未认证访问组织列表必须被认证中间件拒绝。
  test("未认证组织列表返回 401", async () => {
    resetTestAuth();
    stubAuthApi({ getSession: async () => null, verifyApiKey: async () => ({ valid: false }) });

    expect((await request("/organizations")).status).toBe(401);
  });

  // 空组织列表不应查询成员关系表。
  test("空组织列表直接返回空数组", async () => {
    stubAuthApi({ listOrganizations: async () => [] });

    expect(await readJson(await request("/organizations"))).toEqual({ success: true, data: [] });
  });

  // 列表应按当前用户的成员关系补齐组织角色。
  test("组织列表补齐当前用户角色", async () => {
    stubAuthApi({ listOrganizations: async () => [organization(), organization({ id: "org-2", slug: "ops" })] });
    stubDb(executeDb([[{ organizationId: "org-1", role: "admin" }]]));

    expect(await readJson(await request("/organizations"))).toEqual({
      success: true,
      data: [
        { ...organization(), role: "admin" },
        { ...organization({ id: "org-2", slug: "ops" }), role: "member" },
      ],
    });
  });

  // 当前活跃组织详情应包含成员，并补齐手机号。
  test("当前组织详情返回成员和手机号", async () => {
    stubAuthApi({
      getFullOrganization: async () => organization({ createdAt: new Date("2026-08-19T00:00:00.000Z") }),
      listMembers: async () => ({
        members: [
          {
            id: "member-1",
            userId: "user-2",
            role: "member",
            organizationId: "org-1",
            user: { id: "user-2", name: "成员", email: "member@example.test" },
          },
        ],
      }),
    });
    stubDb(executeDb([[{ id: "user-2", phoneNumber: "+8613800138000" }]]));

    expect(await readJson(await request("/organizations/org-1"))).toEqual({
      success: true,
      data: {
        ...organization({ createdAt: "2026-08-19T00:00:00.000Z" }),
        members: [
          {
            id: "member-1",
            userId: "user-2",
            role: "member",
            organizationId: "org-1",
            user: { id: "user-2", name: "成员", email: "member@example.test", phoneNumber: "+8613800138000" },
          },
        ],
      },
    });
  });

  // 非当前组织详情不得因本地活跃租户泄露成员列表。
  test("跨租户组织详情只返回摘要", async () => {
    let requestedMembers = false;
    stubAuthApi({
      getFullOrganization: async ({ query }: { query: { organizationId: string } }) =>
        organization({ id: query.organizationId }),
      listMembers: async () => {
        requestedMembers = true;
        return [];
      },
    });

    const response = await request("/organizations/org-foreign");
    expect(response.status).toBe(200);
    expect(requestedMembers).toBe(false);
    expect(await readJson(response)).toEqual({ success: true, data: organization({ id: "org-foreign" }) });
  });

  // 创建组织应将描述收敛到 metadata.description。
  test("创建组织传递描述元数据", async () => {
    let received: Record<string, unknown> | undefined;
    stubAuthApi({
      createOrganization: async ({ body }: { body: Record<string, unknown> }) => {
        received = body;
        return organization();
      },
    });

    expect(
      (await json("/organizations", "POST", { name: "研发团队", slug: "engineering", description: "核心产品" })).status,
    ).toBe(200);
    expect(received).toEqual({ name: "研发团队", slug: "engineering", metadata: { description: "核心产品" } });
  });

  // 未提供描述时不应伪造 metadata 字段。
  test("创建组织不含描述时传递空元数据", async () => {
    let received: Record<string, unknown> | undefined;
    stubAuthApi({
      createOrganization: async ({ body }: { body: Record<string, unknown> }) => {
        received = body;
        return organization();
      },
    });

    await json("/organizations", "POST", { name: "研发团队", slug: "engineering" });
    expect(received).toEqual({ name: "研发团队", slug: "engineering", metadata: {} });
  });

  // 创建请求缺少 slug 必须在路由校验阶段失败。
  test("创建组织缺少 slug 返回 422", async () => {
    expect((await json("/organizations", "POST", { name: "研发团队" })).status).toBe(422);
  });

  // 简写更新应转换为底层 data 对象，并绑定路径中的租户。
  test("更新组织转换简写字段", async () => {
    let received: Record<string, unknown> | undefined;
    stubAuthApi({
      updateOrganization: async ({ body }: { body: Record<string, unknown> }) => {
        received = body;
        return organization({ name: "新名称", slug: "new-name" });
      },
    });

    expect((await json("/organizations/org-2", "PUT", { name: "新名称", slug: "new-name" })).status).toBe(200);
    expect(received).toEqual({ organizationId: "org-2", data: { name: "新名称", slug: "new-name" } });
  });

  // 原始 data 优先透传，不能混入兼容字段。
  test("更新组织优先透传 data", async () => {
    let received: Record<string, unknown> | undefined;
    stubAuthApi({
      updateOrganization: async ({ body }: { body: Record<string, unknown> }) => {
        received = body;
        return organization();
      },
    });

    await json("/organizations/org-2", "PUT", { name: "忽略", data: { logo: "logo.png" } });
    expect(received).toEqual({ organizationId: "org-2", data: { logo: "logo.png" } });
  });

  // 删除组织必须将路径租户 ID 传给授权边界。
  test("删除组织传递路径组织 ID", async () => {
    let received: Record<string, unknown> | undefined;
    stubAuthApi({
      deleteOrganization: async ({ body }: { body: Record<string, unknown> }) => {
        received = body;
      },
    });

    expect(await readJson(await request("/organizations/org-2", { method: "DELETE" }))).toEqual({
      success: true,
      data: { deleted: true },
    });
    expect(received).toEqual({ organizationId: "org-2" });
  });

  // 切换活跃组织必须将目标组织 ID 原样交给授权边界。
  test("切换活跃组织传递目标租户", async () => {
    let received: Record<string, unknown> | undefined;
    stubAuthApi({
      setActiveOrganization: async ({ body }: { body: Record<string, unknown> }) => {
        received = body;
      },
    });

    expect(await readJson(await request("/organizations/org-2/set-active", { method: "POST" }))).toEqual({
      success: true,
      data: null,
    });
    expect(received).toEqual({ organizationId: "org-2" });
  });

  // 成员列表应接受 better-auth 的数组响应并保留成员角色。
  test("成员列表接受数组响应", async () => {
    stubAuthApi({ listMembers: async () => [{ id: "member-2", userId: "user-2", role: "admin" }] });
    stubDb(executeDb([[{ id: "user-2", phoneNumber: "+8613900139000" }]]));

    expect(await readJson(await request("/organizations/org-2/members"))).toEqual({
      success: true,
      data: [{ id: "member-2", userId: "user-2", role: "admin" }],
    });
  });

  // 无关联用户的成员仍会按 userId 查询手机号，但返回结构不应伪造用户资料。
  test("无关联用户的成员不伪造用户资料", async () => {
    stubAuthApi({ listMembers: async () => [{ id: "member-2", userId: "user-2", role: "member" }] });
    stubDb(executeDb([[{ id: "user-2", phoneNumber: "+8613800138000" }]]));

    expect(await readJson(await request("/organizations/org-2/members"))).toEqual({
      success: true,
      data: [{ id: "member-2", userId: "user-2", role: "member" }],
    });
  });

  // 空白候选关键词应短路，不触发全站用户查询。
  test("空白候选关键词返回空数组", async () => {
    expect(await readJson(await request("/organizations/org-2/member-candidates?keyword=%20%20"))).toEqual({
      success: true,
      data: [],
    });
  });

  // 候选成员搜索以路径组织 ID 判断是否已属于该租户。
  test("候选成员按目标组织标记已有成员", async () => {
    stubDb(
      executeDb([
        [{ id: "user-2", name: "候选人", email: "candidate@example.test", phoneNumber: null }],
        [{ userId: "user-2" }],
      ]),
    );

    expect(await readJson(await request("/organizations/org-2/member-candidates?keyword=%20候选人%20"))).toEqual({
      success: true,
      data: [{ id: "user-2", name: "候选人", email: "candidate@example.test", phoneNumber: null, isMember: true }],
    });
  });

  // 添加成员应清理空白 ID，但保持请求的成员角色。
  test("批量添加成员清理空白用户 ID", async () => {
    const received: Array<Record<string, unknown>> = [];
    stubAuthApi({
      addMember: async ({ body }: { body: Record<string, unknown> }) => {
        received.push(body);
        return { id: `member-${String(body.userId)}`, userId: body.userId, role: body.role };
      },
    });

    expect(
      (await json("/organizations/org-2/members", "POST", { role: "admin", userIds: [" user-2 ", " ", "user-3"] }))
        .status,
    ).toBe(200);
    expect(received).toEqual([
      { organizationId: "org-2", userId: "user-2", role: "admin" },
      { organizationId: "org-2", userId: "user-3", role: "admin" },
    ]);
  });

  // 空成员数组必须由请求体 schema 拒绝。
  test("添加成员空数组返回 422", async () => {
    expect((await json("/organizations/org-2/members", "POST", { role: "member", userIds: [] })).status).toBe(422);
  });

  // 移除成员必须同时带上成员 ID 和组织 ID，避免跨租户歧义。
  test("移除成员绑定组织和成员 ID", async () => {
    let received: Record<string, unknown> | undefined;
    stubAuthApi({
      removeMember: async ({ body }: { body: Record<string, unknown> }) => {
        received = body;
      },
    });

    expect((await request("/organizations/org-2/members/member-2", { method: "DELETE" })).status).toBe(200);
    expect(received).toEqual({ organizationId: "org-2", memberIdOrEmail: "member-2" });
  });

  // 更新成员角色必须绑定目标组织，且角色值完整透传给权限系统。
  test("更新成员角色绑定租户", async () => {
    let received: Record<string, unknown> | undefined;
    stubAuthApi({
      updateMemberRole: async ({ body }: { body: Record<string, unknown> }) => {
        received = body;
      },
    });

    expect((await json("/organizations/org-2/members/member-2", "PUT", { role: "admin" })).status).toBe(200);
    expect(received).toEqual({ organizationId: "org-2", memberId: "member-2", role: "admin" });
  });

  // 缺少成员角色时必须在进入权限系统前被校验拒绝。
  test("更新成员角色缺少 role 返回 422", async () => {
    expect((await json("/organizations/org-2/members/member-2", "PUT", {})).status).toBe(422);
  });

  // 上游授权拒绝应保留为服务端错误，不能伪装为成功响应。
  test("上游切换组织失败返回 500", async () => {
    stubAuthApi({ setActiveOrganization: async () => Promise.reject(new Error("forbidden by upstream")) });

    expect((await request("/organizations/org-2/set-active", { method: "POST" })).status).toBe(500);
  });
});
