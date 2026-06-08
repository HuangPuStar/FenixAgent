import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import modelsRoute from "../routes/web/config/models";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

// In-memory store for stub implementations
let _userConfig: {
  defaultAgent: string | null;
  currentModel: string | null;
  smallModel: string | null;
  permission: unknown;
} = { defaultAgent: null, currentModel: null, smallModel: null, permission: null };
let _providers: Map<string, { id: string; name: string; models: Map<string, Record<string, unknown>> }> = new Map();

function internalAccess(id: string) {
  return {
    ownership: "internal" as const,
    sourceOrganizationId: "test-team",
    resourceUid: id,
    resourceKey: `test-team/${id}`,
    manageable: true,
    writable: true,
    publicReadable: false,
  };
}

function seedModel(providerName: string, modelId: string, displayName = modelId) {
  const providerId = `prov-${providerName}`;
  _providers.set(providerName, {
    id: providerId,
    name: providerName,
    models: new Map([[modelId, { id: `uuid-${providerName}-${modelId}`, displayName }]]),
  });
}

describe("Models Config Route", () => {
  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
  });

  beforeEach(() => {
    resetAllStubs();
    stubConfigPg({
      getUserConfig: async (_ctx: any) => ({ ..._userConfig }),
      setUserConfig: async (_ctx: any, patch: any) => {
        if (patch.currentModel !== undefined) _userConfig.currentModel = patch.currentModel;
        if (patch.smallModel !== undefined) _userConfig.smallModel = patch.smallModel;
        if (patch.permission !== undefined) _userConfig.permission = patch.permission;
        if (patch.defaultAgent !== undefined) _userConfig.defaultAgent = patch.defaultAgent;
      },
      listProviders: async (_ctx: any) => {
        return [..._providers.values()].map((p) => ({
          id: p.id,
          name: p.name,
          resourceAccess: internalAccess(p.id),
          resourceKey: `test-team/${p.id}`,
          modelCount: p.models.size,
        }));
      },
      getProvider: async (_ctx: any, name: string) => {
        const providerName = name.includes("/")
          ? [..._providers.values()].find((p) => `test-team/${p.id}` === name)?.name
          : name;
        const p = providerName ? _providers.get(providerName) : null;
        if (!p) return null;
        return {
          ...p,
          resourceAccess: internalAccess(p.id),
          models: [...p.models.entries()].map(([modelId, m]) => ({
            id: (m.id as string) ?? `uuid-${p.name}-${modelId}`,
            providerId: p.id,
            modelId,
            providerResourceAccess: internalAccess(p.id),
            ...m,
          })),
        };
      },
      getProviderByResourceKey: async (_ctx: any, resourceKey: string) => {
        const p = [..._providers.values()].find((provider) => `test-team/${provider.id}` === resourceKey);
        if (!p) return null;
        return {
          ...p,
          resourceAccess: internalAccess(p.id),
          models: [...p.models.entries()].map(([modelId, m]) => ({
            id: (m.id as string) ?? `uuid-${p.name}-${modelId}`,
            providerId: p.id,
            modelId,
            providerResourceAccess: internalAccess(p.id),
            ...m,
          })),
        };
      },
    });
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-team", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-team", userId: "test-user", role: "owner" });
    _userConfig = { defaultAgent: null, currentModel: null, smallModel: null, permission: null };
    _providers = new Map();
  });

  test("get action — 无配置", async () => {
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current).toEqual({ model: null, small_model: null, permission: null });
    expect(json.data.available).toEqual([]);
  });

  test("get action — 有配置", async () => {
    _userConfig.currentModel = "claude-sonnet-4-6";
    _userConfig.smallModel = "claude-haiku-4-5";
    _providers.set("anthropic", {
      id: "prov-anthropic",
      name: "anthropic",
      models: new Map([
        ["claude-sonnet-4-6", { id: "uuid-anthropic-sonnet", displayName: "Claude Sonnet 4.6" }],
        ["claude-haiku-4-5", { id: "uuid-anthropic-haiku", displayName: "Claude Haiku 4.5" }],
      ]),
    });
    await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      }),
    );
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.model).toBe("claude-sonnet-4-6");
    expect(json.data.current.small_model).toBe("claude-haiku-4-5");
    expect(json.data.available).toHaveLength(2);
    expect(json.data.available[0]).toMatchObject({
      id: "uuid-anthropic-sonnet",
      provider: "anthropic",
      label: "Claude Sonnet 4.6",
    });
  });

  test("get action — 使用缓存", async () => {
    _userConfig.currentModel = "a";
    _providers.set("test", { id: "prov-test", name: "test", models: new Map([["model-1", { displayName: "M1" }]]) });
    await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      }),
    );
    const _res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }),
    );
    _providers.delete("test");
    const res2 = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }),
    );
    const json2 = await res2.json();
    expect(json2.data.available).toHaveLength(1);
  });

  test("set action — 设置主模型", async () => {
    seedModel("anthropic", "claude-opus-4-7");
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { model: "anthropic/claude-opus-4-7" } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.model).toBe("anthropic/claude-opus-4-7");
    expect(_userConfig.currentModel).toBe("anthropic/claude-opus-4-7");
  });

  test("set action — 设置轻量模型", async () => {
    seedModel("openai", "gpt-4o-mini");
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { small_model: "openai/gpt-4o-mini" } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.small_model).toBe("openai/gpt-4o-mini");
    expect(_userConfig.smallModel).toBe("openai/gpt-4o-mini");
  });

  test("set action — 同时设置", async () => {
    seedModel("p", "a");
    _providers.get("p")!.models.set("b", { displayName: "b" });
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { model: "p/a", small_model: "p/b" } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_userConfig.currentModel).toBe("p/a");
    expect(_userConfig.smallModel).toBe("p/b");
  });

  test("set action — 空数据返回 VALIDATION_ERROR", async () => {
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: {} }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("refresh action", async () => {
    _providers.set("p1", {
      id: "prov-p1",
      name: "p1",
      models: new Map([
        ["m1", { displayName: "M1" }],
        ["m2", { displayName: "M2" }],
      ]),
    });
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.count).toBe(2);
  });

  test("未知 action 返回验证错误", async () => {
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "invalid" }),
      }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.type).toBe("validation");
  });

  test("get action — 无 permission 返回 null", async () => {
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.permission).toBe(null);
  });

  test("get action — permission 为对象时透传", async () => {
    _userConfig.permission = { bash: "allow", read: { "*.env": "deny" } };
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.permission).toEqual({ bash: "allow", read: { "*.env": "deny" } });
  });

  test("get action — permission 为字符串时透传", async () => {
    _userConfig.permission = "ask";
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.permission).toBe("ask");
  });

  test("set action — 单独设置 permission 对象", async () => {
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { permission: { bash: "deny" } } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.permission).toEqual({ bash: "deny" });
    expect(_userConfig.permission).toEqual({ bash: "deny" });
  });

  test("set action — 单独设置 permission 字符串", async () => {
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { permission: "allow" } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.permission).toBe("allow");
    expect(_userConfig.permission).toBe("allow");
  });

  test("set action — 同时设置 model 和 permission", async () => {
    seedModel("openai", "gpt-4o");
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { model: "openai/gpt-4o", permission: { edit: "deny" } } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.model).toBe("openai/gpt-4o");
    expect(json.data.permission).toEqual({ edit: "deny" });
    expect(_userConfig.currentModel).toBe("openai/gpt-4o");
    expect(_userConfig.permission).toEqual({ edit: "deny" });
  });

  test("set action — permission 为 null 时清除", async () => {
    _userConfig.permission = { bash: "allow" };
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { permission: null } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.permission).toBe(null);
    expect(_userConfig.permission).toBe(null);
  });

  test("set action invalidates available model cache", async () => {
    _providers.set("p1", {
      id: "prov-p1",
      name: "p1",
      models: new Map([["old-model", { id: "uuid-p1-old-model", displayName: "Old" }]]),
    });
    await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }),
    );
    _providers.set("p1", {
      id: "prov-p1",
      name: "p1",
      models: new Map([["new-model", { id: "uuid-p1-new-model", displayName: "New" }]]),
    });
    await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { model: "p1/new-model" } }),
      }),
    );
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }),
    );
    const json = await res.json();
    expect(json.data.available).toHaveLength(1);
    expect(json.data.available[0].id).toBe("uuid-p1-new-model");
  });

  test("set action — available list reflects model with context/output limits", async () => {
    _providers.set("p1", {
      id: "prov-p1",
      name: "p1",
      models: new Map([
        ["big-model", { id: "uuid-p1-big-model", displayName: "Big", limitConfig: { context: 200000, output: 8192 } }],
      ]),
    });
    await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      }),
    );
    const res = await modelsRoute.handle(
      new Request("http://localhost/config/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get" }),
      }),
    );
    const json = await res.json();
    const model = json.data.available.find((m: any) => m.id === "uuid-p1-big-model");
    expect(model.contextLimit).toBe(200000);
    expect(model.outputLimit).toBe(8192);
  });
});
