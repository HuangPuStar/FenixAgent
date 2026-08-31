import { describe, expect, test } from "bun:test";
import type { GatewayModel, ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import type { AuthContext } from "../plugins/auth";
import type { ModelUpsertData } from "../services/config/types";
import {
  createSystemModelGatewayProviderService,
  type ModelGatewayModelSyncDeps,
} from "../services/model-gateway/provider-service";

const adminContext = {
  organizationId: "admin-org",
  userId: "admin-user",
  role: "owner" as const,
};

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

function createDeps(overrides: Partial<ModelGatewayModelSyncDeps> = {}) {
  const writes: string[] = [];
  const deps = {
    ensureSystemAdmin: async () => ({
      userId: adminContext.userId,
      organization: { id: adminContext.organizationId },
    }),
    upsertProvider: async () => "gateway-provider",
    setPublicRead: async () => {},
    getProviderById: async () => ({
      id: "gateway-provider",
      organizationId: adminContext.organizationId,
      kind: "gateway",
      gatewayType: "litellm",
      models: [
        {
          id: "model-row-1",
          modelId: "old-model",
          displayName: "旧模型",
        },
        {
          id: "model-row-2",
          modelId: "removed-model",
          displayName: "待删除",
        },
      ],
    }),
    adapter: createAdapter([
      { id: "old-model", displayName: "新名称" },
      { id: "new-model", displayName: "新模型" },
    ]),
    addModel: async (_ctx: AuthContext, _providerId: string, data: { modelId: string } & ModelUpsertData) => {
      writes.push(`add:${data.modelId}`);
      return "new-row";
    },
    updateModel: async (_ctx: AuthContext, _providerId: string, modelId: string, data: ModelUpsertData) => {
      writes.push(`update:${modelId}:${data.displayName}`);
      return true;
    },
    removeModel: async (_ctx: AuthContext, _providerId: string, modelId: string) => {
      writes.push(`remove:${modelId}`);
      return true;
    },
    invalidateModelCache: () => writes.push("invalidate"),
    ...overrides,
  } as unknown as ModelGatewayModelSyncDeps;
  return { deps, writes };
}

describe("model gateway model sync", () => {
  // 验证只读检查能够计算模型增删改差异且不写本地投影。
  test("状态检查返回增删改差异且不写入 Fenix", async () => {
    const { deps, writes } = createDeps();
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://gateway",
      gatewayType: "litellm",
    });

    const result = await service.checkModels("gateway-provider");

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
    const { deps, writes } = createDeps({
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

    const result = await service.checkModels("gateway-provider");

    expect(result).toEqual({
      status: "unknown",
      changes: [],
      error: "gateway unavailable",
    });
    expect(writes).toEqual([]);
  });

  // 验证显式同步会重新读取目录、更新投影并刷新模型缓存。
  test("手动同步重新读取网关目录并处理增删改，完成后刷新模型缓存", async () => {
    const { deps, writes } = createDeps();
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

    const result = await service.syncModels("gateway-provider");

    expect(result).toEqual({ added: 1, updated: 1, removed: 1 });
    expect(lockRuns).toBe(1);
    expect(writes).toEqual(["update:old-model:新名称", "add:new-model", "remove:removed-model", "invalidate"]);
  });

  // 验证同步失败不会误删或刷新现有模型投影。
  test("手动同步失败时保留现有投影且不刷新缓存", async () => {
    const { deps, writes } = createDeps({
      adapter: {
        ...createAdapter([]),
        listModels: async () => {
          throw new Error("sync failed");
        },
      },
    });
    const service = createSystemModelGatewayProviderService(
      { ...deps, withModelSyncLock: async (fn) => fn() },
      {
        baseUrl: "http://gateway",
        gatewayType: "litellm",
      },
    );

    await expect(service.syncModels("gateway-provider")).rejects.toThrow("sync failed");
    expect(writes).toEqual([]);
  });
});
