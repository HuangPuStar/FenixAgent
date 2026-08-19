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

class RouteProvider extends RagFlowKnowledgeProvider {
  downloadResult: { content: string; contentType: string; fileName: string } | null = null;
  throwOnEnabled = false;
  throwOnReparse = false;
  throwOnChunks = false;
  throwOnSwitch = false;

  override async downloadResource() {
    return this.downloadResult;
  }

  override async getDataset() {
    return null;
  }

  override async listResources() {
    return [];
  }

  override async setResourceEnabled() {
    if (this.throwOnEnabled) throw new Error("toggle unavailable");
  }

  override async reparseResource() {
    if (this.throwOnReparse) throw new Error("reparse unavailable");
  }

  override async listChunks(input: Parameters<RagFlowKnowledgeProvider["listChunks"]>[0]) {
    if (this.throwOnChunks) throw new Error("chunks unavailable");
    return { items: [], total: 0, page: input.page, pageSize: input.pageSize };
  }

  override async switchChunk() {
    if (this.throwOnSwitch) throw new Error("switch unavailable");
  }
}

class RuntimeProvider extends RagFlowKnowledgeProvider {
  throwOnGraph = false;

  override async generateKnowledgeGraph() {
    if (this.throwOnGraph) throw new Error("graph unavailable");
  }

  override async getKnowledgeGraph() {
    if (this.throwOnGraph) throw new Error("graph unavailable");
    return { graph: { nodes: [{ id: "node-1" }], edges: [] } };
  }

  override async deleteKnowledgeGraph() {
    if (this.throwOnGraph) throw new Error("graph unavailable");
  }

  override async pollKnowledgeGraphProgress() {
    if (this.throwOnGraph) throw new Error("graph unavailable");
    return { progress: 1, progressMsg: "完成", taskId: "task-1" };
  }
}

const originals = {
  getBase: knowledgeBaseRepo.getById,
  createBase: knowledgeBaseRepo.create,
  updateBase: knowledgeBaseRepo.update,
  listBases: knowledgeBaseRepo.listByOrganizationId,
  getResource: knowledgeResourceRepo.getById,
  createResource: knowledgeResourceRepo.create,
  updateResource: knowledgeResourceRepo.update,
};

describe("知识库 Web 路由 round65 未覆盖分支", () => {
  beforeEach(() => {
    resetAllStubs();
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    setConfig({ ragflowApiKey: "test-ragflow-key" });
    setTestAuth({
      user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
  });

  afterEach(() => {
    knowledgeBaseRepo.getById = originals.getBase;
    knowledgeBaseRepo.create = originals.createBase;
    knowledgeBaseRepo.update = originals.updateBase;
    knowledgeBaseRepo.listByOrganizationId = originals.listBases;
    knowledgeResourceRepo.getById = originals.getResource;
    knowledgeResourceRepo.create = originals.createResource;
    knowledgeResourceRepo.update = originals.updateResource;
    setKnowledgeProviderForTesting(null);
    setKnowledgeRuntimeProviderForTesting(null);
    resetConfig();
    resetTestAuth();
    resetAllStubs();
  });

  // multipart 中没有文件时应返回空处理结果而非调用上传服务。
  test("上传忽略非文件 multipart 字段", async () => {
    const form = new FormData();
    form.append("files", "not-a-file");
    const response = await request("/knowledgeBases/kb-1/resources/upload", { method: "POST", body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { items: [] } });
  });

  // URL 资源预览应保留原地址作为重定向目标。
  test("URL 资源预览重定向到来源地址", async () => {
    knowledgeResourceRepo.getById = mock(async () =>
      resource({ sourceType: "url", sourcePath: "https://example.test/doc" }),
    );
    const response = await request("/knowledgeBases/kb-1/resources/resource-1/file");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.test/doc");
  });

  // 远端资源可在无本地文件时由 provider 返回预览内容。
  test("远端资源预览转发 provider 下载内容", async () => {
    const provider = new RouteProvider();
    provider.downloadResult = { content: "remote content", contentType: "text/plain", fileName: "remote.txt" };
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource({ sourceType: "ragflow", sourcePath: null }));
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await request("/knowledgeBases/kb-1/resources/resource-1/file");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("remote content");
  });

  // provider 没有下载结果时应退回到稳定的不可预览错误。
  test("远端资源下载为空时返回无本地文件错误", async () => {
    setKnowledgeProviderForTesting(new RouteProvider());
    knowledgeResourceRepo.getById = mock(async () => resource({ sourceType: "ragflow", sourcePath: null }));
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await request("/knowledgeBases/kb-1/resources/resource-1/file");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "NO_LOCAL_FILE" } });
  });

  // PDF 转换在本地源文件缺失时应映射为转换失败。
  test("PDF 转换映射本地文件缺失", async () => {
    knowledgeResourceRepo.getById = mock(async () =>
      resource({ sourcePath: "/missing/guide.docx", sourceName: "guide.docx" }),
    );
    const response = await request("/knowledgeBases/kb-1/resources/resource-1/pdf");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "CONVERSION_ERROR" } });
  });

  // PDF 转换只接受 Office 文档，普通文本不应触发转换程序。
  test("PDF 转换拒绝非 Office 文档", async () => {
    knowledgeResourceRepo.getById = mock(async () =>
      resource({ sourceName: "guide.md", sourcePath: "/missing/guide.md" }),
    );
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await request("/knowledgeBases/kb-1/resources/resource-1/pdf");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_OFFICE_FILE" } });
  });

  // 资源不存在时不能调用资源启用 provider。
  test("资源启用拒绝不存在的资源", async () => {
    knowledgeResourceRepo.getById = mock(async () => null);
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/resource-1/enabled", "PATCH", { enabled: true });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // provider 失败应映射为资源启用失败而不是泄露成功响应。
  test("资源启用映射 provider 异常", async () => {
    const provider = new RouteProvider();
    provider.throwOnEnabled = true;
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/resource-1/enabled", "PATCH", { enabled: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "TOGGLE_FAILED", message: "toggle unavailable" } });
  });

  // 重试解析遇到跨组织知识库时必须隐藏资源存在性。
  test("重试解析拒绝跨组织知识库", async () => {
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ organizationId: "org-2" }));
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/resource-1/reparse", "POST", { delete: false });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 重试解析 provider 失败时不应修改本地 processing 状态。
  test("重试解析映射 provider 异常", async () => {
    const provider = new RouteProvider();
    provider.throwOnReparse = true;
    const update = mock(async () => undefined);
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeResourceRepo.update = update;
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/resource-1/reparse", "POST", { delete: true });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "REPARSE_FAILED", message: "reparse unavailable" } });
    expect(update).not.toHaveBeenCalled();
  });

  // 未同步知识库的切片列表应走本地空分页分支。
  test("切片列表在知识库未同步时返回空分页", async () => {
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ remoteId: null }));
    const response = await request("/knowledgeBases/kb-1/resources/resource-1/chunks?page=4&pageSize=6");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { items: [], total: 0, page: 4, pageSize: 6 } });
  });

  // 切片列表 provider 失败时应统一映射为业务错误。
  test("切片列表映射 provider 异常", async () => {
    const provider = new RouteProvider();
    provider.throwOnChunks = true;
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await request("/knowledgeBases/kb-1/resources/resource-1/chunks");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "CHUNK_LIST_FAILED", message: "chunks unavailable" },
    });
  });

  // 切片开关在跨组织知识库下必须返回 404。
  test("切片开关拒绝跨组织知识库", async () => {
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ organizationId: "org-2" }));
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/resource-1/chunks/chunk-1/enabled", "PATCH", {
      enabled: true,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 切片 provider 失败必须映射为单独的切换失败代码。
  test("切片开关映射 provider 异常", async () => {
    const provider = new RouteProvider();
    provider.throwOnSwitch = true;
    setKnowledgeProviderForTesting(provider);
    knowledgeResourceRepo.getById = mock(async () => resource());
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const response = await jsonRequest("/knowledgeBases/kb-1/resources/resource-1/chunks/chunk-1/enabled", "PATCH", {
      enabled: true,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "CHUNK_SWITCH_FAILED", message: "switch unavailable" },
    });
  });

  // 导入时同一组织已有远端绑定必须拒绝重复创建。
  test("导入拒绝当前组织的重复远端绑定", async () => {
    knowledgeBaseRepo.listByOrganizationId = mock(async () => [knowledgeBase({ remoteId: "remote-2" })]);
    const response = await jsonRequest("/knowledgeBases", "POST", {
      action: "import",
      name: "导入文档",
      remoteId: "remote-2",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  // 导入创建本地绑定失败时应映射为 provider 错误。
  test("导入创建本地知识库绑定映射异常", async () => {
    knowledgeBaseRepo.listByOrganizationId = mock(async () => []);
    knowledgeBaseRepo.create = mock(async () => {
      throw new Error("create binding unavailable");
    });
    const response = await jsonRequest("/knowledgeBases", "POST", {
      action: "import",
      name: "导入文档",
      remoteId: "remote-2",
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "KNOWLEDGE_PROVIDER_ERROR", message: "create binding unavailable" },
    });
  });

  // 图谱生成成功应返回空数据确认异步任务已提交。
  test("图谱生成返回成功确认", async () => {
    setKnowledgeRuntimeProviderForTesting(new RuntimeProvider());
    const response = await jsonRequest("/knowledgeBases/kb-1/graph/generate", "POST");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
  });

  // 图谱读取应保留 runtime provider 的图数据。
  test("图谱读取返回 provider 图数据", async () => {
    setKnowledgeRuntimeProviderForTesting(new RuntimeProvider());
    const response = await request("/knowledgeBases/kb-1/graph");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { graph: { nodes: [{ id: "node-1" }] } } });
  });

  // 图谱删除成功应返回统一空响应。
  test("图谱删除返回成功确认", async () => {
    setKnowledgeRuntimeProviderForTesting(new RuntimeProvider());
    const response = await request("/knowledgeBases/kb-1/graph", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: null });
  });

  // 图谱进度轮询应返回 provider 的任务进度。
  test("图谱进度返回 provider 结果", async () => {
    setKnowledgeRuntimeProviderForTesting(new RuntimeProvider());
    const response = await request("/knowledgeBases/kb-1/graph/progress");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { progress: 1, taskId: "task-1" } });
  });

  // 图谱 provider 故障必须映射为网关错误。
  test("图谱生成映射 provider 异常", async () => {
    const provider = new RuntimeProvider();
    provider.throwOnGraph = true;
    setKnowledgeRuntimeProviderForTesting(provider);
    const response = await jsonRequest("/knowledgeBases/kb-1/graph/generate", "POST");
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: "KNOWLEDGE_PROVIDER_ERROR", message: "graph unavailable" },
    });
  });
});
