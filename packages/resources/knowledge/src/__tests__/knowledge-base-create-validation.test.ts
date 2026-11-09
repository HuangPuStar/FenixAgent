import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { type KnowledgeBaseRow, knowledgeBaseRepo } from "../server/repositories/knowledge-base";
import { createWebKnowledgeBaseRoutes } from "../server/routes/web/knowledge-bases";
import { RagFlowKnowledgeProvider } from "../server/services/knowledge-provider/ragflow";
import { setKnowledgeProviderForTesting } from "../server/services/knowledge-provider/registry";
import { initializeKnowledgeModuleConfig } from "../server/testing";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";

const originalFetch = globalThis.fetch;
const originalFind = knowledgeBaseRepo.findByOrgAndSlug;
const originalCreate = knowledgeBaseRepo.create;
const rows: KnowledgeBaseRow[] = [];
const app = createWebKnowledgeBaseRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin({ organizationId: "org-1", userId: "user-1" }),
});

/** 只替换持久化边界，创建编排及 provider 保留真实实现。 */
function row(overrides: Partial<KnowledgeBaseRow>): KnowledgeBaseRow {
  return {
    id: "kb-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "Knowledge",
    slug: "knowledge",
    description: null,
    provider: "ragflow",
    remoteId: "dataset-1",
    remoteAccountId: "user-1",
    remoteUserId: "user-1",
    metadata: null,
    status: "empty",
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** 经过真实路由、Facade、领域服务和 RAGFlow 适配器创建知识库。 */
function create(embeddingModel?: string) {
  return app.handle(
    new Request("http://localhost/knowledgeBases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Knowledge",
        slug: "knowledge",
        embeddingModel,
        parseMethod: "builtin",
        chunkMethod: "naive",
      }),
    }),
  );
}

beforeEach(() => {
  initializeKnowledgeModuleConfig({ ragflowApiUrl: "http://ragflow.test", ragflowApiKey: "test-key" });
  setKnowledgeProviderForTesting(new RagFlowKnowledgeProvider());
  rows.length = 0;
  knowledgeBaseRepo.findByOrgAndSlug = async () => null;
  knowledgeBaseRepo.create = async (input) => {
    const created = row(input);
    rows.push(created);
    return created;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  knowledgeBaseRepo.findByOrgAndSlug = originalFind;
  knowledgeBaseRepo.create = originalCreate;
  setKnowledgeProviderForTesting(null);
  resetAllStubs();
});

describe("知识库创建的向量模型校验", () => {
  // 错误格式属于调用方参数错误，不能发远端请求或留下本地记录。
  test.each(["bad-format", "text-embedding-v2"])("非法向量模型 %s 返回 400", async (embeddingModel) => {
    const fetchSpy = mock(async () => Response.json({ code: 0, data: { id: "dataset-1" } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const response = await create(embeddingModel);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR", message: expect.stringContaining("嵌入模型格式错误") },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  // 合法模型和省略模型的语义保持不变，包括既有可用的两段式标识。
  test.each([
    undefined,
    "embed@instance@provider",
    "embed@provider",
  ])("合法向量模型 %s 保持创建及组织归属", async (embeddingModel) => {
    let remoteBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      remoteBody = JSON.parse(String(init?.body));
      return Response.json({ code: 0, data: { id: "dataset-1" } });
    }) as unknown as typeof fetch;
    const response = await create(embeddingModel);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { id: "kb-1", organizationId: "org-1" } });
    expect(remoteBody.embedding_model).toBe(embeddingModel);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: "org-1", userId: "user-1", remoteId: "dataset-1" });
  });

  // 真实上游故障不能被笼统转换为输入错误，上游 HTTP 400 也不等于本地格式校验失败。
  test.each([400, 503])("上游 HTTP %s 保留 502 分类且不写本地记录", async (status) => {
    globalThis.fetch = (async () =>
      Response.json({ code: 100, message: "upstream failure" }, { status })) as typeof fetch;
    const response = await create("embed@instance@provider");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "KNOWLEDGE_PROVIDER_ERROR" } });
    expect(rows).toEqual([]);
  });
});
