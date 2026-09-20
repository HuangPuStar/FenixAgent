import { afterEach, describe, expect, test } from "bun:test";
import {
  createApiSystemPeopleTreeRoutes,
  setSystemPeopleTreeServiceForTests,
} from "../server/routes/api/system-people-tree";
import { createStubSystemApiGuardPlugin } from "./guard-stubs";

// 守卫替身按插件名去重，同一文件内共用一个实例，避免 Elysia 静默丢弃后构造的那一份。
// 替身是放行的：本文件覆盖协议映射，鉴权合同归宿主装配用例（见 guard-stubs.ts 文件头）。
const apiSystemPeopleTreeRoutes = createApiSystemPeopleTreeRoutes({
  systemApiGuardPlugin: createStubSystemApiGuardPlugin(),
});

function request(path: string, init?: RequestInit) {
  return apiSystemPeopleTreeRoutes.handle(new Request(`http://localhost${path}`, init));
}

describe("API System People Tree", () => {
  afterEach(() => {
    setSystemPeopleTreeServiceForTests(null);
  });

  // 人员树返回组织、成员与智能体的嵌套关系，并保留无成员角色的历史 owner。
  test("返回组织到用户到智能体的层级关系", async () => {
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
              phoneNumber: "+8613800138000",
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

    const response = await request("/api/system/people-tree/");

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
                phoneNumber: "+8613800138000",
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
