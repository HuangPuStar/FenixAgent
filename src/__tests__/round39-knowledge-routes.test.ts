import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import {
  agentKnowledgeBindingRepo,
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

class KnowledgeRouteProvider extends RagFlowKnowledgeProvider {
  createInput: Parameters<RagFlowKnowledgeProvider["createKnowledgeBase"]>[0] | null = null;
  searchInput: Parameters<RagFlowKnowledgeProvider["searchDetailed"]>[0] | null = null;
  verifyInput: Parameters<NonNullable<RagFlowKnowledgeProvider["verifyProviderConnection"]>>[0] | null = null;
  providerModelsInput: Parameters<NonNullable<RagFlowKnowledgeProvider["listProviderModels"]>>[0] | null = null;
  instanceModelsInput: Parameters<NonNullable<RagFlowKnowledgeProvider["listInstanceModels"]>>[0] | null = null;
  modelStatusInput: Parameters<NonNullable<RagFlowKnowledgeProvider["setModelStatus"]>>[0] | null = null;
  addInput: Parameters<NonNullable<RagFlowKnowledgeProvider["addProviderInstance"]>>[0] | null = null;
  deleteInput: Parameters<NonNullable<RagFlowKnowledgeProvider["deleteProviderInstance"]>>[0] | null = null;

  override async createKnowledgeBase(
    input: Parameters<RagFlowKnowledgeProvider["createKnowledgeBase"]>[0],
  ): Promise<Awaited<ReturnType<RagFlowKnowledgeProvider["createKnowledgeBase"]>>> {
    this.createInput = input;
    return { remoteId: "remote-created", name: input.name, status: "empty", lastError: null };
  }

  override async getDataset() {
    return null;
  }

  override async listDatasets() {
    return [{ id: "remote-import", name: "远端文档" }];
  }

  override async listResources() {
    return [];
  }

  override async listEmbeddingModels() {
    return [{ name: "embed-1", label: "Embed 1", provider: "OpenAI", instance: "main" }];
  }

  override async listPipelines() {
    return [{ id: "pipeline-1", name: "默认流水线" }];
  }

  override async listRerankModels() {
    return [{ name: "rerank-1", label: "Rerank 1", provider: "OpenAI", instance: "main" }];
  }

  override async listFactories() {
    return [{ name: "openai", label: "OpenAI" }];
  }

  override async verifyProviderConnection(
    input: Parameters<NonNullable<RagFlowKnowledgeProvider["verifyProviderConnection"]>>[0],
  ) {
    this.verifyInput = input;
    return { success: true, message: "可用" };
  }

  override async listProviderModels(
    input: Parameters<NonNullable<RagFlowKnowledgeProvider["listProviderModels"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<RagFlowKnowledgeProvider["listProviderModels"]>>>> {
    this.providerModelsInput = input;
    return [{ name: "text-embedding-3-small", modelType: "embedding" }];
  }

  override async listInstanceModels(
    input: Parameters<NonNullable<RagFlowKnowledgeProvider["listInstanceModels"]>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<RagFlowKnowledgeProvider["listInstanceModels"]>>>> {
    this.instanceModelsInput = input;
    return [
      {
        name: "embed-1",
        provider: input.provider,
        instance: input.instanceName,
        modelType: "embedding",
        status: "active",
      },
    ];
  }

  override async setModelStatus(input: Parameters<NonNullable<RagFlowKnowledgeProvider["setModelStatus"]>>[0]) {
    this.modelStatusInput = input;
  }

  override async addProviderInstance(
    input: Parameters<NonNullable<RagFlowKnowledgeProvider["addProviderInstance"]>>[0],
  ) {
    this.addInput = input;
    return { instanceName: input.instanceName };
  }

  override async deleteProviderInstance(
    input: Parameters<NonNullable<RagFlowKnowledgeProvider["deleteProviderInstance"]>>[0],
  ) {
    this.deleteInput = input;
  }

  override async searchDetailed(input: Parameters<RagFlowKnowledgeProvider["searchDetailed"]>[0]) {
    this.searchInput = input;
    return { chunks: [], total: 0, docAggs: [] };
  }
}

const originals = {
  getBase: knowledgeBaseRepo.getById,
  createBase: knowledgeBaseRepo.create,
  updateBase: knowledgeBaseRepo.update,
  deleteBase: knowledgeBaseRepo.delete,
  listBases: knowledgeBaseRepo.listByOrganizationId,
  findBySlug: knowledgeBaseRepo.findByOrgAndSlug,
  countBindings: knowledgeBaseRepo.countBindings,
  getResource: knowledgeResourceRepo.getById,
  listResources: knowledgeResourceRepo.listByKnowledgeBase,
  countResources: knowledgeResourceRepo.countByKnowledgeBase,
  createResource: knowledgeResourceRepo.create,
  updateResource: knowledgeResourceRepo.update,
  deleteResource: knowledgeResourceRepo.delete,
  deleteBindings: agentKnowledgeBindingRepo.deleteByKnowledgeBaseId,
};

describe("知识库 Web 路由 round39 业务覆盖", () => {
  beforeEach(() => {
    resetAllStubs();
    authenticate();
    setConfig({ ragflowApiKey: "test-ragflow-key" });
    setKnowledgeProviderForTesting(new KnowledgeRouteProvider());
  });

  afterEach(() => {
    knowledgeBaseRepo.getById = originals.getBase;
    knowledgeBaseRepo.create = originals.createBase;
    knowledgeBaseRepo.update = originals.updateBase;
    knowledgeBaseRepo.delete = originals.deleteBase;
    knowledgeBaseRepo.listByOrganizationId = originals.listBases;
    knowledgeBaseRepo.findByOrgAndSlug = originals.findBySlug;
    knowledgeBaseRepo.countBindings = originals.countBindings;
    knowledgeResourceRepo.getById = originals.getResource;
    knowledgeResourceRepo.listByKnowledgeBase = originals.listResources;
    knowledgeResourceRepo.countByKnowledgeBase = originals.countResources;
    knowledgeResourceRepo.create = originals.createResource;
    knowledgeResourceRepo.update = originals.updateResource;
    knowledgeResourceRepo.delete = originals.deleteResource;
    agentKnowledgeBindingRepo.deleteByKnowledgeBaseId = originals.deleteBindings;
    setKnowledgeProviderForTesting(null);
    resetConfig();
    resetTestAuth();
    resetAllStubs();
  });

  // 未认证请求不得获得知识库列表。
  test("列表拒绝缺失认证上下文", async () => {
    resetTestAuth();
    const response = await request("/knowledgeBases");
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  // 列表应返回当前组织知识库及本地统计信息。
  test("列表聚合资源和绑定数量", async () => {
    knowledgeBaseRepo.listByOrganizationId = mock(async () => [knowledgeBase()]);
    knowledgeBaseRepo.countBindings = mock(async () => 3);
    knowledgeResourceRepo.countByKnowledgeBase = mock(async () => 7);

    const response = await request("/knowledgeBases");

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      success: true,
      data: [{ id: "kb-1", bindingsCount: 3, resourcesCount: 7 }],
    });
  });

  // 上游已删除的远端数据集应在列表中显式标记。
  test("列表标记不存在的远端知识库", async () => {
    knowledgeBaseRepo.listByOrganizationId = mock(async () => [knowledgeBase()]);
    knowledgeBaseRepo.countBindings = mock(async () => 0);
    knowledgeResourceRepo.countByKnowledgeBase = mock(async () => 0);

    const response = await request("/knowledgeBases");

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({ data: [{ remoteExists: false }] });
  });

  // 创建应将内置分块配置传给 provider 并持久化本地记录。
  test("创建知识库传递内置分块配置", async () => {
    const provider = new KnowledgeRouteProvider();
    const create = mock(async () => knowledgeBase({ id: "kb-created", remoteId: "remote-created", status: "empty" }));
    setKnowledgeProviderForTesting(provider);
    knowledgeBaseRepo.findByOrgAndSlug = mock(async () => null) as unknown as typeof knowledgeBaseRepo.findByOrgAndSlug;
    knowledgeBaseRepo.create = create;

    const response = await jsonRequest("/knowledgeBases", "POST", {
      name: "  产品手册  ",
      slug: "product-manual",
      parseMethod: "builtin",
      chunkMethod: "book",
    });

    expect(response.status).toBe(200);
    expect(provider.createInput).toMatchObject({
      name: "产品手册",
      slug: "product-manual",
      parseType: 1,
      chunkMethod: "book",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", remoteId: "remote-created" }),
    );
  });

  // 上游创建失败应映射为网关错误而非伪造成功。
  test("创建映射 provider 异常", async () => {
    const provider = new KnowledgeRouteProvider();
    provider.createKnowledgeBase = mock(async () => {
      throw new Error("provider unavailable");
    });
    setKnowledgeProviderForTesting(provider);
    knowledgeBaseRepo.findByOrgAndSlug = mock(async () => null) as unknown as typeof knowledgeBaseRepo.findByOrgAndSlug;

    const response = await jsonRequest("/knowledgeBases", "POST", { name: "产品手册" });

    expect(response.status).toBe(502);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "KNOWLEDGE_PROVIDER_ERROR" } });
  });

  // 同一组织不得重复关联同一个远端知识库。
  test("导入拒绝已关联远端知识库", async () => {
    knowledgeBaseRepo.listByOrganizationId = mock(async () => [knowledgeBase({ remoteId: "remote-import" })]);

    const response = await jsonRequest("/knowledgeBases", "POST", {
      action: "import",
      name: "远端文档",
      remoteId: "remote-import",
    });

    expect(response.status).toBe(409);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  // 详情不得跨组织泄露知识库元数据。
  test("详情隐藏其他组织的知识库", async () => {
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ organizationId: "org-foreign" }));

    const response = await request("/knowledgeBases/kb-1");

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 更新应修剪用户输入并只更新所属组织的记录。
  test("更新修剪名称和描述", async () => {
    const update = mock(async () => undefined);
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    knowledgeBaseRepo.update = update;

    const response = await jsonRequest("/knowledgeBases/kb-1", "PATCH", {
      name: "  新名称  ",
      description: "  新描述  ",
    });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith("kb-1", expect.objectContaining({ name: "新名称", description: "新描述" }));
  });

  // 更新不得跨组织修改目标知识库。
  test("更新拒绝跨组织知识库", async () => {
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ organizationId: "org-foreign" }));

    const response = await jsonRequest("/knowledgeBases/kb-1", "PATCH", { name: "新名称" });

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 删除应先清理绑定再删除本地知识库。
  test("删除清理绑定和本地知识库", async () => {
    const deleteBindings = mock(async () => undefined);
    const deleteBase = mock(async () => true);
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ remoteId: null }));
    agentKnowledgeBindingRepo.deleteByKnowledgeBaseId = deleteBindings;
    knowledgeBaseRepo.delete = deleteBase;

    const response = await request("/knowledgeBases/kb-1", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(deleteBindings).toHaveBeenCalledWith("kb-1");
    expect(deleteBase).toHaveBeenCalledWith("kb-1");
  });

  // 无远端 ID 的知识库资源列表应稳定返回空数组。
  test("资源列表为未同步知识库返回空数组", async () => {
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ remoteId: null }));

    const response = await request("/knowledgeBases/kb-1/resources");

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ success: true, data: [] });
  });

  // 资源列表不得返回其他组织的资源缓存。
  test("资源列表隐藏其他组织知识库", async () => {
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ organizationId: "org-foreign" }));

    const response = await request("/knowledgeBases/kb-1/resources");

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // URL 类型资源预览应重定向到原始来源，不读取本地文件。
  test("文件预览重定向 URL 资源", async () => {
    knowledgeResourceRepo.getById = mock(async () =>
      resource({ sourceType: "url", sourcePath: "https://example.test/manual" }),
    );

    const response = await request("/knowledgeBases/kb-1/resources/resource-1/file", { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.test/manual");
  });

  // 搜索应透传高级检索筛选参数并使用默认 topK。
  test("搜索转发高级查询配置", async () => {
    const provider = new KnowledgeRouteProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());

    const response = await jsonRequest("/knowledgeBases/kb-1/search", "POST", {
      query: "安装说明",
      similarityThreshold: 0.7,
      keyword: true,
      useKg: true,
      crossLanguages: ["Chinese", "English"],
      metaDataFilter: { method: "manual", logic: "and", manual: [{ key: "product", op: "=", value: "fenix" }] },
    });

    expect(response.status).toBe(200);
    expect(provider.searchInput).toMatchObject({
      query: "安装说明",
      topK: 1024,
      similarityThreshold: 0.7,
      keyword: true,
      useKg: true,
    });
    expect(provider.searchInput?.metaDataFilter).toMatchObject({ method: "manual", logic: "and" });
  });

  // 搜索不存在的知识库应映射为 404。
  test("搜索映射不存在知识库", async () => {
    knowledgeBaseRepo.getById = mock(async () => null) as unknown as typeof knowledgeBaseRepo.getById;

    const response = await jsonRequest("/knowledgeBases/kb-1/search", "POST", { query: "安装说明" });

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 创建表单应在单个上游目录失败时保留其他可用选项。
  test("表单选项降级失败的嵌入模型目录", async () => {
    const provider = new KnowledgeRouteProvider();
    provider.listEmbeddingModels = mock(async () => {
      throw new Error("embedding unavailable");
    });
    setKnowledgeProviderForTesting(provider);

    const response = await request("/knowledgeBases/form-options");

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      data: { embeddingModels: [], pipelines: [{ id: "pipeline-1" }], chunkMethods: expect.any(Array) },
    });
  });

  // rerank 目录应返回当前已配置的模型。
  test("rerank 模型目录返回 provider 数据", async () => {
    const response = await request("/knowledgeBases/rerank-models");

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: [{ name: "rerank-1", label: "Rerank 1", provider: "OpenAI", instance: "main" }],
    });
  });

  // 模型工厂目录应通过认证后提供可添加的厂商。
  test("模型管理列出厂商工厂", async () => {
    const response = await jsonRequest("/knowledgeBases/models", "POST", { action: "list-factories" });

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ success: true, data: [{ name: "openai", label: "OpenAI" }] });
  });

  // 模型连接验证应传递临时厂商凭据而不写入配置。
  test("模型管理验证厂商连接", async () => {
    const provider = new KnowledgeRouteProvider();
    setKnowledgeProviderForTesting(provider);

    const response = await jsonRequest("/knowledgeBases/models", "POST", {
      action: "verify",
      provider: "openai",
      providerApiKey: "temporary-key",
      baseUrl: "https://provider.example.test",
    });

    expect(response.status).toBe(200);
    expect(provider.verifyInput).toMatchObject({
      provider: "openai",
      providerApiKey: "temporary-key",
      baseUrl: "https://provider.example.test",
    });
  });

  // 模型目录查询应按指定 provider 使用临时凭据。
  test("模型管理查询 provider 模型", async () => {
    const provider = new KnowledgeRouteProvider();
    setKnowledgeProviderForTesting(provider);

    const response = await jsonRequest("/knowledgeBases/models", "POST", {
      action: "list-provider-models",
      provider: "openai",
      providerApiKey: "temporary-key",
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({ data: [{ name: "text-embedding-3-small" }] });
    expect(provider.providerModelsInput).toMatchObject({ provider: "openai", providerApiKey: "temporary-key" });
  });

  // 实例模型查询应限制在请求指定的 provider 和实例。
  test("模型管理查询实例模型", async () => {
    const provider = new KnowledgeRouteProvider();
    setKnowledgeProviderForTesting(provider);

    const response = await jsonRequest("/knowledgeBases/models", "POST", {
      action: "list-instance-models",
      provider: "openai",
      instanceName: "main",
    });

    expect(response.status).toBe(200);
    expect(provider.instanceModelsInput).toMatchObject({ provider: "openai", instanceName: "main" });
  });

  // 模型状态更新应将 active/inactive 状态传递给目标实例。
  test("模型管理切换实例模型状态", async () => {
    const provider = new KnowledgeRouteProvider();
    setKnowledgeProviderForTesting(provider);

    const response = await jsonRequest("/knowledgeBases/models", "POST", {
      action: "set-model-status",
      provider: "openai",
      instanceName: "main",
      modelName: "embed-1",
      status: "inactive",
    });

    expect(response.status).toBe(200);
    expect(provider.modelStatusInput).toMatchObject({
      provider: "openai",
      instanceName: "main",
      modelName: "embed-1",
      status: "inactive",
    });
  });

  // 新增 provider 实例应返回 provider 确认的实例名称。
  test("模型管理新增 provider 实例", async () => {
    const provider = new KnowledgeRouteProvider();
    setKnowledgeProviderForTesting(provider);

    const response = await jsonRequest("/knowledgeBases/models", "POST", {
      action: "add",
      provider: "openai",
      instanceName: "secondary",
      providerApiKey: "temporary-key",
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ success: true, data: { instanceName: "secondary" } });
    expect(provider.addInput).toMatchObject({ provider: "openai", instanceName: "secondary" });
  });

  // 删除 provider 实例必须将操作限定为当前请求的实例。
  test("模型管理删除 provider 实例", async () => {
    const provider = new KnowledgeRouteProvider();
    setKnowledgeProviderForTesting(provider);

    const response = await jsonRequest("/knowledgeBases/models", "POST", {
      action: "delete",
      provider: "openai",
      instanceName: "secondary",
    });

    expect(response.status).toBe(200);
    expect(provider.deleteInput).toMatchObject({ provider: "openai", instanceName: "secondary" });
  });
});
