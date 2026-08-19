import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import {
  type KnowledgeBaseRow,
  type KnowledgeResourceRow,
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "../repositories/knowledge-base";
import { RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";
import {
  deleteKnowledgeResource,
  refreshKnowledgeResourceStatus,
  setKnowledgeUploadProviderForTesting,
} from "../services/knowledge-upload";
import { resetAllStubs } from "../test-utils/helpers";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function knowledgeBase(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb-1",
    userId: "owner-1",
    organizationId: "org-1",
    name: "产品文档",
    slug: "product-docs",
    description: null,
    provider: "ragflow",
    remoteId: "remote-kb-1",
    remoteAccountId: null,
    remoteUserId: null,
    metadata: null,
    status: "ready",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resource(overrides: Partial<KnowledgeResourceRow> = {}): KnowledgeResourceRow {
  return {
    id: "resource-1",
    knowledgeBaseId: "kb-1",
    sourceType: "url",
    sourceName: "guide",
    sourcePath: "https://example.test/guide",
    remoteId: "remote-resource-1",
    status: "ready",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class UploadProvider extends RagFlowKnowledgeProvider {
  override async listResources() {
    throw new Error("provider unavailable");
  }
}

const originals = {
  getBase: knowledgeBaseRepo.getById,
  getResource: knowledgeResourceRepo.getById,
  deleteResource: knowledgeResourceRepo.delete,
  listResources: knowledgeResourceRepo.listByKnowledgeBase,
};

describe("知识资源上传服务分支", () => {
  beforeEach(() => {
    resetAllStubs();
    setConfig({ ragflowApiKey: "test-ragflow-key" });
  });

  afterEach(() => {
    knowledgeBaseRepo.getById = originals.getBase;
    knowledgeResourceRepo.getById = originals.getResource;
    knowledgeResourceRepo.delete = originals.deleteResource;
    knowledgeResourceRepo.listByKnowledgeBase = originals.listResources;
    setKnowledgeUploadProviderForTesting(null);
    resetConfig();
    resetAllStubs();
  });

  // 删除资源时跨组织知识库必须隐藏为不存在。
  test("删除资源拒绝跨组织知识库", async () => {
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ organizationId: "org-foreign" }));

    await expect(deleteKnowledgeResource("org-1", "kb-1", "resource-1", "user-1")).resolves.toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "知识库不存在" },
    });
  });

  // 删除资源时资源与知识库不匹配不得调用远端删除。
  test("删除资源拒绝不属于知识库的记录", async () => {
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    knowledgeResourceRepo.getById = mock(async () => resource({ knowledgeBaseId: "kb-other" }));

    await expect(deleteKnowledgeResource("org-1", "kb-1", "resource-1", "user-1")).resolves.toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "资源不存在" },
    });
  });

  // 没有远端数据集时刷新资源状态应返回空数组，避免请求 provider。
  test("刷新未同步知识库资源返回空列表", async () => {
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ remoteId: null }));

    await expect(refreshKnowledgeResourceStatus("org-1", "kb-1", "user-1")).resolves.toEqual([]);
  });

  // provider 同步失败时应降级返回本地缓存并规范化资源 DTO。
  test("刷新资源在 provider 异常时返回本地缓存 DTO", async () => {
    const provider = new UploadProvider();
    setKnowledgeUploadProviderForTesting(provider);
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    knowledgeResourceRepo.listByKnowledgeBase = mock(async () => [resource({ sourcePath: null, remoteId: null })]);

    await expect(refreshKnowledgeResourceStatus("org-1", "kb-1", "user-1")).resolves.toEqual([
      {
        id: "resource-1",
        knowledgeBaseId: "kb-1",
        sourceName: "guide",
        sourceType: "url",
        sourcePath: null,
        remoteId: null,
        status: "ready",
        lastError: null,
        createdAt: 1787097600,
        updatedAt: 1787097600,
      },
    ]);
  });
});
