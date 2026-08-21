import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import {
  type KnowledgeBaseRow,
  type KnowledgeResourceRow,
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "../repositories/knowledge-base";
import webKnowledgeBasesRoute from "../routes/web/knowledge-bases";
import { RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";
import { setKnowledgeProviderForTesting } from "../services/knowledge-provider/registry";
import { resetAllStubs } from "../test-utils/helpers";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function knowledgeBase(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb-imported",
    userId: "user-1",
    organizationId: "org-1",
    name: "远端产品文档",
    slug: "remote-product-docs",
    description: null,
    provider: "ragflow",
    remoteId: "remote-kb-1",
    remoteAccountId: "user-1",
    remoteUserId: "user-1",
    metadata: null,
    status: "empty",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resource(overrides: Partial<KnowledgeResourceRow> = {}): KnowledgeResourceRow {
  return {
    id: "resource-imported",
    knowledgeBaseId: "kb-imported",
    sourceType: "url",
    sourceName: "使用指南",
    sourcePath: "https://example.test/guide",
    remoteId: "remote-resource-1",
    status: "ready",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function request(path: string, body: Record<string, unknown>) {
  return webKnowledgeBasesRoute.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

class ImportProvider extends RagFlowKnowledgeProvider {
  override async getDataset() {
    return {
      id: "remote-kb-1",
      name: "远端产品文档",
      embeddingModel: "embed-v1",
      parseMethod: "pipeline",
      chunkMethod: "qa",
    };
  }

  override async listResources() {
    return [
      {
        remoteId: "remote-resource-1",
        sourceType: "url" as const,
        sourceName: "使用指南",
        source: "https://example.test/guide",
        status: "ready" as const,
      },
    ];
  }
}

const originals = {
  createBase: knowledgeBaseRepo.create,
  getBase: knowledgeBaseRepo.getById,
  listBases: knowledgeBaseRepo.listByOrganizationId,
  updateBase: knowledgeBaseRepo.update,
  countBindings: knowledgeBaseRepo.countBindings,
  createResource: knowledgeResourceRepo.create,
  getStatusSummary: knowledgeResourceRepo.getStatusSummary,
  listResources: knowledgeResourceRepo.listByKnowledgeBase,
  countResources: knowledgeResourceRepo.countByKnowledgeBase,
};

describe("知识库导入远端同步分支", () => {
  beforeEach(() => {
    resetAllStubs();
    setConfig({ ragflowApiKey: "test-ragflow-key" });
    setTestAuth({
      user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setKnowledgeProviderForTesting(new ImportProvider());
  });

  afterEach(() => {
    knowledgeBaseRepo.create = originals.createBase;
    knowledgeBaseRepo.getById = originals.getBase;
    knowledgeBaseRepo.listByOrganizationId = originals.listBases;
    knowledgeBaseRepo.update = originals.updateBase;
    knowledgeBaseRepo.countBindings = originals.countBindings;
    knowledgeResourceRepo.create = originals.createResource;
    knowledgeResourceRepo.getStatusSummary = originals.getStatusSummary;
    knowledgeResourceRepo.listByKnowledgeBase = originals.listResources;
    knowledgeResourceRepo.countByKnowledgeBase = originals.countResources;
    setKnowledgeProviderForTesting(null);
    resetConfig();
    resetTestAuth();
    resetAllStubs();
  });

  // 导入远端知识库时应同步远端配置、资源缓存和本地聚合详情。
  test("导入同步远端配置与资源", async () => {
    const imported = knowledgeBase();
    const importedResource = resource();
    const baseUpdates: Array<Record<string, unknown>> = [];
    const createResource = mock(async () => importedResource);

    knowledgeBaseRepo.listByOrganizationId = mock(async () => []);
    knowledgeBaseRepo.create = mock(async () => imported);
    knowledgeBaseRepo.getById = mock(async () => imported);
    knowledgeBaseRepo.update = mock(async (_id, data) => {
      baseUpdates.push(data);
    });
    knowledgeBaseRepo.countBindings = mock(async () => 0);
    knowledgeResourceRepo.create = createResource;
    knowledgeResourceRepo.getStatusSummary = mock(async () => ({
      readyCount: 1,
      activeCount: 0,
      errorCount: 0,
      totalCount: 1,
    }));
    knowledgeResourceRepo.listByKnowledgeBase = mock(async () => [importedResource]);
    knowledgeResourceRepo.countByKnowledgeBase = mock(async () => 1);

    const response = await request("/knowledgeBases", {
      action: "import",
      name: "远端产品文档",
      remoteId: "remote-kb-1",
    });

    expect(response.status).toBe(200);
    expect(createResource).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-imported",
        remoteId: "remote-resource-1",
        sourcePath: "https://example.test/guide",
      }),
    );
    expect(baseUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            embeddingModel: "embed-v1",
            parseMethod: "pipeline",
            chunkMethod: "qa",
          }),
        }),
      ]),
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: { id: "kb-imported", resourcesCount: 1, recentResources: [{ id: "resource-imported" }] },
    });
  });
});
