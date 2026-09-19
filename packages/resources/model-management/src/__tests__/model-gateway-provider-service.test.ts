import { describe, expect, test } from "bun:test";
import type { ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import {
  createModelGatewayAdapterRegistry,
  createSystemModelGatewayProviderService,
  type ModelGatewayModelSyncDeps,
  type ProviderRow,
  type ProviderService,
  providerResource,
  type ScopedProviderRow,
} from "@fenix/model-management/server";
import {
  type AccessControlModule,
  type ActorContext,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceQueryConstraint,
  type SystemTenant,
} from "@fenix/platform-sdk";

const fakeAdapter: ModelGatewayAdapter = {
  type: "litellm",
  checkHealth: async () => ({ status: "healthy" }),
  listModels: async () => [],
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
  blockCredential: async () => undefined,
  queryUsage: async () => ({ totalSpendUsd: 0, records: [] }),
};

const systemTenant: SystemTenant = {
  organizationId: "system-org-id",
  organizationSlug: "admin",
  userId: "system-admin-id",
  email: "admin@fenix.com",
};

/** 构造平台授权条件句柄；形状与 `DefaultAccessControl` 产出的条件一致（含私有载荷键）。 */
function testListConstraint(action: "read" | "use" = "read"): ResourceQueryConstraint {
  return {
    resourceType: providerResource.definition.type,
    action,
    provider: "test-access-control",
    [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: { action },
  };
}

/** 构造 Provider 行；默认是系统网关自己的那一行。 */
function providerRow(overrides: Partial<ProviderRow> = {}): ScopedProviderRow {
  return {
    id: "provider-id",
    userId: systemTenant.userId,
    organizationId: systemTenant.organizationId,
    name: "fenix-model-gateway",
    displayName: "模型网关",
    kind: "gateway",
    gatewayType: "litellm",
    protocol: "openai",
    baseUrl: "http://litellm.test",
    apiKey: null,
    extraOptions: null,
    visibility: "public",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    scope: {
      organizationId: systemTenant.organizationId,
      ownerUserId: systemTenant.userId,
      visibility: "public",
    },
    ...overrides,
  };
}

/**
 * 构造编排用例的依赖替身。
 *
 * 只实现被本文件覆盖的方法；未覆盖的方法抛错而不是返回空值——静默的成功会掩盖误用的调用点。
 * 记录 `createListConstraint` 收到的 actor，用来锁定"系统路径用系统租户 owner、不用 super-admin"。
 */
function createDeps(overrides: Partial<ModelGatewayModelSyncDeps> = {}) {
  const createCalls: Array<Parameters<ProviderService["create"]>[0]> = [];
  const constraintActors: ActorContext[] = [];
  let row: ScopedProviderRow | undefined;

  const accessControl: AccessControlModule = {
    id: "test-access-control",
    resolveInitialScope: async () => {
      throw new Error("not used in this test");
    },
    initializeResourceAccess: async () => undefined,
    authorize: async () => undefined,
    createListConstraint: async ({ actor, action }) => {
      constraintActors.push(actor);
      return testListConstraint(action);
    },
    resolveAccess: async () => ({ actions: ["read"] }),
    resolveAccessMany: async ({ resourceIds }) => new Map(resourceIds.map((id) => [id, { actions: ["read"] }])),
  };

  const service: ProviderService = {
    list: async () => {
      throw new Error("not used in this test");
    },
    findById: async () => row,
    findByName: async () => row,
    findByResourceKey: async () => row,
    create: async (input) => {
      createCalls.push(input);
      row = providerRow({ id: "provider-id" });
      return "provider-id";
    },
    update: async () => true,
    remove: async () => true,
    findRowUnscoped: async () => row,
  };

  const deps: ModelGatewayModelSyncDeps = {
    resolveSystemTenant: async () => systemTenant,
    service,
    models: {
      listByProviderId: async () => [],
      countByProviderIds: async () => new Map(),
      findById: async () => undefined,
      findByModelId: async () => undefined,
      upsert: async () => undefined,
      updateById: async () => true,
      updateByModelId: async () => true,
      removeById: async () => true,
      removeByModelId: async () => true,
    },
    accessControl,
    adapter: fakeAdapter,
    invalidateModelCache: () => {},
    withModelSyncLock: async (fn) => fn(),
    ...overrides,
  };

  return { deps, createCalls, constraintActors, setRow: (next: ScopedProviderRow | undefined) => (row = next) };
}

describe("model gateway provider service", () => {
  // 验证 Gateway Provider 的运行配置缺失时立即失败，避免隐式连接到错误的默认网关。
  test("requires an explicit gateway base URL and type", () => {
    expect(() => createSystemModelGatewayProviderService({}, undefined as never)).toThrow(
      "model gateway provider options are required",
    );
    expect(() => createSystemModelGatewayProviderService({}, { baseUrl: "", gatewayType: "litellm" })).toThrow(
      "model gateway provider baseUrl is required",
    );
    expect(() =>
      createSystemModelGatewayProviderService({}, { baseUrl: "http://litellm.test", gatewayType: "" }),
    ).toThrow("model gateway provider gatewayType is required");
  });

  // 验证网关类型只能从已注册 Adapter 中解析，避免配置拼写错误进入运行时。
  test("resolves registered adapters and rejects unknown types", () => {
    const registry = createModelGatewayAdapterRegistry([fakeAdapter]);

    expect(registry.get("litellm")).toBe(fakeAdapter);
    expect(() => registry.get("unknown")).toThrow("unsupported model gateway type: unknown");
  });

  // 验证系统 Gateway Provider 固定归属和业务类型，并且重复初始化不会创建第二个 Provider。
  test("initializes one public system gateway provider idempotently", async () => {
    const { deps, createCalls } = createDeps();
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://litellm.test",
      gatewayType: "litellm",
    });

    await service.ensureProvider();
    await service.ensureProvider();

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toEqual({
      name: "fenix-model-gateway",
      data: {
        displayName: "全局模型网关",
        kind: "gateway",
        gatewayType: "litellm",
        protocol: "openai",
        baseUrl: "http://litellm.test",
        apiKey: null,
      },
      organizationId: "system-org-id",
      ownerUserId: "system-admin-id",
      // 公开读在创建期一次写入，替代迁移前"先建行再 setPublicRead 补写"的两步。
      visibility: "public",
    });
  });

  // 验证系统路径的授权主体是系统租户的 owner：带全量成员关系，且不依赖 super-admin 分支（决策 D8）。
  test("reads through the system tenant owner without super-admin privileges", async () => {
    const { deps, constraintActors } = createDeps();
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://litellm.test",
      gatewayType: "litellm",
    });

    await service.ensureProvider();

    expect(constraintActors).toHaveLength(1);
    expect(constraintActors[0]).toEqual({
      kind: "user",
      userId: "system-admin-id",
      activeOrganizationId: "system-org-id",
      memberships: [{ organizationId: "system-org-id", role: "owner" }],
    });
    expect(constraintActors[0].systemRole).toBeUndefined();
  });

  // 验证查询路径确保 Provider 存在时不覆盖已保存的展示名、公开地址等配置投影。
  test("preserves an existing provider configuration when ensuring it exists", async () => {
    const { deps, createCalls, setRow } = createDeps();
    setRow(providerRow());
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://litellm.test",
      gatewayType: "litellm",
    });

    await expect(service.ensureProvider()).resolves.toBe("provider-id");
    expect(createCalls).toHaveLength(0);
  });

  // 验证同名行不是网关类型时立即失败，避免把用户 Provider 当成系统网关改写。
  test("rejects an existing system provider that is not a gateway", async () => {
    const { deps, setRow } = createDeps();
    setRow(providerRow({ kind: "direct", gatewayType: null, visibility: "private" }));
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://litellm.test",
      gatewayType: "litellm",
    });

    await expect(service.ensureProvider()).rejects.toThrow("system model gateway provider has an invalid kind");
  });

  // 验证模型状态检查同时返回 Gateway Provider 摘要，供系统管理概览展示真实连接信息。
  test("returns gateway provider summary with model sync status", async () => {
    const { deps, setRow } = createDeps();
    setRow(providerRow());
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://litellm.test",
      gatewayType: "litellm",
    });

    await expect(service.checkModels("provider-id")).resolves.toMatchObject({
      status: "synced",
      changes: [],
      provider: {
        id: "provider-id",
        name: "fenix-model-gateway",
        displayName: "模型网关",
        gatewayType: "litellm",
        baseUrl: "http://litellm.test",
        modelCount: 0,
        owner: { email: "admin@fenix.com", organizationSlug: "admin" },
      },
    });
  });

  // 验证上游不可达时检查返回 unknown 而不是抛错，让人工同步入口能给出可诊断的失败结果。
  test("reports an unknown status when the adapter is unreachable", async () => {
    const { deps, setRow } = createDeps({
      adapter: {
        ...fakeAdapter,
        listModels: async () => {
          throw new Error("litellm unreachable");
        },
      },
    });
    setRow(providerRow());
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://litellm.test",
      gatewayType: "litellm",
    });

    await expect(service.checkModels("provider-id")).resolves.toMatchObject({
      status: "unknown",
      changes: [],
      error: "litellm unreachable",
    });
  });

  // 验证上游地址与本地配置不一致时检查标记为待同步，且给出明确的变更原因。
  test("flags a pending sync when the gateway base URL changed", async () => {
    const { deps, setRow } = createDeps();
    setRow(providerRow({ baseUrl: "http://old-litellm.test" }));
    const service = createSystemModelGatewayProviderService(deps, {
      baseUrl: "http://litellm.test",
      gatewayType: "litellm",
    });

    await expect(service.checkModels("provider-id")).resolves.toMatchObject({
      status: "pending",
      providerBaseUrlChanged: true,
    });
  });
});
