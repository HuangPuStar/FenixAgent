import { describe, expect, test } from "bun:test";
import type { ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import { getProviderById } from "../services/config/provider";
import type { ProviderUpsertData } from "../services/config/types";
import { createModelGatewayAdapterRegistry } from "../services/model-gateway/adapter-registry";
import { createSystemModelGatewayProviderService } from "../services/model-gateway/provider-service";

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
    const calls: Array<{ name: string; data: ProviderUpsertData }> = [];
    const publicReadCalls: string[] = [];
    const service = createSystemModelGatewayProviderService(
      {
        ensureSystemAdmin: async () => ({
          created: false,
          userId: "system-admin-id",
          email: "admin@fenix.com",
          organization: { id: "system-org-id", slug: "admin" },
        }),
        upsertProvider: async (_ctx, name, data) => {
          calls.push({ name, data });
          return "provider-id";
        },
        getProvider: async () => (calls.length > 0 ? ({ id: "provider-id", kind: "gateway" } as never) : null),
        setPublicRead: async (_ctx, _resourceType, _organizationId, providerId) => {
          publicReadCalls.push(providerId);
          return true;
        },
      },
      {
        baseUrl: "http://litellm.test",
        gatewayType: "litellm",
      },
    );

    await service.ensureProvider();
    await service.ensureProvider();

    expect(calls).toHaveLength(1);
    expect(publicReadCalls).toEqual(["provider-id"]);
    expect(calls[0]).toEqual({
      name: "fenix-model-gateway",
      data: {
        displayName: "全局模型网关",
        kind: "gateway",
        gatewayType: "litellm",
        protocol: "openai",
        baseUrl: "http://litellm.test",
        apiKey: null,
      },
    });
  });

  // 验证查询路径确保 Provider 存在时不覆盖已保存的展示名、公开地址等配置投影。
  test("preserves an existing provider configuration when ensuring it exists", async () => {
    let upsertCount = 0;
    let publicReadCount = 0;
    const service = createSystemModelGatewayProviderService(
      {
        ensureSystemAdmin: async () => ({
          created: false,
          userId: "system-admin-id",
          email: "admin@fenix.com",
          organization: { id: "system-org-id", slug: "admin" },
        }),
        getProvider: async () => ({ id: "provider-id", kind: "gateway" }) as never,
        upsertProvider: async () => {
          upsertCount += 1;
          return "provider-id";
        },
        setPublicRead: async () => {
          publicReadCount += 1;
          return true;
        },
      },
      { baseUrl: "http://litellm.test", gatewayType: "litellm" },
    );

    await expect(service.ensureProvider()).resolves.toBe("provider-id");
    expect(upsertCount).toBe(0);
    expect(publicReadCount).toBe(0);
  });

  // 验证模型状态检查同时返回 Gateway Provider 摘要，供系统管理概览展示真实连接信息。
  test("returns gateway provider summary with model sync status", async () => {
    const service = createSystemModelGatewayProviderService(
      {
        ensureSystemAdmin: async () => ({
          created: false,
          userId: "system-admin-id",
          email: "admin@fenix.com",
          organization: { id: "system-org-id", slug: "admin" },
        }),
        getProviderById: async () =>
          ({
            id: "provider-id",
            userId: "system-admin-id",
            organizationId: "system-org-id",
            name: "fenix-model-gateway",
            displayName: "模型网关",
            kind: "gateway" as const,
            gatewayType: "litellm",
            protocol: "openai" as const,
            baseUrl: "http://litellm.test",
            apiKey: null,
            extraOptions: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            resourceAccess: {
              ownership: "internal" as const,
              sourceOrganizationId: "system-org-id",
              resourceUid: "provider-id",
              resourceKey: "system-org-id/provider-id",
              manageable: true,
              writable: true,
              publicReadable: true,
            },
            models: [],
          }) satisfies Awaited<ReturnType<typeof getProviderById>> extends infer Provider
            ? Exclude<Provider, null>
            : never,
        adapter: { ...fakeAdapter, listModels: async () => [] },
      },
      { baseUrl: "http://litellm.test", gatewayType: "litellm" },
    );

    await expect(service.checkModels("provider-id")).resolves.toMatchObject({
      status: "synced",
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
});
