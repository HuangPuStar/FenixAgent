// AOS-BUG-003 的服务端口径：远端解析任务结束（run=DONE）但零分块的文档，同步与持久化都必须是
// `empty`（无可用内容），不得落成 `ready`。
//
// 现场证据是 status=ready、runStatus=DONE、parseProgress=1、chunkCount=0，而 RAGFlow 侧只留下
// `No chunk built from <file>`——文档实际检索不到任何内容，界面却显示「就绪」。本文件同时钉住反向用例
// （有分块的 DONE 文档仍为 ready），避免修复把正常文档一起降级。
//
// 走真实 `RagFlowKnowledgeProvider` + fetch 桩而不是替身 provider：被验证的正是「远端返回 → 状态映射 →
// 落库 → DTO」这条链，替身 provider 会把中间最关键的一步换掉。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import {
  type KnowledgeBaseRow,
  type KnowledgeResourceRow,
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "../server/repositories/knowledge-base";
import {
  refreshKnowledgeResourceStatus,
  setKnowledgeUploadProviderForTesting,
} from "../server/services/knowledge-upload";
import { initializeKnowledgeModuleConfig } from "../server/testing";

const NOW = new Date("2026-08-19T00:00:00.000Z");
const CREDENTIAL = async () => "test-ragflow-key";

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
    status: "indexing",
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
    sourceType: "upload",
    sourceName: "demo-truncated.pdf",
    sourcePath: "/tmp/demo-truncated.pdf",
    remoteId: "remote-resource-1",
    status: "processing",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 远端 documents 列表桩：只回一份文档，字段保持 RAGFlow 原样命名。 */
function stubRemoteDocuments(doc: Record<string, unknown>): void {
  globalThis.fetch = mock(async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    text: async () => JSON.stringify({ code: 0, data: { total: 1, docs: [doc] } }),
  })) as unknown as typeof fetch;
}

/**
 * 内存资源存储：把仓储读写接到给定行数组上，并记录知识库状态更新。
 *
 * `getStatusSummary` 按行状态现算（而不是回常量），否则「零分块不宣告知识库就绪」这条断言会空转。
 */
function installResourceStore(rows: KnowledgeResourceRow[]) {
  const knowledgeBaseUpdates: Array<Partial<KnowledgeBaseRow>> = [];
  knowledgeBaseRepo.update = mock(async (_id: string, patch: Partial<KnowledgeBaseRow>) => {
    knowledgeBaseUpdates.push(patch);
  }) as unknown as typeof knowledgeBaseRepo.update;
  knowledgeResourceRepo.update = mock(async (resourceId: string, patch: Partial<KnowledgeResourceRow>) => {
    const row = rows.find((item) => item.id === resourceId);
    if (row) Object.assign(row, patch);
  }) as unknown as typeof knowledgeResourceRepo.update;
  knowledgeResourceRepo.listByKnowledgeBase = mock(async (knowledgeBaseId: string) =>
    rows.filter((item) => item.knowledgeBaseId === knowledgeBaseId),
  ) as unknown as typeof knowledgeResourceRepo.listByKnowledgeBase;
  knowledgeResourceRepo.getStatusSummary = mock(async () => ({
    readyCount: rows.filter((item) => item.status === "ready").length,
    activeCount: rows.filter((item) => item.status === "pending" || item.status === "processing").length,
    errorCount: rows.filter((item) => item.status === "error").length,
    totalCount: rows.length,
  })) as unknown as typeof knowledgeResourceRepo.getStatusSummary;
  return knowledgeBaseUpdates;
}

const originalFetch = globalThis.fetch;
const originals = {
  updateBase: knowledgeBaseRepo.update,
  updateResource: knowledgeResourceRepo.update,
  listResources: knowledgeResourceRepo.listByKnowledgeBase,
  getSummary: knowledgeResourceRepo.getStatusSummary,
};

describe("零分块文档的资源状态口径", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
    initializeKnowledgeModuleConfig({ ragflowApiKey: "test-ragflow-key" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    knowledgeBaseRepo.update = originals.updateBase;
    knowledgeResourceRepo.update = originals.updateResource;
    knowledgeResourceRepo.listByKnowledgeBase = originals.listResources;
    knowledgeResourceRepo.getStatusSummary = originals.getSummary;
    setKnowledgeUploadProviderForTesting(null);
    resetAllStubs();
  });

  // 解析结束但零分块：资源不得用于检索，因此既不能落成 ready，也不能让知识库宣告就绪。
  test("解析完成且零分块的资源落库为 empty 而不是 ready", async () => {
    const rows = [resource()];
    const knowledgeBaseUpdates = installResourceStore(rows);
    stubRemoteDocuments({
      id: "remote-resource-1",
      name: "demo-truncated.pdf",
      run: "DONE",
      chunk_count: 0,
      progress: 1,
      progress_msg: "No chunk built from demo-truncated.pdf",
    });

    const result = await refreshKnowledgeResourceStatus(knowledgeBase(), CREDENTIAL);

    expect(result).toEqual([expect.objectContaining({ status: "empty", chunkCount: 0, runStatus: "DONE" })]);
    expect(rows[0]?.status).toBe("empty");
    expect(knowledgeBaseUpdates.at(-1)?.status).toBe("empty");
  });

  // 反向用例：正常解析出分块的文档语义不变，仍是可检索的 ready（修复不得误伤正常文件）。
  test("解析完成且有分块的资源仍为 ready", async () => {
    const rows = [resource({ sourceName: "sample.pdf" })];
    const knowledgeBaseUpdates = installResourceStore(rows);
    stubRemoteDocuments({ id: "remote-resource-1", name: "sample.pdf", run: "DONE", chunk_count: 1, progress: 1 });

    const result = await refreshKnowledgeResourceStatus(knowledgeBase(), CREDENTIAL);

    expect(result).toEqual([expect.objectContaining({ status: "ready", chunkCount: 1 })]);
    expect(rows[0]?.status).toBe("ready");
    expect(knowledgeBaseUpdates.at(-1)?.status).toBe("ready");
  });
});
