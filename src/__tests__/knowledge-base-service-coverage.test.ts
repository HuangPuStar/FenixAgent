import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { agentKnowledgeBindingRepo, type KnowledgeBaseRow, knowledgeBaseRepo } from "../repositories/knowledge-base";
import webKnowledgeBasesRoute from "../routes/web/knowledge-bases";
import {
  createKnowledgeBaseRecord,
  deleteKnowledgeBase,
  listConfiguredProviderTree,
  listKnowledgeFormOptions,
  listProviderEmbeddingModels,
  setKnowledgeProviderForTesting,
  updateKnowledgeBase,
  verifyEmbeddingProvider,
} from "../services/knowledge-base";
import { RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";
import { resetAllStubs } from "../test-utils/helpers";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function kb(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "产品文档",
    slug: "product-docs",
    description: "说明",
    provider: "ragflow",
    remoteId: "remote-1",
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

class ControlledProvider extends RagFlowKnowledgeProvider {
  created: unknown = null;
  deleted: unknown = null;

  override async createKnowledgeBase(input: Parameters<RagFlowKnowledgeProvider["createKnowledgeBase"]>[0]) {
    this.created = input;
    return { remoteId: "remote-created", name: input.name, status: "empty" as const };
  }

  override async deleteKnowledgeBase(input: Parameters<RagFlowKnowledgeProvider["deleteKnowledgeBase"]>[0]) {
    this.deleted = input;
  }
}

function request(path: string, init?: RequestInit) {
  return webKnowledgeBasesRoute.handle(new Request(`http://localhost${path}`, init));
}

function setAuthenticatedOrg(organizationId = "org-1") {
  setTestAuth({
    user: { id: "user-1", email: "user-1@test.com", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
}

const originals = {
  create: knowledgeBaseRepo.create,
  delete: knowledgeBaseRepo.delete,
  findByOrgAndSlug: knowledgeBaseRepo.findByOrgAndSlug,
  getById: knowledgeBaseRepo.getById,
  update: knowledgeBaseRepo.update,
  deleteBindings: agentKnowledgeBindingRepo.deleteByKnowledgeBaseId,
};

describe("知识库 service 隔离分支", () => {
  beforeEach(() => {
    resetAllStubs();
    setAuthenticatedOrg();
    setConfig({ ragflowApiKey: "test-ragflow-key" });
  });

  afterEach(() => {
    knowledgeBaseRepo.create = originals.create;
    knowledgeBaseRepo.delete = originals.delete;
    knowledgeBaseRepo.findByOrgAndSlug = originals.findByOrgAndSlug;
    knowledgeBaseRepo.getById = originals.getById;
    knowledgeBaseRepo.update = originals.update;
    agentKnowledgeBindingRepo.deleteByKnowledgeBaseId = originals.deleteBindings;
    setKnowledgeProviderForTesting(null);
    resetConfig();
    resetTestAuth();
    resetAllStubs();
  });

  // 路由 schema 必须在访问 service 前拒绝空 slug，避免无效配置进入远端调用。
  test("POST /knowledgeBases 的空 slug 被 Zod 拒绝", async () => {
    const create = mock(async () => kb());
    knowledgeBaseRepo.create = create;

    const response = await request("/knowledgeBases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "文档", slug: "" }),
    });

    expect(response.status).toBe(422);
    expect(create).not.toHaveBeenCalled();
  });

  // provider key 缺失时路由应返回业务错误，而不是向上游发送空凭据。
  test("POST /knowledgeBases 在 provider 不可用时返回验证错误", async () => {
    setConfig({ ragflowApiKey: "" });

    const response = await request("/knowledgeBases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "文档" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "RAGFLOW_API_KEY is not configured" },
    });
  });

  // 路由 PATCH 通过 service 的组织边界处理跨组织对象，响应不能泄漏其存在性。
  test("PATCH /knowledgeBases/:id 对跨组织记录返回 404", async () => {
    knowledgeBaseRepo.getById = mock(async () => kb({ organizationId: "org-foreign" }));

    const response = await request("/knowledgeBases/kb-foreign", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "不应更新" }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "知识库不存在" },
    });
  });

  // DELETE 路由应在当前组织范围内删除远端数据及本地绑定，并返回空 DTO。
  test("DELETE /knowledgeBases/:id 删除当前组织知识库", async () => {
    const provider = new ControlledProvider();
    setKnowledgeProviderForTesting(provider);
    const deleteBindings = mock(async () => undefined);
    const deleteBase = mock(async () => true);
    knowledgeBaseRepo.getById = mock(async () => kb());
    knowledgeBaseRepo.delete = deleteBase;
    agentKnowledgeBindingRepo.deleteByKnowledgeBaseId = deleteBindings;

    const response = await request("/knowledgeBases/kb-1", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(provider.deleted).toMatchObject({
      knowledgeBaseRemoteId: "remote-1",
      remoteAccountId: "account-1",
      remoteUserId: "remote-user-1",
      apiKey: "test-ragflow-key",
    });
    expect(deleteBindings).toHaveBeenCalledWith("kb-1");
    expect(deleteBase).toHaveBeenCalledWith("kb-1");
    expect(await response.json()).toEqual({ success: true, data: null });
  });

  // 创建时 pipeline 只应把 pipeline 配置传给远端，避免混入 builtin 的 chunkMethod。
  test("创建 pipeline 知识库时映射解析配置", async () => {
    const provider = new ControlledProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeBaseRepo.findByOrgAndSlug = mock(async () => null);
    knowledgeBaseRepo.create = mock(async (input) => kb({ ...input, id: "kb-created", remoteId: "remote-created" }));

    const result = await createKnowledgeBaseRecord(
      "org-1",
      {
        name: " 流水线知识库 ",
        slug: "Pipeline-KB",
        parseMethod: "pipeline",
        pipelineId: " pipe-1 ",
        chunkMethod: "book",
      },
      "user-1",
    );

    expect(result).toMatchObject({ success: true, data: { id: "kb-created", slug: "pipeline-kb" } });
    expect(provider.created).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      name: "流水线知识库",
      slug: "pipeline-kb",
      parseType: 2,
      pipelineId: "pipe-1",
      chunkMethod: null,
    });
  });

  // 创建前 slug 冲突必须短路，不能创建远端 dataset。
  test("创建知识库时拒绝同组织重复 slug", async () => {
    const provider = new ControlledProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeBaseRepo.findByOrgAndSlug = mock(async () => kb());

    await expect(createKnowledgeBaseRecord("org-1", { name: "重复", slug: "product-docs" }, "user-1")).resolves.toEqual(
      {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "知识库 slug 'product-docs' 已存在" },
      },
    );
    expect(provider.created).toBeNull();
  });

  // 更新跨组织记录必须伪装为不存在，防止泄漏另一组织的资源存在性。
  test("更新跨组织知识库返回 NOT_FOUND", async () => {
    knowledgeBaseRepo.getById = mock(async () => kb({ organizationId: "org-foreign" }));

    await expect(updateKnowledgeBase("org-1", "kb-1", { name: "不应更新" })).resolves.toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "知识库不存在" },
    });
  });

  // 更新应标准化 slug 和空白描述，防止将无效展示值持久化。
  test("更新知识库时标准化 slug 与描述", async () => {
    let changes: Record<string, unknown> | null = null;
    knowledgeBaseRepo.getById = mock(async () => kb());
    knowledgeBaseRepo.findByOrgAndSlug = mock(async () => null);
    knowledgeBaseRepo.update = mock(async (_id, input) => {
      changes = input;
    });

    const result = await updateKnowledgeBase("org-1", "kb-1", {
      name: " 新名称 ",
      slug: " New-Slug ",
      description: "   ",
    });

    expect(result).toMatchObject({ success: true, data: { id: "kb-1" } });
    expect(changes).toMatchObject({ name: "新名称", slug: "new-slug", description: null });
  });

  // 远端对象已被清理时删除仍应清除本地绑定与知识库，保证删除幂等。
  test("删除忽略远端不存在错误并继续清理本地记录", async () => {
    const provider = new ControlledProvider();
    provider.deleteKnowledgeBase = mock(async () => {
      throw new Error("Dataset not found");
    });
    setKnowledgeProviderForTesting(provider);
    const deleteBindings = mock(async () => undefined);
    const deleteBase = mock(async () => true);
    knowledgeBaseRepo.getById = mock(async () => kb());
    knowledgeBaseRepo.delete = deleteBase;
    agentKnowledgeBindingRepo.deleteByKnowledgeBaseId = deleteBindings;

    await expect(deleteKnowledgeBase("org-1", "kb-1", "user-1")).resolves.toEqual({
      success: true,
      data: { ok: true },
    });
    expect(deleteBindings).toHaveBeenCalledWith("kb-1");
    expect(deleteBase).toHaveBeenCalledWith("kb-1");
  });

  // 表单选项查询失败时应降级为空远端数据，仍返回本地支持的分块方法。
  test("表单选项在 provider 失败时可降级返回", async () => {
    class FailingOptionsProvider extends RagFlowKnowledgeProvider {
      override async listEmbeddingModels() {
        throw new Error("embedding unavailable");
      }
      override async listPipelines() {
        throw new Error("pipeline unavailable");
      }
    }
    setKnowledgeProviderForTesting(new FailingOptionsProvider());

    const result = await listKnowledgeFormOptions("test-ragflow-key");

    expect(result.embeddingModels).toEqual([]);
    expect(result.pipelines).toEqual([]);
    expect(result.chunkMethods.length).toBeGreaterThan(0);
  });

  // provider 树必须去重并隐藏没有 embedding 模型的实例。
  test("provider 树过滤重复供应商和空实例", async () => {
    class TreeProvider extends RagFlowKnowledgeProvider {
      override async listConfiguredProviders() {
        return ["OpenAI", "OpenAI", "Empty"];
      }
      override async listProviderInstances({ provider }: { provider: string; apiKey: string }) {
        return provider === "OpenAI"
          ? [{ provider, instanceName: "main", status: "active" }]
          : [{ provider, instanceName: "none", status: "active" }];
      }
      override async listInstanceModels({ instanceName }: { provider: string; instanceName: string; apiKey: string }) {
        return instanceName === "main" ? [{ name: "text-embedding", status: "active" }] : [];
      }
    }
    setKnowledgeProviderForTesting(new TreeProvider());

    await expect(listConfiguredProviderTree("global", "user-1", "org-1")).resolves.toEqual([
      {
        provider: "OpenAI",
        instances: [
          {
            provider: "OpenAI",
            instanceName: "main",
            status: "active",
            models: [{ name: "text-embedding", status: "active" }],
          },
        ],
      },
    ]);
  });

  // provider 动态能力可用时，service 必须补齐全局 key 与 embedding 模型类型。
  test("动态 provider 能力接收统一认证参数", async () => {
    class DynamicProvider extends ControlledProvider {
      override async verifyProviderConnection(input: {
        provider: string;
        providerApiKey: string;
        baseUrl?: string | null;
        apiKey: string;
      }) {
        return { success: true, message: input.apiKey };
      }

      override async listProviderModels(input: {
        provider: string;
        providerApiKey: string;
        baseUrl?: string | null;
        modelType: string;
        apiKey: string;
      }) {
        return [{ name: `${input.provider}-${input.modelType}`, modelType: input.modelType }];
      }
    }
    setKnowledgeProviderForTesting(new DynamicProvider());

    await expect(
      verifyEmbeddingProvider("global", "user-1", "org-1", { provider: "OpenAI", providerApiKey: "key" }),
    ).resolves.toEqual({
      success: true,
      message: "test-ragflow-key",
    });
    await expect(
      listProviderEmbeddingModels("global", "user-1", "org-1", { provider: "OpenAI", providerApiKey: "key" }),
    ).resolves.toEqual([{ name: "OpenAI-embedding", modelType: "embedding" }]);
  });
});
