import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

const apiModelsRoute = (await import("../routes/api/models")).default;

function request(path: string, init?: RequestInit) {
  return apiModelsRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API Models Routes", () => {
  beforeEach(() => {
    resetAllStubs();
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    stubConfigPg({
      listProviders: async () => [],
      getProvider: async () => null,
      getProviderById: async () => null,
      upsertProvider: async () => "provider-id",
      updateProviderById: async () => true,
      deleteProvider: async () => true,
      deleteProviderById: async () => true,
      assertProviderInternalWritable: async () => null,
      assertProviderInternalWritableById: async () => null,
      addModel: async () => "model-db-id",
      updateModel: async () => false,
      updateModelById: async () => false,
      removeModel: async () => true,
      removeModelById: async () => true,
    });
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
  });

  // Provider 列表接口应返回稳定分页结构，而不是裸 providers 数组。
  test("GET /api/models/providers returns paginated provider list", async () => {
    stubConfigPg({
      listProviders: async () => [
        {
          id: "provider-1",
          name: "openai",
          displayName: "OpenAI",
          protocol: "openai",
          baseUrl: "https://api.openai.com",
          modelCount: 3,
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "provider-1",
            resourceKey: "org-1/provider-1",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        },
      ],
    });

    const res = await request("/api/models/providers?page=1&pageSize=10");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      items: [
        {
          id: "provider-1",
          name: "openai",
          displayName: "OpenAI",
          protocol: "openai",
          baseUrl: "https://api.openai.com",
          modelCount: 3,
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "provider-1",
            resourceKey: "org-1/provider-1",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
  });

  // Model 创建接口应把 displayName/limitConfig 映射为服务层需要的 displayName/limitConfig 字段。
  test("POST /api/models/providers/:providerId/models maps public model fields to service data", async () => {
    const addModel = mock(async () => "model-db-id");

    stubConfigPg({
      assertProviderInternalWritableById: async () =>
        ({
          id: "provider-db-id",
          name: "openai",
          models: [],
        }) as never,
      addModel,
      getProviderById: async () =>
        ({
          id: "provider-db-id",
          name: "openai",
          displayName: "OpenAI",
          protocol: "openai",
          baseUrl: "https://api.openai.com",
          apiKey: "{env:RCS_SECRET_OPENAI}",
          extraOptions: null,
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "provider-db-id",
            resourceKey: "org-1/provider-db-id",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
          models: [
            {
              id: "model-db-id",
              modelId: "gpt-4.1",
              displayName: "GPT 4.1",
              modalities: ["text"],
              limitConfig: { context: 128000 },
              cost: { input: 1, output: 2 },
              options: { reasoning: "medium" },
            },
          ],
        }) as never,
    });

    const res = await request("/api/models/providers/provider-db-id/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelId: "gpt-4.1",
        displayName: "GPT 4.1",
        modalities: ["text"],
        limitConfig: { context: 128000 },
        cost: { input: 1, output: 2 },
        options: { reasoning: "medium" },
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(addModel).toHaveBeenCalledWith(
      { organizationId: "org-1", userId: "user-1", role: "owner" },
      "provider-db-id",
      {
        modelId: "gpt-4.1",
        displayName: "GPT 4.1",
        modalities: ["text"],
        limitConfig: { context: 128000 },
        cost: { input: 1, output: 2 },
        options: { reasoning: "medium" },
      },
    );
    expect(json).toEqual({
      providerId: "provider-db-id",
      id: "model-db-id",
      modelId: "gpt-4.1",
      providerName: "openai",
      displayName: "GPT 4.1",
      modalities: ["text"],
      limitConfig: { context: 128000 },
      cost: { input: 1, output: 2 },
      options: { reasoning: "medium" },
    });
  });

  // Provider 详情接口不应泄露敏感的 API Key 字段。
  test("GET /api/models/providers/:providerId does not expose apiKey", async () => {
    stubConfigPg({
      getProviderById: async () =>
        ({
          id: "provider-db-id",
          name: "openai",
          displayName: "OpenAI",
          protocol: "openai",
          baseUrl: "https://api.openai.com",
          apiKey: "sk-secret-should-not-leak",
          extraOptions: { region: "us" },
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "provider-db-id",
            resourceKey: "org-1/provider-db-id",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
          models: [],
        }) as never,
    });

    const res = await request("/api/models/providers/provider-db-id");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "provider-db-id",
      name: "openai",
      displayName: "OpenAI",
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      extraOptions: { region: "us" },
      models: [],
      resourceAccess: {
        ownership: "internal",
        sourceOrganizationId: "org-1",
        resourceUid: "provider-db-id",
        resourceKey: "org-1/provider-db-id",
        manageable: true,
        writable: true,
        publicReadable: false,
      },
    });
    expect("apiKey" in json).toBe(false);
  });

  // Provider 更新接口应保持同一条资源，只更新字段而不是按 providerId 新建新资源。
  test("PUT /api/models/providers/:providerId updates the same provider by id", async () => {
    const updateProviderById = mock(async () => true);

    stubConfigPg({
      assertProviderInternalWritableById: async () =>
        ({
          id: "provider-db-id",
          name: "openai",
          displayName: "OpenAI",
          protocol: "openai",
          baseUrl: "https://api.openai.com",
          apiKey: "{env:RCS_SECRET_OPENAI}",
          extraOptions: { region: "us" },
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "provider-db-id",
            resourceKey: "org-1/provider-db-id",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
          models: [],
        }) as never,
      updateProviderById,
      getProviderById: async () =>
        ({
          id: "provider-db-id",
          name: "openai",
          displayName: "OpenAI Updated",
          protocol: "openai",
          baseUrl: "https://api.openai.com/v2",
          apiKey: "{env:RCS_SECRET_OPENAI}",
          extraOptions: { region: "updated" },
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "provider-db-id",
            resourceKey: "org-1/provider-db-id",
            manageable: true,
            writable: true,
            publicReadable: true,
          },
          models: [],
        }) as never,
    });

    const res = await request("/api/models/providers/provider-db-id", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "OpenAI Updated",
        baseUrl: "https://api.openai.com/v2",
        extraOptions: { region: "updated" },
        publicReadable: true,
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(updateProviderById).toHaveBeenCalledWith(
      { organizationId: "org-1", userId: "user-1", role: "owner" },
      "provider-db-id",
      {
        displayName: "OpenAI Updated",
        protocol: "openai",
        baseUrl: "https://api.openai.com/v2",
        apiKey: undefined,
        extraOptions: { region: "updated" },
      },
      { publicReadable: true },
    );
    expect(json).toEqual({
      id: "provider-db-id",
      name: "openai",
      displayName: "OpenAI Updated",
      protocol: "openai",
      baseUrl: "https://api.openai.com/v2",
      extraOptions: { region: "updated" },
      models: [],
      resourceAccess: {
        ownership: "internal",
        sourceOrganizationId: "org-1",
        resourceUid: "provider-db-id",
        resourceKey: "org-1/provider-db-id",
        manageable: true,
        writable: true,
        publicReadable: true,
      },
    });
  });
});
