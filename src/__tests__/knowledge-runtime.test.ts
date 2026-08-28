import { beforeEach, describe, expect, test } from "bun:test";
import { resolveBoundKnowledgeBasesByConfigId, searchKnowledgeDetailedForAgent } from "../services/knowledge-runtime";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

function createJoinedBindingsQuery(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(rows),
        }),
      }),
    }),
  };
}

describe("知识运行时绑定解析", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // Agent 读取绑定知识库时应过滤没有远端数据集的记录、按优先级排序并补齐远端身份回退值。
  test("按优先级解析可检索的绑定知识库并规范化远端字段", async () => {
    stubDb(
      createJoinedBindingsQuery([
        {
          id: "binding-later",
          agentConfigId: "agent-1",
          knowledgeBaseId: "kb-later",
          config: null,
          priority: 20,
          enabled: true,
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
          kbId: "kb-later",
          kbName: "后置知识库",
          kbRemoteId: "remote-later",
          kbRemoteAccountId: " account-1 ",
          kbRemoteUserId: " user-1 ",
          kbUserId: "owner-1",
          kbOrganizationId: "org-1",
          kbEmbeddingModel: " embedding-a ",
        },
        {
          id: "binding-first",
          agentConfigId: "agent-1",
          knowledgeBaseId: "kb-first",
          config: null,
          priority: 10,
          enabled: true,
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
          kbId: "kb-first",
          kbName: null,
          kbRemoteId: "remote-first",
          kbRemoteAccountId: "   ",
          kbRemoteUserId: null,
          kbUserId: "owner-2",
          kbOrganizationId: null,
          kbEmbeddingModel: " ",
        },
        {
          id: "binding-local-only",
          agentConfigId: "agent-1",
          knowledgeBaseId: "kb-local-only",
          config: null,
          priority: 1,
          enabled: true,
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-01-01"),
          kbId: "kb-local-only",
          kbName: "未同步知识库",
          kbRemoteId: null,
          kbRemoteAccountId: null,
          kbRemoteUserId: null,
          kbUserId: "owner-3",
          kbOrganizationId: "org-1",
          kbEmbeddingModel: null,
        },
      ]),
    );

    await expect(resolveBoundKnowledgeBasesByConfigId("agent-1", "other-org")).resolves.toEqual([
      {
        id: "kb-first",
        remoteId: "remote-first",
        remoteAccountId: "owner-2",
        remoteUserId: "owner-2",
        priority: 10,
        userId: "owner-2",
        organizationId: "owner-2",
        name: "未知知识库",
        embeddingModel: null,
      },
      {
        id: "kb-later",
        remoteId: "remote-later",
        remoteAccountId: "account-1",
        remoteUserId: "user-1",
        priority: 20,
        userId: "owner-1",
        organizationId: "org-1",
        name: "后置知识库",
        embeddingModel: "embedding-a",
      },
    ]);
  });

  // Agent 没有可检索的知识库绑定时必须直接返回空结果，避免访问密钥或上游 provider。
  test("没有可检索绑定时直接返回空结果", async () => {
    stubDb(createJoinedBindingsQuery([]));

    const result = await searchKnowledgeDetailedForAgent({
      agentConfigId: "agent-1",
      query: "如何部署？",
      topK: 3,
    });

    expect(result).toEqual([]);
  });
});
