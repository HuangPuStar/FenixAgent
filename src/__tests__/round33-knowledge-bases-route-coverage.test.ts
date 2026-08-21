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
import { setKnowledgeRuntimeProviderForTesting } from "../services/knowledge-runtime";
import { setKnowledgeUploadProviderForTesting } from "../services/knowledge-upload";
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
    sourceName: "guide.md",
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

function jsonRequest(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authenticate(organizationId = "org-1") {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
}

class RouteProvider extends RagFlowKnowledgeProvider {
  chunkInput: Parameters<RagFlowKnowledgeProvider["listChunks"]>[0] | null = null;
  chunkSwitchInput: Parameters<RagFlowKnowledgeProvider["switchChunk"]>[0] | null = null;
  enabledInput: Parameters<RagFlowKnowledgeProvider["setResourceEnabled"]>[0] | null = null;
  reparseInput: Parameters<RagFlowKnowledgeProvider["reparseResource"]>[0] | null = null;

  override async listChunks(input: Parameters<RagFlowKnowledgeProvider["listChunks"]>[0]) {
    this.chunkInput = input;
    return { items: [], total: 0, page: input.page, pageSize: input.pageSize };
  }

  override async switchChunk(input: Parameters<RagFlowKnowledgeProvider["switchChunk"]>[0]) {
    this.chunkSwitchInput = input;
  }

  override async setResourceEnabled(input: Parameters<RagFlowKnowledgeProvider["setResourceEnabled"]>[0]) {
    this.enabledInput = input;
  }

  override async reparseResource(input: Parameters<RagFlowKnowledgeProvider["reparseResource"]>[0]) {
    this.reparseInput = input;
  }
}

class RuntimeProvider extends RagFlowKnowledgeProvider {
  override async searchDetailed() {
    return { chunks: [], total: 0, docAggs: [] };
  }

  override async generateKnowledgeGraph() {}

  override async getKnowledgeGraph(): Promise<Awaited<ReturnType<RagFlowKnowledgeProvider["getKnowledgeGraph"]>>> {
    return { graph: { nodes: [], edges: [] } };
  }

  override async deleteKnowledgeGraph() {}

  override async pollKnowledgeGraphProgress(): Promise<
    Awaited<ReturnType<RagFlowKnowledgeProvider["pollKnowledgeGraphProgress"]>>
  > {
    return { progress: 1, progressMsg: "完成", taskId: "task-1" };
  }
}

class FailingRuntimeProvider extends RuntimeProvider {
  override async generateKnowledgeGraph() {
    throw new Error("provider unavailable");
  }

  override async getKnowledgeGraph(): Promise<Awaited<ReturnType<RagFlowKnowledgeProvider["getKnowledgeGraph"]>>> {
    throw new Error("provider unavailable");
  }

  override async deleteKnowledgeGraph() {
    throw new Error("provider unavailable");
  }

  override async pollKnowledgeGraphProgress(): Promise<
    Awaited<ReturnType<RagFlowKnowledgeProvider["pollKnowledgeGraphProgress"]>>
  > {
    throw new Error("provider unavailable");
  }
}

const originals = {
  getBase: knowledgeBaseRepo.getById,
  getResource: knowledgeResourceRepo.getById,
  listResources: knowledgeResourceRepo.listByKnowledgeBase,
  updateResource: knowledgeResourceRepo.update,
};

describe("知识库 Web 路由 round33 覆盖", () => {
  beforeEach(() => {
    resetAllStubs();
    authenticate();
    setConfig({ ragflowApiKey: "test-ragflow-key" });
  });

  afterEach(() => {
    knowledgeBaseRepo.getById = originals.getBase;
    knowledgeResourceRepo.getById = originals.getResource;
    knowledgeResourceRepo.listByKnowledgeBase = originals.listResources;
    knowledgeResourceRepo.update = originals.updateResource;
    setKnowledgeProviderForTesting(null);
    setKnowledgeRuntimeProviderForTesting(null);
    setKnowledgeUploadProviderForTesting(null);
    resetConfig();
    resetTestAuth();
    resetAllStubs();
  });

  test.each([
    ["知识库列表", "/knowledgeBases", "GET", {}],
    ["知识库详情", "/knowledgeBases/kb-1", "GET", {}],
    ["知识库更新", "/knowledgeBases/kb-1", "PATCH", { name: "文档" }],
    ["知识库删除", "/knowledgeBases/kb-1", "DELETE", {}],
    ["表单选项", "/knowledgeBases/form-options", "GET", {}],
    ["重排序模型", "/knowledgeBases/rerank-models", "GET", {}],
    ["资源列表", "/knowledgeBases/kb-1/resources", "GET", {}],
    ["资源上传", "/knowledgeBases/kb-1/resources/upload", "POST", {}],
    ["URL 导入", "/knowledgeBases/kb-1/resources/url", "POST", { url: "https://example.test/doc" }],
    ["资源删除", "/knowledgeBases/kb-1/resources/resource-1", "DELETE", {}],
    ["切片列表", "/knowledgeBases/kb-1/resources/resource-1/chunks", "GET", {}],
    ["切片开关", "/knowledgeBases/kb-1/resources/resource-1/chunks/chunk-1/enabled", "PATCH", { enabled: true }],
    ["检索测试", "/knowledgeBases/kb-1/search", "POST", { query: "测试" }],
    ["图谱生成", "/knowledgeBases/kb-1/graph/generate", "POST", {}],
    ["图谱读取", "/knowledgeBases/kb-1/graph", "GET", {}],
    ["模型管理", "/knowledgeBases/models", "POST", { action: "list" }],
  ])("认证适配器缺失上下文时不暴露成功 DTO：%s", async (_name, path, method, body) => {
    resetTestAuth();
    const response = await jsonRequest(path, method, body);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test.each([
    ["verify 缺少 provider", { action: "verify", providerApiKey: "key" }, "provider 和 providerApiKey 必填"],
    ["verify 缺少 providerApiKey", { action: "verify", provider: "openai" }, "provider 和 providerApiKey 必填"],
    [
      "查询 provider 模型缺少 provider",
      { action: "list-provider-models", providerApiKey: "key" },
      "provider 和 providerApiKey 必填",
    ],
    [
      "查询 provider 模型缺少密钥",
      { action: "list-provider-models", provider: "openai" },
      "provider 和 providerApiKey 必填",
    ],
    [
      "查询实例模型缺少 provider",
      { action: "list-instance-models", instanceName: "default" },
      "provider 和 instanceName 必填",
    ],
    ["查询实例模型缺少实例", { action: "list-instance-models", provider: "openai" }, "provider 和 instanceName 必填"],
    [
      "设置模型状态缺少 provider",
      { action: "set-model-status", instanceName: "default", modelName: "text", status: "active" },
      "provider/instanceName/modelName/status 必填",
    ],
    [
      "设置模型状态缺少实例",
      { action: "set-model-status", provider: "openai", modelName: "text", status: "active" },
      "provider/instanceName/modelName/status 必填",
    ],
    [
      "设置模型状态缺少模型",
      { action: "set-model-status", provider: "openai", instanceName: "default", status: "active" },
      "provider/instanceName/modelName/status 必填",
    ],
    [
      "设置模型状态缺少状态",
      { action: "set-model-status", provider: "openai", instanceName: "default", modelName: "text" },
      "provider/instanceName/modelName/status 必填",
    ],
    [
      "新增模型缺少 provider",
      { action: "add", instanceName: "default", providerApiKey: "key" },
      "provider/instanceName/providerApiKey 必填",
    ],
    [
      "新增模型缺少实例",
      { action: "add", provider: "openai", providerApiKey: "key" },
      "provider/instanceName/providerApiKey 必填",
    ],
    [
      "新增模型缺少密钥",
      { action: "add", provider: "openai", instanceName: "default" },
      "provider/instanceName/providerApiKey 必填",
    ],
    ["删除模型缺少 provider", { action: "delete", instanceName: "default" }, "provider 和 instanceName 必填"],
    ["删除模型缺少实例", { action: "delete", provider: "openai" }, "provider 和 instanceName 必填"],
    ["未知模型动作", { action: "unsupported" }, "unknown action: unsupported"],
  ])("Embedding DTO 校验：%s", async (_name, body, message) => {
    const response = await jsonRequest("/knowledgeBases/models", "POST", body);
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "VALIDATION_ERROR", message } });
  });

  test.each([
    ["文件资源", "/knowledgeBases/kb-1/resources/resource-1/file"],
    ["PDF 资源", "/knowledgeBases/kb-1/resources/resource-1/pdf"],
    ["资源启用", "/knowledgeBases/kb-1/resources/resource-1/enabled"],
    ["资源重解析", "/knowledgeBases/kb-1/resources/resource-1/reparse"],
    ["资源切片", "/knowledgeBases/kb-1/resources/resource-1/chunks"],
    ["资源切片启用", "/knowledgeBases/kb-1/resources/resource-1/chunks/chunk-1/enabled"],
  ])("组织隔离：%s拒绝不属于目标知识库的资源", async (_name, path) => {
    knowledgeResourceRepo.getById = mock(async () => resource({ knowledgeBaseId: "kb-foreign" }));
    const method = path.includes("enabled") ? "PATCH" : path.includes("reparse") ? "POST" : "GET";
    const response = await jsonRequest(path, method, { enabled: true });
    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  test.each([
    ["不存在的资源", null, 404, "NOT_FOUND"],
    ["URL 资源缺少地址", resource({ sourceType: "url", sourcePath: null }), 500, null],
    ["上传资源缺少本地路径", resource({ sourcePath: null }), 500, null],
  ])("资源导出文件边界：%s", async (_name, item, status, code) => {
    knowledgeResourceRepo.getById = mock(async () => item) as unknown as typeof knowledgeResourceRepo.getById;
    const response = await request("/knowledgeBases/kb-1/resources/resource-1/file");
    expect(response.status).toBe(status);
    if (code) expect((await response.json()) as unknown).toMatchObject({ error: { code } });
  });

  test.each([
    ["不存在的资源", null],
    ["不属于知识库的资源", resource({ knowledgeBaseId: "kb-other" })],
    ["URL 资源", resource({ sourceType: "url", sourcePath: null })],
  ])("PDF 导出边界：%s", async (_name, item) => {
    knowledgeResourceRepo.getById = mock(async () => item) as unknown as typeof knowledgeResourceRepo.getById;
    const response = await request("/knowledgeBases/kb-1/resources/resource-1/pdf");
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test.each([
    ["负页码", "?page=-2", 1, 20],
    ["非法页码", "?page=abc", 1, 20],
    ["零页大小", "?pageSize=0", 1, 20],
    ["负页大小", "?pageSize=-8", 1, 1],
    ["超大页大小", "?pageSize=999", 1, 100],
    ["保留有效分页", "?page=3&pageSize=7", 3, 7],
  ])("切片 DTO 标准化：%s", async (_name, query, page, pageSize) => {
    const provider = new RouteProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await request(`/knowledgeBases/kb-1/resources/resource-1/chunks${query}`);
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: { items: [], total: 0, page, pageSize },
    });
    expect(provider.chunkInput).toMatchObject({ page, pageSize });
  });

  test.each([
    ["空字符串", {}, false],
    ["布尔真", { enabled: true }, true],
    ["布尔假", { enabled: false }, false],
    ["数值一", { enabled: 1 }, true],
    ["字符串 true", { enabled: "true" }, true],
    ["字符串 false", { enabled: "false" }, false],
  ])("资源启用 DTO 兼容输入：%s", async (_name, body, enabled) => {
    const provider = new RouteProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/resource-1/enabled", "PATCH", body);
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ success: true, data: { enabled } });
    expect(provider.enabledInput).toMatchObject({ enabled });
  });

  test.each([
    ["布尔真", { enabled: true }, true],
    ["布尔假", { enabled: false }, false],
    ["字符串 false 作为真值", { enabled: "false" }, true],
    ["数字零作为假值", { enabled: 0 }, false],
  ])("切片开关 DTO 使用真值转换：%s", async (_name, body, enabled) => {
    const provider = new RouteProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await jsonRequest(
      "/knowledgeBases/kb-1/resources/resource-1/chunks/chunk-1/enabled",
      "PATCH",
      body,
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ success: true, data: { enabled } });
    expect(provider.chunkSwitchInput).toMatchObject({ available: enabled, chunkId: "chunk-1" });
  });

  test.each([
    ["资源无远端 ID", resource({ remoteId: null }), knowledgeBase(), "NO_REMOTE"],
    ["知识库无远端 ID", resource(), knowledgeBase({ remoteId: null }), "NO_REMOTE"],
  ])("切片开关拒绝未同步数据：%s", async (_name, item, base, code) => {
    knowledgeResourceRepo.getById = mock(async () => item) as unknown as typeof knowledgeResourceRepo.getById;
    knowledgeBaseRepo.getById = mock(async () => base);
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/resource-1/chunks/chunk-1/enabled", "PATCH", {
      enabled: true,
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({ error: { code } });
  });

  test.each([
    ["资源无远端 ID", resource({ remoteId: null }), knowledgeBase()],
    ["知识库无远端 ID", resource(), knowledgeBase({ remoteId: null })],
  ])("重解析拒绝未同步数据：%s", async (_name, item, base) => {
    knowledgeResourceRepo.getById = mock(async () => item) as unknown as typeof knowledgeResourceRepo.getById;
    knowledgeBaseRepo.getById = mock(async () => base) as unknown as typeof knowledgeBaseRepo.getById;
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/resource-1/reparse", "POST", { delete: true });
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NOT_SYNCED" } });
  });

  test.each([
    ["保留旧切片", false],
    ["删除旧切片", true],
  ])("重解析将删除策略传给 provider：%s", async (_name, removeOld) => {
    const provider = new RouteProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeResourceRepo.update = mock(async () => undefined);
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/resource-1/reparse", "POST", {
      delete: removeOld,
    });
    expect(response.status).toBe(200);
    expect(provider.reparseInput).toMatchObject({ deleteOld: removeOld });
  });

  test.each([
    ["缺少 URL", {}],
    ["空 URL", { url: "" }],
    ["非字符串 URL", { url: 1 }],
  ])("URL 导入校验：%s", async (_name, body) => {
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/url", "POST", body);
    expect(response.status).toBe(422);
  });

  test.each([
    ["缺少名称", { action: "import", remoteId: "remote-2" }],
    ["缺少远端 ID", { action: "import", name: "导入文档" }],
  ])("导入知识库校验：%s", async (_name, body) => {
    const response = await jsonRequest("/knowledgeBases", "POST", body);
    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  test.each([
    ["空 slug", { name: "文档", slug: "" }, 422],
    ["非法 slug", { name: "文档", slug: "invalid slug!" }, 400],
    ["空搜索词", { query: "" }, 422],
    ["负数搜索页码", { query: "问题", page: -1 }, 422],
  ])("创建与检索 DTO schema：%s", async (_name, body, status) => {
    const path = "query" in body ? "/knowledgeBases/kb-1/search" : "/knowledgeBases";
    const response = await jsonRequest(path, "POST", body);
    expect(response.status).toBe(status);
  });

  test.each([
    ["生成图谱", "/knowledgeBases/kb-1/graph/generate", "POST"],
    ["读取图谱", "/knowledgeBases/kb-1/graph", "GET"],
    ["删除图谱", "/knowledgeBases/kb-1/graph", "DELETE"],
    ["查询图谱进度", "/knowledgeBases/kb-1/graph/progress", "GET"],
  ])("图谱路由将运行时异常映射为网关错误：%s", async (_name, path, method) => {
    setKnowledgeRuntimeProviderForTesting(new FailingRuntimeProvider());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await jsonRequest(path, method);
    expect(response.status).toBe(502);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "KNOWLEDGE_PROVIDER_ERROR" } });
  });

  test.each([
    ["生成图谱", "/knowledgeBases/kb-1/graph/generate", "POST"],
    ["读取图谱", "/knowledgeBases/kb-1/graph", "GET"],
    ["删除图谱", "/knowledgeBases/kb-1/graph", "DELETE"],
    ["查询图谱进度", "/knowledgeBases/kb-1/graph/progress", "GET"],
  ])("图谱路由返回稳定成功 DTO：%s", async (_name, path, method) => {
    setKnowledgeRuntimeProviderForTesting(new RuntimeProvider());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await jsonRequest(path, method);
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({ success: true });
  });
});
