import { describe, expect, test } from "bun:test";
import { createModelGatewaySubjectService } from "../services/model-gateway/subject-service";

describe("model gateway subject service", () => {
  // 验证用户候选查询保留关键字和组织条件，Agent 查询保留组织和属主筛选条件。
  test("用户和 Agent 查询均保留各自的主体筛选维度", async () => {
    const service = createModelGatewaySubjectService({
      findUsers: async () => [],
      listAgents: async (input) => [
        {
          id: "agent-1",
          name: input.keyword ?? "agent",
          organizationId: input.organizationId ?? "org-1",
          userId: input.userId ?? "user-1",
        },
      ],
    });

    const users = await service.searchUsers({ page: 1, pageSize: 20 });
    const agents = await service.searchAgents({
      page: 1,
      pageSize: 20,
      keyword: "demo",
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(users.total).toBe(0);
    expect(agents).toEqual([
      {
        id: "agent-1",
        name: "demo",
        organizationId: "org-1",
        userId: "user-1",
      },
    ]);
  });
});
