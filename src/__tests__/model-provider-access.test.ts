import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import modelsRoute, { invalidateAvailableCache } from "../routes/web/config/models";
import providersRoute from "../routes/web/config/providers";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

const internalAccess = {
  ownership: "internal" as const,
  sourceOrganizationId: "org_current",
  resourceUid: "provider_internal",
  resourceKey: "org_current/provider_internal",
  manageable: true,
  writable: true,
  publicReadable: false,
};

const externalAccess = {
  ownership: "external" as const,
  sourceOrganizationId: "org_source",
  sourceOrganizationName: "Source Team",
  resourceUid: "provider_external",
  resourceKey: "org_source/provider_external",
  manageable: false,
  writable: false,
};

const providers = {
  internal: {
    id: "provider_internal",
    name: "openai",
    displayName: "OpenAI",
    protocol: "openai",
    baseUrl: "https://internal.example.com",
    apiKey: "internal-key",
    extraOptions: null,
    resourceAccess: internalAccess,
    models: [
      {
        id: "model_internal",
        providerId: "provider_internal",
        organizationId: "org_current",
        modelId: "gpt-4o",
        displayName: "GPT-4o",
        modalities: null,
        limitConfig: null,
        cost: null,
        options: null,
        providerResourceAccess: internalAccess,
      },
    ],
  },
  external: {
    id: "provider_external",
    name: "openai",
    displayName: "OpenAI Shared",
    protocol: "openai",
    baseUrl: "https://external.example.com",
    apiKey: "external-key",
    extraOptions: null,
    resourceAccess: externalAccess,
    models: [
      {
        id: "model_external",
        providerId: "provider_external",
        organizationId: "org_source",
        modelId: "shared-model",
        displayName: "Shared Model",
        modalities: null,
        limitConfig: { context: 128000, output: 4096 },
        cost: null,
        options: null,
        providerResourceAccess: externalAccess,
      },
    ],
  },
};

let userConfig = {
  defaultAgent: null as string | null,
  currentModel: null as string | null,
  smallModel: null as string | null,
  permission: null as unknown,
};

function post(body: unknown, path: "providers" | "models") {
  const route = path === "providers" ? providersRoute : modelsRoute;
  return route.handle(
    new Request(`http://localhost/config/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("model provider access", () => {
  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
  });

  beforeEach(() => {
    resetAllStubs();
    invalidateAvailableCache();
    userConfig = { defaultAgent: null, currentModel: null, smallModel: null, permission: null };
    setTestAuth({
      user: { id: "user_owner", email: "owner@test.com", name: "Owner" },
      authContext: { organizationId: "org_current", userId: "user_owner", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org_current", userId: "user_owner", role: "owner" });
    stubConfigPg({
      listProviders: async () => [
        {
          ...providers.internal,
          modelCount: providers.internal.models.length,
          resourceKey: internalAccess.resourceKey,
        },
        {
          ...providers.external,
          modelCount: providers.external.models.length,
          resourceKey: externalAccess.resourceKey,
        },
      ],
      getProvider: async (_ctx, name: string) => {
        if (name === "openai") return providers.internal;
        if (name === externalAccess.resourceKey) return providers.external;
        if (name === internalAccess.resourceKey) return providers.internal;
        return null;
      },
      getProviderByResourceKey: async (_ctx, resourceKey: string) => {
        if (resourceKey === externalAccess.resourceKey) return providers.external;
        if (resourceKey === internalAccess.resourceKey) return providers.internal;
        return null;
      },
      assertProviderInternalWritable: async (_ctx, name: string) => {
        if (name === externalAccess.resourceKey || name === "external") {
          throw new AppError("External provider is read-only", "FORBIDDEN", 403);
        }
        return providers.internal;
      },
      addModel: async () => undefined,
      updateModel: async () => true,
      removeModel: async () => true,
      getUserConfig: async () => ({ ...userConfig }),
      setUserConfig: async (_ctx, patch) => {
        if (patch.currentModel !== undefined) userConfig.currentModel = patch.currentModel;
        if (patch.smallModel !== undefined) userConfig.smallModel = patch.smallModel;
        if (patch.permission !== undefined) userConfig.permission = patch.permission;
      },
    });
  });

  // 外部 provider 下的 models 会进入 available，并携带来源 provider 的只读状态
  test("外部 provider models 出现在 available 中", async () => {
    const res = await post({ action: "get" }, "models");
    const json = await res.json();

    const externalModel = json.data.available.find((item: { id: string }) => item.id === "shared-model");
    expect(externalModel).toMatchObject({
      provider: "OpenAI Shared",
      fullId: "OpenAI Shared/shared-model",
      stableFullId: "org_source/provider_external/shared-model",
      providerResourceKey: "org_source/provider_external",
    });
    expect(externalModel.providerResourceAccess.writable).toBe(false);
  });

  // 外部 provider 下的 add/update/remove model 写操作返回 403
  test("外部 provider 拒绝 add/update/remove model", async () => {
    const add = await post(
      { action: "add_model", name: externalAccess.resourceKey, data: { modelId: "new" } },
      "providers",
    );
    const update = await post(
      { action: "update_model", name: externalAccess.resourceKey, modelId: "shared-model", data: { name: "Next" } },
      "providers",
    );
    const remove = await post(
      { action: "remove_model", name: externalAccess.resourceKey, modelId: "shared-model" },
      "providers",
    );

    expect(add.status).toBe(403);
    expect(update.status).toBe(403);
    expect(remove.status).toBe(403);
  });

  // handleSet 可保存可读外部 stable model ref
  test("handleSet 可保存可读外部 model ref", async () => {
    const res = await post({ action: "set", data: { model: "org_source/provider_external/shared-model" } }, "models");
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(userConfig.currentModel).toBe("org_source/provider_external/shared-model");
  });

  // handleSet 拒绝不可读 provider 或不存在 model ref
  test("handleSet 拒绝不可读 provider model ref", async () => {
    const res = await post({ action: "set", data: { model: "org_missing/provider_missing/model" } }, "models");
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });
});
