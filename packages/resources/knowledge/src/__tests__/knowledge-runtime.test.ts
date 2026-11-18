import { beforeEach, describe, expect, test } from "bun:test";
import { stubDb } from "@fenix/platform-sdk/testing";
import {
  getKnowledgeGraphForAgent,
  resolveBoundKnowledgeBasesByConfigId,
  searchKnowledgeDetailedForAgent,
} from "../server/services/knowledge-runtime";
import { initializeKnowledgeModuleConfig } from "../server/testing";

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
    // 运行时检索经仓储读绑定，仓储句柄来自 platform-sdk 基础设施（未初始化即抛错）；
    // 这里初始化转发到 `stubDb()` 的 DB 代理，用例内再按需替换替身。
    initializeKnowledgeModuleConfig();
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

    await expect(resolveBoundKnowledgeBasesByConfigId("agent-1")).resolves.toEqual([
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

  // 绑定表即授权来源：跨组织运行共享 Agent 时知识库归属与调用方组织不同，也必须按优先级解析出来。
  test("绑定即授权，不按调用方组织过滤", async () => {
    stubDb(
      createJoinedBindingsQuery(
        ["org-provider", "org-caller", null].map((organizationId, index) => ({
          kbId: `kb-${index}`,
          kbRemoteId: `remote-${index}`,
          kbUserId: "owner-1",
          kbOrganizationId: organizationId,
          priority: index,
        })),
      ),
    );

    const result = await resolveBoundKnowledgeBasesByConfigId("agent-1");

    expect(result.map((item) => item.id)).toEqual(["kb-0", "kb-1", "kb-2"]);
  });

  test("trusted-delegate 在同组织绑定下正常解析", async () => {
    initializeKnowledgeModuleConfig({ runtimeAuthMode: "trusted-delegate" });
    stubDb(
      createJoinedBindingsQuery([
        {
          kbId: "kb-1",
          kbRemoteId: "remote-1",
          kbUserId: "owner-1",
          kbOrganizationId: "org-1",
          priority: 0,
        },
      ]),
    );

    await expect(
      resolveBoundKnowledgeBasesByConfigId("agent-1", { userId: "user-1", organizationId: "org-1" }),
    ).resolves.toMatchObject([{ id: "kb-1", organizationId: "org-1" }]);
  });

  // 委派模式不能将库的归属组织作为授权判据。
  test("trusted-delegate 允许跨组织与缺少组织的绑定", async () => {
    initializeKnowledgeModuleConfig({ runtimeAuthMode: "trusted-delegate" });
    stubDb(
      createJoinedBindingsQuery([
        { kbId: "kb-cross", kbRemoteId: "remote-1", kbUserId: "owner-1", kbOrganizationId: "org-other", priority: 0 },
        { kbId: "kb-no-org", kbRemoteId: "remote-2", kbUserId: "owner-1", kbOrganizationId: null, priority: 1 },
      ]),
    );
    const result = await resolveBoundKnowledgeBasesByConfigId("agent-1", { userId: "user-1", organizationId: "org-1" });
    expect(result.map((item) => item.id)).toEqual(["kb-cross", "kb-no-org"]);
  });

  test("图谱请求选择未绑定知识库时返回稳定授权错误", async () => {
    stubDb(
      createJoinedBindingsQuery([
        {
          kbId: "kb-bound",
          kbRemoteId: "remote-bound",
          kbUserId: "owner-1",
          kbOrganizationId: "org-1",
          priority: 0,
        },
      ]),
    );

    await expect(
      getKnowledgeGraphForAgent({ agentConfigId: "agent-1", knowledgeBaseId: "kb-not-bound" }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_BINDING_REQUIRED" });
  });

  // 显式选择未绑定的知识库必须拒绝，未选择时仍表示没有图谱。
  test("没有绑定时区分显式选择和默认图谱查询", async () => {
    stubDb(createJoinedBindingsQuery([]));
    await expect(
      getKnowledgeGraphForAgent({ agentConfigId: "agent-1", knowledgeBaseId: "kb-not-bound" }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_BINDING_REQUIRED" });
    await expect(getKnowledgeGraphForAgent({ agentConfigId: "agent-1" })).resolves.toBeNull();
  });

  // 已绑定但无法定位远端时不能误报为未绑定，也不能推断具体原因。
  test("已绑定知识库缺少远端定位时返回不可用错误", async () => {
    stubDb(createJoinedBindingsQuery([{ kbId: "kb-1", kbRemoteId: null, kbOrganizationId: "org-1" }]));
    await expect(
      getKnowledgeGraphForAgent({ agentConfigId: "agent-1", knowledgeBaseId: "kb-1" }),
    ).rejects.toMatchObject({
      code: "KNOWLEDGE_BASE_UNAVAILABLE",
    });
    await expect(getKnowledgeGraphForAgent({ agentConfigId: "agent-1" })).resolves.toBeNull();
  });

  // 运行身份无效时不能借远端状态探测知识库。
  test("运行身份校验先于知识库可用性判断", async () => {
    initializeKnowledgeModuleConfig({ runtimeAuthMode: "trusted-delegate" });
    stubDb(createJoinedBindingsQuery([{ kbId: "kb-1", kbRemoteId: null, kbOrganizationId: "org-other" }]));
    await expect(
      getKnowledgeGraphForAgent({ agentConfigId: "agent-1", knowledgeBaseId: "kb-1", organizationId: "org-1" }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_RUNTIME_IDENTITY_REQUIRED" });
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
