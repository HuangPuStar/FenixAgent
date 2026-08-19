import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import {
  agentKnowledgeBindingRepo,
  type KnowledgeBaseRow,
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "../repositories/knowledge-base";
import {
  addEmbeddingProvider,
  createKnowledgeBaseRecord,
  deleteKnowledgeBase,
  getKnowledgeBaseDetail,
  isRemoteKnowledgeBaseMissingError,
  listConfiguredProviderTree,
  listEmbeddingFactories,
  listInstanceEmbeddingModels,
  listKnowledgeBases,
  listProviderEmbeddingModels,
  resolveKnowledgeTenantIdentity,
  setEmbeddingModelStatus,
  setKnowledgeProviderForTesting,
  touchKnowledgeBaseUpdatedAt,
  upsertKnowledgeBaseStatusFromResources,
  verifyEmbeddingProvider,
} from "../services/knowledge-base";
import { RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";

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

class Provider extends RagFlowKnowledgeProvider {
  created: Parameters<RagFlowKnowledgeProvider["createKnowledgeBase"]>[0] | null = null;
  deleted: Parameters<RagFlowKnowledgeProvider["deleteKnowledgeBase"]>[0] | null = null;

  override async createKnowledgeBase(input: Parameters<RagFlowKnowledgeProvider["createKnowledgeBase"]>[0]) {
    this.created = input;
    return { remoteId: "remote-created", name: input.name, status: "empty" as const };
  }

  override async deleteKnowledgeBase(input: Parameters<RagFlowKnowledgeProvider["deleteKnowledgeBase"]>[0]) {
    this.deleted = input;
  }

  override async listFactories() {
    return [];
  }

  override async setModelStatus() {}

  override async listInstanceModels() {
    return [];
  }

  override async verifyProviderConnection() {
    return { success: false, message: "provider 不支持 verifyProviderConnection" };
  }

  override async listProviderModels() {
    return [];
  }
}

const originals = {
  baseCreate: knowledgeBaseRepo.create,
  baseDelete: knowledgeBaseRepo.delete,
  baseFindSlug: knowledgeBaseRepo.findByOrgAndSlug,
  baseGet: knowledgeBaseRepo.getById,
  baseList: knowledgeBaseRepo.listByOrganizationId,
  baseGlobal: knowledgeBaseRepo.listGlobal,
  baseUpdate: knowledgeBaseRepo.update,
  baseCountBindings: knowledgeBaseRepo.countBindings,
  resourceCount: knowledgeResourceRepo.countByKnowledgeBase,
  resourceList: knowledgeResourceRepo.listByKnowledgeBase,
  resourceSummary: knowledgeResourceRepo.getStatusSummary,
  bindingsDelete: agentKnowledgeBindingRepo.deleteByKnowledgeBaseId,
};

describe("round62 知识库 service 补充覆盖", () => {
  beforeEach(() => {
    setConfig({ ragflowApiKey: "round62-key" });
  });

  afterEach(() => {
    knowledgeBaseRepo.create = originals.baseCreate;
    knowledgeBaseRepo.delete = originals.baseDelete;
    knowledgeBaseRepo.findByOrgAndSlug = originals.baseFindSlug;
    knowledgeBaseRepo.getById = originals.baseGet;
    knowledgeBaseRepo.listByOrganizationId = originals.baseList;
    knowledgeBaseRepo.listGlobal = originals.baseGlobal;
    knowledgeBaseRepo.update = originals.baseUpdate;
    knowledgeBaseRepo.countBindings = originals.baseCountBindings;
    knowledgeResourceRepo.countByKnowledgeBase = originals.resourceCount;
    knowledgeResourceRepo.listByKnowledgeBase = originals.resourceList;
    knowledgeResourceRepo.getStatusSummary = originals.resourceSummary;
    agentKnowledgeBindingRepo.deleteByKnowledgeBaseId = originals.bindingsDelete;
    setKnowledgeProviderForTesting(null);
    resetConfig();
  });

  // 空白名称必须在访问仓储和远端前被拒绝。
  test("创建拒绝空白名称", async () => {
    const findSlug = mock(async () => null);
    knowledgeBaseRepo.findByOrgAndSlug = findSlug;

    await expect(createKnowledgeBaseRecord("org-1", { name: "  " })).resolves.toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "知识库名称不能为空" },
    });
    expect(findSlug).not.toHaveBeenCalled();
  });

  // 非法 slug 不应触发唯一性查询或 provider 调用。
  test("创建拒绝包含非法字符的 slug", async () => {
    const findSlug = mock(async () => null);
    knowledgeBaseRepo.findByOrgAndSlug = findSlug;

    await expect(createKnowledgeBaseRecord("org-1", { name: "文档", slug: "bad_slug" })).resolves.toMatchObject({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "slug 只能包含字母、数字和连字符" },
    });
    expect(findSlug).not.toHaveBeenCalled();
  });

  // builtin 解析配置应只把分块方法传给远端并持久化元数据。
  test("创建 builtin 知识库映射分块配置和租户身份", async () => {
    const provider = new Provider();
    setKnowledgeProviderForTesting(provider);
    knowledgeBaseRepo.findByOrgAndSlug = mock(async () => null);
    const create = mock(async (input) => kb({ ...input, id: "kb-created", remoteId: "remote-created" }));
    knowledgeBaseRepo.create = create;

    const result = await createKnowledgeBaseRecord(
      "org-1",
      {
        name: " 内置文档 ",
        slug: " Builtin-KB ",
        parseMethod: "builtin",
        chunkMethod: " book ",
        embeddingModel: "embed",
      },
      "user-1",
    );

    expect(result).toMatchObject({ success: true, data: { slug: "builtin-kb", embeddingModel: "embed" } });
    expect(provider.created).toMatchObject({ parseType: 1, chunkMethod: "book", pipelineId: null, apiKey: undefined });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ remoteAccountId: "user-1", remoteUserId: "user-1" }));
  });

  // 远端漏返回 ID 时不能写入无法关联的本地记录。
  test("创建在远端缺少 ID 时拒绝本地持久化", async () => {
    class MissingIdProvider extends Provider {
      override async createKnowledgeBase(input: Parameters<RagFlowKnowledgeProvider["createKnowledgeBase"]>[0]) {
        this.created = input;
        return { remoteId: null, name: input.name, status: "empty" as const };
      }
    }
    setKnowledgeProviderForTesting(new MissingIdProvider());
    knowledgeBaseRepo.findByOrgAndSlug = mock(async () => null);
    const create = mock(async () => kb());
    knowledgeBaseRepo.create = create;

    await expect(createKnowledgeBaseRecord("org-1", { name: "文档", slug: "docs" })).rejects.toThrow("remoteId");
    expect(create).not.toHaveBeenCalled();
  });

  // 未显式传用户时应以组织 ID 作为本地和远端租户回退值。
  test("创建使用组织 ID 作为缺省用户身份", async () => {
    const provider = new Provider();
    setKnowledgeProviderForTesting(provider);
    knowledgeBaseRepo.findByOrgAndSlug = mock(async () => null);
    knowledgeBaseRepo.create = mock(async (input) => kb({ ...input, remoteId: "remote-created" }));

    await createKnowledgeBaseRecord("org-1", { name: "文档", slug: "docs" });

    expect(provider.created).toMatchObject({ userId: "org-1", organizationId: "org-1" });
  });

  // 详情接口必须对其他组织的记录伪装为不存在。
  test("详情隔离跨组织知识库", async () => {
    knowledgeBaseRepo.getById = mock(async () => kb({ organizationId: "org-2" }));

    await expect(getKnowledgeBaseDetail("org-1", "kb-1")).resolves.toBeNull();
  });

  // provider 返回空 dataset 时列表应标记远端对象缺失。
  test("列表标记远端已删除的知识库", async () => {
    class MissingDatasetProvider extends Provider {
      override async getDataset() {
        return null;
      }
    }
    setKnowledgeProviderForTesting(new MissingDatasetProvider());
    knowledgeBaseRepo.listByOrganizationId = mock(async () => [kb()]);
    knowledgeBaseRepo.countBindings = mock(async () => 0);
    knowledgeResourceRepo.countByKnowledgeBase = mock(async () => 0);

    await expect(listKnowledgeBases("org-1", "ignored")).resolves.toMatchObject([{ remoteExists: false }]);
  });

  // 远端配置缺失时列表应回填本地元数据并更新返回 DTO。
  test("列表同步远端解析配置到空元数据", async () => {
    class DatasetProvider extends Provider {
      override async getDataset() {
        return {
          remoteId: "remote-1",
          name: "文档",
          status: "ready" as const,
          embeddingModel: "embed",
          parseMethod: "builtin" as const,
          chunkMethod: "book",
        };
      }
    }
    setKnowledgeProviderForTesting(new DatasetProvider());
    knowledgeBaseRepo.listByOrganizationId = mock(async () => [kb({ metadata: null })]);
    knowledgeBaseRepo.countBindings = mock(async () => 0);
    knowledgeResourceRepo.countByKnowledgeBase = mock(async () => 0);
    knowledgeBaseRepo.getById = mock(async () => kb({ metadata: null }));
    const update = mock(async () => undefined);
    knowledgeBaseRepo.update = update;

    await expect(listKnowledgeBases("org-1", "ignored")).resolves.toMatchObject([
      { embeddingModel: "embed", parseMethod: "builtin", chunkMethod: "book" },
    ]);
    expect(update).toHaveBeenCalledWith("kb-1", expect.objectContaining({ metadata: expect.any(Object) }));
  });

  // 单个 provider 失败不应阻塞其他已配置 provider 的展示。
  test("provider 树忽略单个 provider 查询失败", async () => {
    class PartialTreeProvider extends Provider {
      override async listConfiguredProviders() {
        return ["Broken", "Good"];
      }
      override async listProviderInstances({ provider }: { provider: string; apiKey: string }) {
        if (provider === "Broken") throw new Error("unavailable");
        return [{ provider, instanceName: "main", status: "active" }];
      }
      override async listInstanceModels() {
        return [{ name: "embed", status: "active" }];
      }
    }
    setKnowledgeProviderForTesting(new PartialTreeProvider());

    await expect(listConfiguredProviderTree("global", "user-1", "org-1")).resolves.toEqual([
      {
        provider: "Good",
        instances: [
          { provider: "Good", instanceName: "main", status: "active", models: [{ name: "embed", status: "active" }] },
        ],
      },
    ]);
  });

  // 未实现 factory 能力的 provider 应安全返回空数组。
  test("厂商列表在 provider 不支持时返回空数组", async () => {
    setKnowledgeProviderForTesting(new Provider());
    await expect(listEmbeddingFactories("global", "user-1", "org-1")).resolves.toEqual([]);
  });

  // 未实现状态切换能力时不应抛出或访问网络。
  test("模型状态切换在 provider 不支持时安全结束", async () => {
    setKnowledgeProviderForTesting(new Provider());
    await expect(
      setEmbeddingModelStatus("global", "user-1", "org-1", {
        provider: "OpenAI",
        instanceName: "main",
        modelName: "embed",
        status: "inactive",
      }),
    ).resolves.toBeUndefined();
  });

  // 未实现实例模型能力时管理页应得到空列表。
  test("实例模型列表在 provider 不支持时返回空数组", async () => {
    setKnowledgeProviderForTesting(new Provider());
    await expect(
      listInstanceEmbeddingModels("global", "user-1", "org-1", { provider: "OpenAI", instanceName: "main" }),
    ).resolves.toEqual([]);
  });

  // 未实现验证能力时应返回明确的业务失败结果。
  test("验证 provider 在能力缺失时返回默认失败", async () => {
    setKnowledgeProviderForTesting(new Provider());
    await expect(
      verifyEmbeddingProvider("global", "user-1", "org-1", { provider: "OpenAI", providerApiKey: "secret" }),
    ).resolves.toEqual({ success: false, message: "provider 不支持 verifyProviderConnection" });
  });

  // 未实现动态模型能力时应返回空数组。
  test("动态 embedding 模型在能力缺失时返回空数组", async () => {
    setKnowledgeProviderForTesting(new Provider());
    await expect(
      listProviderEmbeddingModels("global", "user-1", "org-1", { provider: "OpenAI", providerApiKey: "secret" }),
    ).resolves.toEqual([]);
  });

  // 实例重复冲突按幂等成功处理，避免用户重试失败。
  test("添加 provider 实例忽略已存在冲突", async () => {
    class ConflictProvider extends Provider {
      override async addProviderInstance() {
        throw new Error("already exists");
      }
    }
    setKnowledgeProviderForTesting(new ConflictProvider());

    await expect(
      addEmbeddingProvider("global", "user-1", "org-1", {
        provider: "OpenAI",
        instanceName: "main",
        providerApiKey: "secret",
      }),
    ).resolves.toEqual({ instanceName: "main" });
  });

  // 非冲突远端错误必须保留给调用方处理。
  test("添加 provider 实例透传非冲突错误", async () => {
    class FailingProvider extends Provider {
      override async addProviderInstance() {
        throw new Error("permission denied");
      }
    }
    setKnowledgeProviderForTesting(new FailingProvider());

    await expect(
      addEmbeddingProvider("global", "user-1", "org-1", {
        provider: "OpenAI",
        instanceName: "main",
        providerApiKey: "secret",
      }),
    ).rejects.toThrow("permission denied");
  });

  // 没有远端 ID 的历史记录只清理本地关联数据。
  test("删除无远端 ID 的知识库不调用 provider", async () => {
    const provider = new Provider();
    setKnowledgeProviderForTesting(provider);
    knowledgeBaseRepo.getById = mock(async () => kb({ remoteId: null }));
    agentKnowledgeBindingRepo.deleteByKnowledgeBaseId = mock(async () => undefined);
    knowledgeBaseRepo.delete = mock(async () => true);

    await expect(deleteKnowledgeBase("org-1", "kb-1")).resolves.toMatchObject({ success: true });
    expect(provider.deleted).toBeNull();
  });

  // 非“对象不存在”的远端删除失败不能误删本地数据。
  test("删除在远端权限错误时中止本地清理", async () => {
    class DeniedProvider extends Provider {
      override async deleteKnowledgeBase() {
        throw new Error("timeout");
      }
    }
    setKnowledgeProviderForTesting(new DeniedProvider());
    knowledgeBaseRepo.getById = mock(async () => kb());
    const remove = mock(async () => true);
    knowledgeBaseRepo.delete = remove;

    await expect(deleteKnowledgeBase("org-1", "kb-1")).rejects.toThrow("timeout");
    expect(remove).not.toHaveBeenCalled();
  });

  // 远端缺失错误识别应覆盖权限型幂等删除响应。
  test("远端缺失错误识别权限提示", () => {
    expect(isRemoteKnowledgeBaseMissingError(new Error("Don't own this dataset"))).toBe(true);
  });

  // 普通异常不能被误分类为可忽略的远端缺失。
  test("远端缺失错误不误判普通失败", () => {
    expect(isRemoteKnowledgeBaseMissingError(new Error("connection reset"))).toBe(false);
  });

  // touch 应保留显式 null 补丁并写入状态。
  test("touch 写入显式空错误和远端 ID", async () => {
    const update = mock(async () => undefined);
    knowledgeBaseRepo.update = update;

    await touchKnowledgeBaseUpdatedAt("kb-1", { status: "error", lastError: null, remoteId: null });

    expect(update).toHaveBeenCalledWith(
      "kb-1",
      expect.objectContaining({ status: "error", lastError: null, remoteId: null, updatedAt: expect.any(Date) }),
    );
  });

  // 资源错误优先级最高，应将知识库标记为 error。
  test("资源状态汇总优先标记错误", async () => {
    knowledgeResourceRepo.getStatusSummary = mock(async () => ({
      readyCount: 2,
      activeCount: 1,
      errorCount: 1,
      totalCount: 4,
    }));
    const update = mock(async () => undefined);
    knowledgeBaseRepo.update = update;

    await upsertKnowledgeBaseStatusFromResources("kb-1");

    expect(update).toHaveBeenCalledWith("kb-1", expect.objectContaining({ status: "error" }));
  });

  // 仅有已完成资源时应将知识库标记为 ready。
  test("资源状态汇总将已完成资源标记为 ready", async () => {
    knowledgeResourceRepo.getStatusSummary = mock(async () => ({
      readyCount: 1,
      activeCount: 0,
      errorCount: 0,
      totalCount: 1,
    }));
    const update = mock(async () => undefined);
    knowledgeBaseRepo.update = update;

    await upsertKnowledgeBaseStatusFromResources("kb-1");

    expect(update).toHaveBeenCalledWith("kb-1", expect.objectContaining({ status: "ready" }));
  });

  // 租户身份缺失或空白时必须回退到本地用户 ID。
  test("租户身份为缺失值时回退用户 ID", () => {
    expect(
      resolveKnowledgeTenantIdentity(kb({ userId: " user-1 ", remoteAccountId: " ", remoteUserId: null })),
    ).toEqual({ remoteAccountId: "user-1", remoteUserId: "user-1" });
  });
});
