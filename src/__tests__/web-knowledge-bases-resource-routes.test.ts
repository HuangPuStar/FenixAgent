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
    id: "kb-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "产品文档",
    slug: "product-docs",
    description: null,
    provider: "ragflow",
    remoteId: "remote-kb-1",
    remoteAccountId: "account-1",
    remoteUserId: "remote-user-1",
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
    sourceType: "upload",
    sourceName: "guide.pdf",
    sourcePath: null,
    remoteId: "remote-resource-1",
    status: "ready",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function request(path: string, init?: RequestInit) {
  return webKnowledgeBasesRoute.handle(new Request(`http://localhost${path}`, init));
}

function authenticate(organizationId = "org-1") {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.com", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
}

class RouteProvider extends RagFlowKnowledgeProvider {
  chunkInput: Parameters<RagFlowKnowledgeProvider["listChunks"]>[0] | null = null;
  switchInput: Parameters<RagFlowKnowledgeProvider["switchChunk"]>[0] | null = null;
  reparseInput: Parameters<RagFlowKnowledgeProvider["reparseResource"]>[0] | null = null;
  enabledInput: Parameters<RagFlowKnowledgeProvider["setResourceEnabled"]>[0] | null = null;

  override async listChunks(input: Parameters<RagFlowKnowledgeProvider["listChunks"]>[0]) {
    this.chunkInput = input;
    return { items: [], total: 0, page: input.page, pageSize: input.pageSize };
  }

  override async switchChunk(input: Parameters<RagFlowKnowledgeProvider["switchChunk"]>[0]) {
    this.switchInput = input;
  }

  override async reparseResource(input: Parameters<RagFlowKnowledgeProvider["reparseResource"]>[0]) {
    this.reparseInput = input;
  }

  override async setResourceEnabled(input: Parameters<RagFlowKnowledgeProvider["setResourceEnabled"]>[0]) {
    this.enabledInput = input;
  }
}

const originals = {
  getBase: knowledgeBaseRepo.getById,
  getResource: knowledgeResourceRepo.getById,
  updateResource: knowledgeResourceRepo.update,
};

describe("知识库 Web 路由资源分支", () => {
  beforeEach(() => {
    resetAllStubs();
    authenticate();
    setConfig({ ragflowApiKey: "test-ragflow-key" });
  });

  afterEach(() => {
    knowledgeBaseRepo.getById = originals.getBase;
    knowledgeResourceRepo.getById = originals.getResource;
    knowledgeResourceRepo.update = originals.updateResource;
    setKnowledgeProviderForTesting(null);
    resetConfig();
    resetTestAuth();
    resetAllStubs();
  });

  // URL 导入缺少必填地址时应由请求 schema 在调用服务前拒绝。
  test("POST URL 资源导入拒绝缺失地址", async () => {
    const response = await request("/knowledgeBases/kb-1/resources/url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(422);
  });

  // 上传资源路由应把跨组织知识库隐藏为不存在。
  test("POST 上传资源将跨组织知识库映射为 404", async () => {
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ organizationId: "org-foreign" }));
    const body = new FormData();
    body.append("files", new File(["content"], "guide.md", { type: "text/markdown" }));

    const response = await request("/knowledgeBases/kb-1/resources/upload", { method: "POST", body });

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 文件预览不得接受属于其他知识库的资源 ID。
  test("GET 文件预览拒绝资源与知识库不匹配", async () => {
    knowledgeResourceRepo.getById = mock(async () => resource({ knowledgeBaseId: "kb-other" }));

    const response = await request("/knowledgeBases/kb-1/resources/resource-1/file");

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // PDF 转换接口应拒绝 URL 类型资源，避免触发本地文件或转换进程。
  test("GET PDF 转换拒绝没有本地文件的资源", async () => {
    knowledgeResourceRepo.getById = mock(async () => resource({ sourceType: "url", sourcePath: null }));

    const response = await request("/knowledgeBases/kb-1/resources/resource-1/pdf");

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NO_LOCAL_FILE" } });
  });

  // 资源启用状态切换应保留字符串 true 的兼容输入并转发远端身份。
  test("PATCH 资源启用状态转发兼容布尔值", async () => {
    const provider = new RouteProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    const response = await request("/knowledgeBases/kb-1/resources/resource-1/enabled", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "true" }),
    });

    expect(response.status).toBe(200);
    expect(provider.enabledInput).toMatchObject({
      enabled: true,
      remoteAccountId: "account-1",
      remoteUserId: "remote-user-1",
    });
  });

  // 资源切换前必须验证当前组织拥有知识库，不能仅凭资源归属授权。
  test("PATCH 资源启用状态拒绝跨组织知识库", async () => {
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ organizationId: "org-foreign" }));

    const response = await request("/knowledgeBases/kb-1/resources/resource-1/enabled", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 未同步远端 ID 的资源不可触发重新解析。
  test("POST 重新解析拒绝未同步资源", async () => {
    knowledgeResourceRepo.getById = mock(async () => resource({ remoteId: null }));
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    const response = await request("/knowledgeBases/kb-1/resources/resource-1/reparse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: true }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NOT_SYNCED" } });
  });

  // 重新解析成功后必须标记本地资源为 processing，供前端轮询。
  test("POST 重新解析更新本地处理状态", async () => {
    const provider = new RouteProvider();
    const update = mock(async () => undefined);
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeResourceRepo.update = update;
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    const response = await request("/knowledgeBases/kb-1/resources/resource-1/reparse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: true }),
    });

    expect(response.status).toBe(200);
    expect(provider.reparseInput).toMatchObject({ deleteOld: true, resourceRemoteId: "remote-resource-1" });
    expect(update).toHaveBeenCalledWith("resource-1", expect.objectContaining({ status: "processing" }));
  });

  // 切片列表应钳制非法分页参数，并去除空白关键词后再调用 provider。
  test("GET 切片列表标准化分页和关键词", async () => {
    const provider = new RouteProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    const response = await request(
      "/knowledgeBases/kb-1/resources/resource-1/chunks?page=0&pageSize=999&keyword=%20%20",
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: { items: [], total: 0, page: 1, pageSize: 100 },
    });
    expect(provider.chunkInput).toMatchObject({ page: 1, pageSize: 100, keyword: undefined });
  });

  // 未同步的资源查询切片时应返回稳定空分页 DTO，不调用 provider。
  test("GET 切片列表为未同步资源返回空分页 DTO", async () => {
    const provider = new RouteProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource({ remoteId: null }));
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    const response = await request("/knowledgeBases/kb-1/resources/resource-1/chunks?page=2&pageSize=5");

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: { items: [], total: 0, page: 2, pageSize: 5 },
    });
    expect(provider.chunkInput).toBeNull();
  });

  // 切片开关不得对未关联远端文档的资源发起 provider 调用。
  test("PATCH 切片开关拒绝未同步资源", async () => {
    knowledgeResourceRepo.getById = mock(async () => resource({ remoteId: null }));
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    const response = await request("/knowledgeBases/kb-1/resources/resource-1/chunks/chunk-1/enabled", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NO_REMOTE" } });
  });

  // 切片开关成功时应将请求值映射为 provider 的 available 字段。
  test("PATCH 切片开关转发 enabled 状态", async () => {
    const provider = new RouteProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    const response = await request("/knowledgeBases/kb-1/resources/resource-1/chunks/chunk-1/enabled", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ success: true, data: { enabled: false } });
    expect(provider.switchInput).toMatchObject({ chunkId: "chunk-1", available: false });
  });
});
