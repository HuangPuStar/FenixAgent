import { afterEach, describe, expect, test } from "bun:test";
import apiSystemPeopleTreeRoutes, { setSystemPeopleTreeServiceForTests } from "../routes/api/system-people-tree";

function request(path: string, init?: RequestInit) {
  return apiSystemPeopleTreeRoutes.handle(new Request(`http://localhost${path}`, init));
}

describe("API System People Tree", () => {
  const originalKeys = process.env.RCS_SYSTEM_API_KEYS;

  afterEach(() => {
    setSystemPeopleTreeServiceForTests(null);
    process.env.RCS_SYSTEM_API_KEYS = originalKeys;
  });

  // 人员管理属于系统级视图，未携带系统 key 时不得返回任何组织或人员关系。
  test("无系统 key 时返回 401", async () => {
    process.env.RCS_SYSTEM_API_KEYS = "people-tree-test-key";

    const response = await request("/api/system/people-tree/");

    expect(response.status).toBe(401);
  });

  // 有效系统 key 返回组织、成员与智能体的嵌套关系，并保留无成员角色的历史 owner。
  test("返回组织到用户到智能体的层级关系", async () => {
    process.env.RCS_SYSTEM_API_KEYS = "people-tree-test-key";
    setSystemPeopleTreeServiceForTests({
      listTree: async () => [
        {
          id: "org_1",
          name: "研发部",
          slug: "engineering",
          users: [
            {
              id: "user_1",
              name: "张三",
              email: "zhangsan@example.com",
              role: "owner",
              agents: [
                {
                  id: "6ad05077-cd14-4d90-a80f-8aa3d8878479",
                  name: "代码助手",
                  description: "协助研发工作",
                  machineId: "machine_1",
                  engineType: "opencode",
                },
              ],
            },
          ],
        },
      ],
    });

    const response = await request("/api/system/people-tree/", {
      headers: { Authorization: "Bearer people-tree-test-key" },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { organizations: unknown[] };
    };
    expect(body).toEqual({
      success: true,
      data: {
        organizations: [
          {
            id: "org_1",
            name: "研发部",
            slug: "engineering",
            users: [
              {
                id: "user_1",
                name: "张三",
                email: "zhangsan@example.com",
                role: "owner",
                agents: [
                  {
                    id: "6ad05077-cd14-4d90-a80f-8aa3d8878479",
                    name: "代码助手",
                    description: "协助研发工作",
                    machineId: "machine_1",
                    engineType: "opencode",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });
});
