import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import { agentKnowledgeBindingRepo, knowledgeBaseRepo, knowledgeResourceRepo } from "../repositories/knowledge-base";
import { RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";
import {
  deleteKnowledgeGraphForKb,
  generateKnowledgeGraphForKb,
  getKnowledgeGraphForKb,
  pollKnowledgeGraphProgressForKb,
  searchKnowledgeDetailedForAgent,
  searchKnowledgeForTest,
  setKnowledgeRuntimeProviderForTesting,
} from "../services/knowledge-runtime";
import { resetAllStubs } from "../test-utils/helpers";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function knowledgeBase(remoteId: string | null = "remote-kb-1") {
  return {
    id: "kb-1",
    userId: "owner-1",
    organizationId: "org-1",
    name: "产品文档",
    slug: "product-docs",
    description: null,
    provider: "ragflow",
    remoteId,
    remoteAccountId: " account-1 ",
    remoteUserId: " user-1 ",
    metadata: null,
    status: "ready" as const,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class RuntimeProvider extends RagFlowKnowledgeProvider {
  searchInputs: Parameters<RagFlowKnowledgeProvider["search"]>[0][] = [];
  detailedInput: Parameters<RagFlowKnowledgeProvider["searchDetailed"]>[0] | null = null;
  graphInput: Record<string, unknown> | null = null;
  failFirstSearch = false;

  override async search(input: Parameters<RagFlowKnowledgeProvider["search"]>[0]) {
    this.searchInputs.push(input);
    if (this.failFirstSearch && this.searchInputs.length === 1) throw new Error("provider unavailable");
    return [
      {
        title: "命中文档",
        snippet: "内容",
        source: "guide.md",
        score: 0.9,
        knowledgeBaseId: input.knowledgeBases[0]!.remoteId,
        resourceId: "remote-resource-1",
      },
    ];
  }

  override async searchDetailed(input: Parameters<RagFlowKnowledgeProvider["searchDetailed"]>[0]) {
    this.detailedInput = input;
    return { chunks: [], total: 0, docAggs: [] };
  }

  override async generateKnowledgeGraph(input: Parameters<RagFlowKnowledgeProvider["generateKnowledgeGraph"]>[0]) {
    this.graphInput = input;
  }

  override async getKnowledgeGraph(input: Parameters<RagFlowKnowledgeProvider["getKnowledgeGraph"]>[0]) {
    this.graphInput = input;
    return { graph: { nodes: [], edges: [] } };
  }

  override async deleteKnowledgeGraph(input: Parameters<RagFlowKnowledgeProvider["deleteKnowledgeGraph"]>[0]) {
    this.graphInput = input;
  }

  override async pollKnowledgeGraphProgress(
    input: Parameters<RagFlowKnowledgeProvider["pollKnowledgeGraphProgress"]>[0],
  ) {
    this.graphInput = input;
    return { progress: 0.5, progressMsg: "处理中", taskId: "task-1" };
  }
}

const originals = {
  getBase: knowledgeBaseRepo.getById,
  joinedBindings: agentKnowledgeBindingRepo.listJoinedWithKnowledgeBaseByConfigId,
  findResources: knowledgeResourceRepo.findByRemoteIds,
};

describe("知识运行时服务分支", () => {
  beforeEach(() => {
    resetAllStubs();
    setConfig({ ragflowApiKey: "test-ragflow-key" });
  });

  afterEach(() => {
    knowledgeBaseRepo.getById = originals.getBase;
    agentKnowledgeBindingRepo.listJoinedWithKnowledgeBaseByConfigId = originals.joinedBindings;
    knowledgeResourceRepo.findByRemoteIds = originals.findResources;
    setKnowledgeRuntimeProviderForTesting(null);
    resetConfig();
    resetAllStubs();
  });

  // 多模型绑定必须按 embedding model 拆分请求，并把远端资源 ID 映射为本地资源 ID。
  test("按嵌入模型分组检索并映射本地 DTO", async () => {
    const provider = new RuntimeProvider();
    setKnowledgeRuntimeProviderForTesting(provider);
    agentKnowledgeBindingRepo.listJoinedWithKnowledgeBaseByConfigId = mock(async () => [
      {
        id: "binding-1",
        agentConfigId: "agent-1",
        knowledgeBaseId: "kb-1",
        config: null,
        priority: 1,
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
        kbId: "kb-1",
        kbName: "文档一",
        kbRemoteId: "remote-kb-1",
        kbRemoteAccountId: "account-1",
        kbRemoteUserId: "user-1",
        kbUserId: "owner-1",
        kbOrganizationId: "org-1",
        kbEmbeddingModel: "model-a",
      },
      {
        id: "binding-2",
        agentConfigId: "agent-1",
        knowledgeBaseId: "kb-2",
        config: null,
        priority: 2,
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
        kbId: "kb-2",
        kbName: "文档二",
        kbRemoteId: "remote-kb-2",
        kbRemoteAccountId: null,
        kbRemoteUserId: null,
        kbUserId: "owner-1",
        kbOrganizationId: "org-1",
        kbEmbeddingModel: "model-b",
      },
    ]);
    knowledgeResourceRepo.findByRemoteIds = mock(async () => [
      { id: "resource-local-1", remoteId: "remote-resource-1" },
    ]);

    const result = await searchKnowledgeDetailedForAgent({ agentConfigId: "agent-1", query: "部署", topK: 3 });

    expect(provider.searchInputs).toHaveLength(2);
    expect(result).toEqual([
      {
        title: "命中文档",
        snippet: "内容",
        source: "guide.md",
        score: 0.9,
        knowledgeBaseId: "kb-1",
        resourceId: "resource-local-1",
        kbName: "文档一",
      },
      {
        title: "命中文档",
        snippet: "内容",
        source: "guide.md",
        score: 0.9,
        knowledgeBaseId: "kb-2",
        resourceId: "resource-local-1",
        kbName: "文档二",
      },
    ]);
  });

  // 某个模型组 provider 异常时应跳过该组，保留其他组的检索结果。
  test("检索 provider 部分异常时继续处理其他模型组", async () => {
    const provider = new RuntimeProvider();
    provider.failFirstSearch = true;
    setKnowledgeRuntimeProviderForTesting(provider);
    agentKnowledgeBindingRepo.listJoinedWithKnowledgeBaseByConfigId = mock(async () => [
      {
        id: "b-1",
        agentConfigId: "agent-1",
        knowledgeBaseId: "kb-1",
        config: null,
        priority: 1,
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
        kbId: "kb-1",
        kbName: "一",
        kbRemoteId: "remote-1",
        kbRemoteAccountId: null,
        kbRemoteUserId: null,
        kbUserId: "owner-1",
        kbOrganizationId: "org-1",
        kbEmbeddingModel: "a",
      },
      {
        id: "b-2",
        agentConfigId: "agent-1",
        knowledgeBaseId: "kb-2",
        config: null,
        priority: 2,
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
        kbId: "kb-2",
        kbName: "二",
        kbRemoteId: "remote-2",
        kbRemoteAccountId: null,
        kbRemoteUserId: null,
        kbUserId: "owner-1",
        kbOrganizationId: "org-1",
        kbEmbeddingModel: "b",
      },
    ]);
    knowledgeResourceRepo.findByRemoteIds = mock(async () => []);

    await expect(
      searchKnowledgeDetailedForAgent({ agentConfigId: "agent-1", query: "部署", topK: 3 }),
    ).resolves.toEqual([
      {
        title: "命中文档",
        snippet: "内容",
        source: "guide.md",
        score: 0.9,
        knowledgeBaseId: "kb-2",
        resourceId: "remote-resource-1",
        kbName: "二",
      },
    ]);
  });

  // 详情页检索应完整透传分页和高级检索参数，并使用规范化远端租户身份。
  test("知识库检索测试透传分页和高级参数", async () => {
    const provider = new RuntimeProvider();
    setKnowledgeRuntimeProviderForTesting(provider);
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    await expect(
      searchKnowledgeForTest({
        organizationId: "org-1",
        knowledgeBaseId: "kb-1",
        userId: "user-1",
        query: "部署",
        topK: 5,
        page: 2,
        pageSize: 10,
        keyword: true,
        useKg: true,
        crossLanguages: ["en"],
      }),
    ).resolves.toEqual({ chunks: [], total: 0, docAggs: [] });

    expect(provider.detailedInput).toMatchObject({
      page: 2,
      pageSize: 10,
      keyword: true,
      useKg: true,
      crossLanguages: ["en"],
      knowledgeBases: [{ remoteId: "remote-kb-1", remoteAccountId: "account-1", remoteUserId: "user-1" }],
    });
  });

  // 缺失 remoteId 的知识库不得进入 provider 检索路径。
  test("知识库检索测试拒绝缺失远端 ID", async () => {
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase(null));

    await expect(
      searchKnowledgeForTest({ organizationId: "org-1", knowledgeBaseId: "kb-1", query: "部署", topK: 5 }),
    ).rejects.toThrow("Knowledge base remote id is missing");
  });

  // 图谱生成应复用知识库访问校验与规范化后的远端身份。
  test("生成知识图谱转发远端身份", async () => {
    const provider = new RuntimeProvider();
    setKnowledgeRuntimeProviderForTesting(provider);
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    await generateKnowledgeGraphForKb({ organizationId: "org-1", knowledgeBaseId: "kb-1", userId: "user-1" });

    expect(provider.graphInput).toMatchObject({
      knowledgeBaseRemoteId: "remote-kb-1",
      remoteAccountId: "account-1",
      remoteUserId: "user-1",
    });
  });

  // 图谱查询、删除和进度轮询应返回 provider 结果且复用同一访问边界。
  test("图谱读取删除与进度轮询复用访问校验", async () => {
    const provider = new RuntimeProvider();
    setKnowledgeRuntimeProviderForTesting(provider);
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    await expect(getKnowledgeGraphForKb({ organizationId: "org-1", knowledgeBaseId: "kb-1" })).resolves.toEqual({
      graph: { nodes: [], edges: [] },
    });
    await deleteKnowledgeGraphForKb({ organizationId: "org-1", knowledgeBaseId: "kb-1" });
    await expect(
      pollKnowledgeGraphProgressForKb({ organizationId: "org-1", knowledgeBaseId: "kb-1" }),
    ).resolves.toEqual({ progress: 0.5, progressMsg: "处理中", taskId: "task-1" });
  });
});
