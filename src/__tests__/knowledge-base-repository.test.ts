import { beforeEach, describe, expect, mock, test } from "bun:test";
import { agentKnowledgeBindingRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

describe("知识库仓储边界行为", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 同步任务没有远端资源 ID 时必须短路，避免生成无意义的 SQL 更新或查询。
  test("远端资源 ID 为空时跳过批量更新和查找", async () => {
    const update = mock(() => {
      throw new Error("不应访问数据库");
    });
    const select = mock(() => {
      throw new Error("不应访问数据库");
    });
    stubDb({ select, update });

    await knowledgeResourceRepo.updateByRemoteIds([], { status: "ready" });
    await expect(knowledgeResourceRepo.findByRemoteIds([])).resolves.toEqual([]);

    expect(update).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  // 资源状态聚合没有匹配行时应返回完整零值，调用方无需处理 undefined。
  test("资源状态聚合缺失统计行时返回完整零值", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    });

    await expect(knowledgeResourceRepo.getStatusSummary("kb-1")).resolves.toEqual({
      readyCount: 0,
      activeCount: 0,
      errorCount: 0,
      totalCount: 0,
    });
  });

  // 批量绑定计数应保留每个请求知识库的零值，并正确累加重复绑定行。
  test("批量绑定计数覆盖未绑定知识库并累加已有绑定", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve([{ knowledgeBaseId: "kb-1" }, { knowledgeBaseId: "kb-1" }, { knowledgeBaseId: "kb-2" }]),
        }),
      }),
    });

    await expect(agentKnowledgeBindingRepo.countByKnowledgeBaseIds(["kb-1", "kb-2", "kb-3"])).resolves.toEqual({
      "kb-1": 2,
      "kb-2": 1,
      "kb-3": 0,
    });
  });

  // 空绑定集合应直接返回空计数，避免向数据库发送空 inArray 查询。
  test("空知识库集合不查询数据库并返回空计数", async () => {
    const select = mock(() => {
      throw new Error("不应访问数据库");
    });
    stubDb({ select });

    await expect(agentKnowledgeBindingRepo.countByKnowledgeBaseIds([])).resolves.toEqual({});

    expect(select).not.toHaveBeenCalled();
  });
});
