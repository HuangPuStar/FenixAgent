import { describe, expect, test } from "bun:test";
import type { GatewayModel, ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import {
  createSystemModelGatewayProviderService,
  type ModelGatewayModelSyncDeps,
  type ModelRepository,
  type ModelRow,
  type ModelWriteData,
  type ProviderService,
  providerResource,
  type ScopedProviderRow,
} from "@fenix/model-management/server";
import type { AccessControlModule, ActorContext, ResourceQueryConstraint } from "@fenix/platform-sdk";
import { RESOURCE_QUERY_CONSTRAINT_PAYLOAD } from "@fenix/platform-sdk";

const GATEWAY_PROVIDER_ID = "gateway-provider";
const SYSTEM_ORG_ID = "admin-org";

function createAdapter(models: GatewayModel[]): ModelGatewayAdapter {
  return {
    type: "litellm",
    checkHealth: async () => ({ status: "healthy" }),
    listModels: async () => models,
    ensureUser: async () => ({ externalId: "user-1" }),
    getUserBudget: async () => ({
      maxBudgetUsd: null,
      duration: null,
      spendUsd: 0,
      resetAt: null,
    }),
    listUserBudgets: async () => [],
    updateUserBudget: async () => ({
      maxBudgetUsd: null,
      duration: null,
      spendUsd: 0,
      resetAt: null,
    }),
    createCredential: async () => ({ externalId: "key-1", secret: "secret" }),
    blockCredential: async () => {},
    queryUsage: async () => ({ totalSpendUsd: 0, records: [] }),
  };
}

/** 构造本地投影里的模型行；只填差异计算用到的列。 */
function modelRow(overrides: Partial<ModelRow> & { modelId: string }): ModelRow {
  return {
    id: `row-${overrides.modelId}`,
    providerId: GATEWAY_PROVIDER_ID,
    organizationId: SYSTEM_ORG_ID,
    displayName: null,
    modalities: null,
    limitConfig: null,
    cost: null,
    options: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** 系统网关 Provider 行（`syncModels` 会读它的归属组织与 baseUrl）。 */
function gatewayProviderRow(): ScopedProviderRow {
  return {
    id: GATEWAY_PROVIDER_ID,
    userId: "admin-user",
    organizationId: SYSTEM_ORG_ID,
    name: "fenix-model-gateway",
    displayName: "全局模型网关",
    kind: "gateway",
    gatewayType: "litellm",
    protocol: "openai",
    baseUrl: "http://gateway",
    apiKey: null,
    extraOptions: null,
    visibility: "public",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    scope: { organizationId: SYSTEM_ORG_ID, ownerUserId: "admin-user", visibility: "public" },
  };
}

/**
 * 构造同步编排的依赖替身，并记录子表写入。
 *
 * `localModels` 是本地投影的当前状态；写入记录按 `动作:模型` 顺序累积，用来断言差异被正确落库。
 */
function createDeps(
  remoteModels: GatewayModel[],
  localModels: ModelRow[] = [
    modelRow({ modelId: "old-model", displayName: "旧模型" }),
    modelRow({ modelId: "removed-model", displayName: "待删除" }),
  ],
  overrides: Partial<ModelGatewayModelSyncDeps> = {},
) {
  const writes: string[] = [];
  const actor: ActorContext = {
    kind: "user",
    userId: "admin-user",
    activeOrganizationId: SYSTEM_ORG_ID,
    memberships: [{ organizationId: SYSTEM_ORG_ID, role: "owner" }],
  };

  const accessControl: AccessControlModule = {
    id: "test-access-control",
    resolveInitialScope: async () => {
      throw new Error("not used in this test");
    },
    initializeResourceAccess: async () => undefined,
    authorize: async () => undefined,
    createListConstraint: async (): Promise<ResourceQueryConstraint> => ({
      resourceType: providerResource.definition.type,
      action: "read",
      provider: "test-access-control",
      [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: { action: "read" },
    }),
    resolveAccess: async () => ({ actions: ["read"] }),
    resolveAccessMany: async ({ resourceIds }) => new Map(resourceIds.map((id) => [id, { actions: ["read"] }])),
  };

  const service: ProviderService = {
    list: async () => ({ items: [], total: 0 }),
    findById: async () => gatewayProviderRow(),
    findByName: async () => gatewayProviderRow(),
    findByResourceKey: async () => gatewayProviderRow(),
    create: async () => GATEWAY_PROVIDER_ID,
    // 网关地址未变化时同步不应改写配置行，因此这里只记录而不产生额外写入。
    update: async (input) => {
      writes.push(`provider-update:${input.data.baseUrl}`);
      return true;
    },
    remove: async () => true,
    findRowUnscoped: async () => gatewayProviderRow(),
  };

  const models: ModelRepository = {
    listByProviderId: async () => localModels,
    countByProviderIds: async () => new Map(),
    findById: async () => undefined,
    findByModelId: async () => undefined,
    upsert: async (input) => {
      writes.push(`add:${input.modelId}`);
      return `row-${input.modelId}`;
    },
    updateById: async () => true,
    updateByModelId: async (input) => {
      writes.push(`update:${input.modelId}:${(input.data as ModelWriteData).displayName}`);
      return true;
    },
    removeById: async () => true,
    removeByModelId: async (input) => {
      writes.push(`remove:${input.modelId}`);
      return true;
    },
  };

  const deps: ModelGatewayModelSyncDeps = {
    resolveSystemTenant: async () => ({
      organizationId: SYSTEM_ORG_ID,
      organizationSlug: "admin",
      userId: "admin-user",
      email: "admin@fenix.com",
    }),
    service,
    models,
    accessControl,
    adapter: createAdapter(remoteModels),
    invalidateModelCache: () => writes.push("invalidate"),
    withModelSyncLock: async (fn) => fn(),
    ...overrides,
  };
  return { deps, writes, actor };
}

describe("model gateway model sync", () => {
  // 验证只读检查能够计算模型增删改差异且不写本地投影。
  test("状态检查返回增删改差异且不写入 Fenix", async () => {
    const { deps, writes } = createDeps([
      { id: "old-model", displayName: "新名称" },
      { id: "new-model", displayName: "新模型" },
    ]);
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://gateway",
      gatewayType: "litellm",
    });

    const result = await service.checkModels(GATEWAY_PROVIDER_ID);

    expect(result.status).toBe("pending");
    expect(result.changes).toEqual([
      { modelId: "old-model", kind: "updated", displayName: "新名称" },
      { modelId: "new-model", kind: "added", displayName: "新模型" },
      { modelId: "removed-model", kind: "removed", displayName: "待删除" },
    ]);
    expect(writes).toEqual([]);
  });

  // 验证网关不可用时返回未知状态，并保留本地模型数据。
  test("网关查询失败时返回 unknown 且不改动本地投影", async () => {
    const { deps, writes } = createDeps([], undefined, {
      adapter: {
        ...createAdapter([]),
        listModels: async () => {
          throw new Error("gateway unavailable");
        },
      },
    });
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://gateway",
      gatewayType: "litellm",
    });

    const result = await service.checkModels(GATEWAY_PROVIDER_ID);

    expect(result).toEqual({
      status: "unknown",
      changes: [],
      error: "gateway unavailable",
    });
    expect(writes).toEqual([]);
  });

  // 验证显式同步会重新读取目录、更新投影并刷新模型缓存。
  test("手动同步重新读取网关目录并处理增删改，完成后刷新模型缓存", async () => {
    const { deps, writes } = createDeps([
      { id: "old-model", displayName: "新名称" },
      { id: "new-model", displayName: "新模型" },
    ]);
    let lockRuns = 0;
    const service = createSystemModelGatewayProviderService(
      {
        ...deps,
        withModelSyncLock: async (fn) => {
          lockRuns += 1;
          return fn();
        },
      },
      { baseUrl: "http://gateway", gatewayType: "litellm" },
    );

    const result = await service.syncModels(GATEWAY_PROVIDER_ID);

    expect(result).toEqual({ added: 1, updated: 1, removed: 1 });
    expect(lockRuns).toBe(1);
    // 地址未变化，因此不应改配置行；只落子表差异并失效缓存。
    expect(writes).toEqual(["update:old-model:新名称", "add:new-model", "remove:removed-model", "invalidate"]);
  });

  // 验证同步失败不会误删或刷新现有模型投影。
  test("手动同步失败时保留现有投影且不刷新缓存", async () => {
    const { deps, writes } = createDeps([], undefined, {
      adapter: {
        ...createAdapter([]),
        listModels: async () => {
          throw new Error("sync failed");
        },
      },
    });
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://gateway",
      gatewayType: "litellm",
    });

    await expect(service.syncModels(GATEWAY_PROVIDER_ID)).rejects.toThrow("sync failed");
    expect(writes).toEqual([]);
  });

  // 验证上游地址变化时同步会把新配置写回 Provider 行，避免检查永远停留在 pending。
  test("上游地址变化时同步写回 Provider 配置", async () => {
    const { deps, writes } = createDeps([{ id: "only-model", displayName: "只有这个" }], []);
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://new-gateway",
      gatewayType: "litellm",
    });

    const result = await service.syncModels(GATEWAY_PROVIDER_ID);

    expect(result).toEqual({ added: 1, updated: 0, removed: 0 });
    expect(writes).toEqual(["provider-update:http://new-gateway", "add:only-model", "invalidate"]);
  });
});
