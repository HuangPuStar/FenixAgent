import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";

// In-memory PG mock for providers
let _providers: Map<
  string,
  {
    id: string;
    name: string;
    displayName: string | null;
    npm: string | null;
    baseUrl: string | null;
    apiKey: string | null;
    extraOptions: Record<string, unknown> | null;
    models: Map<string, Record<string, unknown>>;
  }
> = new Map();

mock.module("../services/config-pg", () => ({
  listProviders: async (_ctx: any) => {
    return [..._providers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      npm: p.npm,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      extraOptions: p.extraOptions,
      modelCount: p.models.size,
    }));
  },
  getProvider: async (_ctx: any, name: string) => {
    const p = _providers.get(name);
    if (!p) return null;
    return {
      ...p,
      models: [...p.models.entries()].map(([modelId, m]) => ({ id: "model-uuid", providerId: p.id, modelId, ...m })),
    };
  },
  upsertProvider: async (_ctx: any, name: string, data: any) => {
    const existing = _providers.get(name);
    if (existing) {
      Object.assign(existing, {
        displayName: data.displayName ?? existing.displayName,
        npm: data.npm ?? existing.npm,
        baseUrl: data.baseUrl ?? existing.baseUrl,
        apiKey: data.apiKey ?? existing.apiKey,
        extraOptions: data.extraOptions ?? existing.extraOptions,
      });
      return existing.id;
    }
    const id = `prov-${name}`;
    _providers.set(name, {
      id,
      name,
      displayName: data.displayName ?? null,
      npm: data.npm ?? null,
      baseUrl: data.baseUrl ?? null,
      apiKey: data.apiKey ?? null,
      extraOptions: data.extraOptions ?? null,
      models: new Map(),
    });
    return id;
  },
  deleteProvider: async (_ctx: any, name: string) => {
    return _providers.delete(name);
  },
  addModel: async (_orgId: string, providerId: string, data: any) => {
    for (const p of _providers.values()) {
      if (p.id === providerId) {
        p.models.set(data.modelId, data);
        return;
      }
    }
  },
  updateModel: async (_orgId: string, providerId: string, modelId: string, data: any) => {
    for (const p of _providers.values()) {
      if (p.id === providerId) {
        const existing = p.models.get(modelId) ?? {};
        p.models.set(modelId, { ...existing, ...data });
        return;
      }
    }
  },
  removeModel: async (_orgId: string, providerId: string, modelId: string) => {
    for (const p of _providers.values()) {
      if (p.id === providerId) {
        p.models.delete(modelId);
        return;
      }
    }
  },
}));

// Helper to get provider store for assertions
function _getProviderStore() {
  const result: Record<string, any> = {};
  for (const [name, p] of _providers) {
    const provider: Record<string, any> = { name: p.name, npm: p.npm, displayName: p.displayName };
    if (p.baseUrl || p.apiKey) {
      provider.options = {
        ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
        ...(p.apiKey ? { apiKey: p.apiKey } : {}),
        ...(typeof p.extraOptions === "object" && p.extraOptions !== null ? p.extraOptions : {}),
      };
    }
    if (p.models.size > 0) {
      provider.models = {};
      for (const [modelId, m] of p.models) {
        provider.models[modelId] = m;
      }
    }
    result[name] = provider;
  }
  return result;
}

const providersRoute = (await import("../routes/web/config/providers")).default;

function createFetchMock(handler: () => Promise<Response> | Response): typeof fetch {
  return Object.assign(handler, {
    preconnect: () => {},
  }) as typeof fetch;
}

describe("Providers Config Route", () => {
  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
  });

  beforeEach(() => {
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-team", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-team", userId: "test-user", role: "owner" });
    _providers = new Map();
  });

  test("list action — 空配置", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.providers).toEqual([]);
  });

  test("list action — 有配置（嵌套结构）", async () => {
    _providers.set("bailian-token-plan", {
      id: "prov-bailian",
      name: "ali",
      displayName: null,
      npm: "@ai-sdk/openai-compatible",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-1234567890",
      extraOptions: null,
      models: new Map([
        ["qwen3.6-plus", { displayName: "Qwen3.6 Plus" }],
        ["glm-5", { displayName: "GLM-5" }],
      ]),
    });
    _providers.set("openai", {
      id: "prov-openai",
      name: "OpenAI",
      displayName: null,
      npm: "@ai-sdk/openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-open-abcdef",
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.providers).toHaveLength(2);
    expect(json.data.providers[0]).toMatchObject({
      id: "ali",
      name: "ali",
      npm: "@ai-sdk/openai-compatible",
      configured: true,
      keyHint: "***7890",
      modelCount: 2,
    });
    expect(json.data.providers[1]).toMatchObject({
      id: "OpenAI",
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      configured: true,
      modelCount: 0,
    });
  });

  test("get action — 存在", async () => {
    _providers.set("bailian-token-plan", {
      id: "prov-bailian",
      name: "ali",
      displayName: null,
      npm: "@ai-sdk/openai-compatible",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-1234",
      extraOptions: null,
      models: new Map([["qwen3.6-plus", { displayName: "Qwen3.6 Plus", limitConfig: { context: 1000000 } }]]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", name: "bailian-token-plan" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("bailian-token-plan");
    expect(json.data.name).toBe("ali");
    expect(json.data.npm).toBe("@ai-sdk/openai-compatible");
    expect(json.data.keyHint).toBe("***1234");
    expect(json.data.models).toHaveLength(1);
    expect(json.data.models[0].id).toBe("qwen3.6-plus");
  });

  test("get action — 不存在", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", name: "unknown" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("set action — 创建新 provider", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set",
          name: "ollama",
          data: {
            apiKey: "sk-test",
            baseURL: "http://localhost:11434",
            npm: "@ai-sdk/openai-compatible",
            name: "Ollama",
          },
        }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("ollama");
    const p = _providers.get("ollama");
    expect(p).toBeDefined();
    expect(p!.npm).toBe("@ai-sdk/openai-compatible");
    expect(p!.apiKey).toBe("sk-test");
    expect(p!.baseUrl).toBe("http://localhost:11434");
  });

  test("set action — 更新已有 provider 保留 models", async () => {
    _providers.set("bailian-token-plan", {
      id: "prov-bailian",
      name: "ali",
      displayName: null,
      npm: "@ai-sdk/openai-compatible",
      baseUrl: "https://api.anthropic.com",
      apiKey: "old",
      extraOptions: null,
      models: new Map([["qwen3.6-plus", { displayName: "Qwen3.6 Plus" }]]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "bailian-token-plan", data: { baseURL: "https://new.api.com" } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    const p = _providers.get("bailian-token-plan");
    expect(p).toBeDefined();
    expect(p!.models.size).toBe(1);
    expect(p!.baseUrl).toBe("https://new.api.com");
  });

  test("set action — 缺少 name 返回 VALIDATION_ERROR", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", data: { apiKey: "x" } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("delete action — 存在", async () => {
    _providers.set("anthropic", {
      id: "prov-anthropic",
      name: "anthropic",
      displayName: null,
      npm: "@ai-sdk/anthropic",
      baseUrl: null,
      apiKey: "x",
      extraOptions: null,
      models: new Map(),
    });
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      npm: "@ai-sdk/openai",
      baseUrl: null,
      apiKey: "y",
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name: "anthropic" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_providers.has("anthropic")).toBe(false);
    expect(_providers.has("openai")).toBe(true);
  });

  test("delete action — 不存在", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", name: "ghost" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("test action — 连接成功", async () => {
    _providers.set("anthropic", {
      id: "prov-anthropic",
      name: "anthropic",
      displayName: null,
      npm: "@ai-sdk/anthropic",
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      extraOptions: null,
      models: new Map(),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock(
      async () =>
        ({
          ok: true,
          json: async () => ({ data: [{ id: "model-a" }, { id: "model-b" }] }),
        }) as Response,
    );

    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", name: "anthropic" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.models).toEqual(["model-a", "model-b"]);

    globalThis.fetch = originalFetch;
  });

  test("test action — 连接失败", async () => {
    _providers.set("anthropic", {
      id: "prov-anthropic",
      name: "anthropic",
      displayName: null,
      npm: "@ai-sdk/anthropic",
      baseUrl: "https://api.example.com",
      apiKey: "bad-key",
      extraOptions: null,
      models: new Map(),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock(async () => {
      throw new Error("Network error");
    });

    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", name: "anthropic" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("CONFIG_READ_ERROR");

    globalThis.fetch = originalFetch;
  });

  test("test action — provider 不存在", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", name: "nonexistent" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  // 未知 action 被 Elysia body schema 验证拦截
  test("未知 action 返回验证错误", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "invalid" }),
      }),
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.type).toBe("validation");
  });

  // === Model CRUD ===

  test("add_model — 向已有 provider 添加模型", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      npm: "@ai-sdk/openai",
      baseUrl: null,
      apiKey: "sk-test",
      extraOptions: null,
      models: new Map([["gpt-4o", { displayName: "GPT-4o" }]]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_model",
          name: "openai",
          data: {
            modelId: "gpt-4o-mini",
            name: "GPT-4o Mini",
            limit: { context: 128000, output: 16384 },
            cost: { input: 0.15, output: 0.6 },
          },
        }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.modelId).toBe("gpt-4o-mini");
    const p = _providers.get("openai")!;
    expect(p.models.has("gpt-4o-mini")).toBe(true);
    expect(p.models.get("gpt-4o-mini")!.displayName).toBe("GPT-4o Mini");
  });

  test("add_model — 缺少 modelId 返回错误", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      npm: "@ai-sdk/openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_model", name: "openai", data: { name: "test" } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("add_model — 重复模型返回错误", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      npm: "@ai-sdk/openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map([["gpt-4o", { displayName: "GPT-4o" }]]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_model", name: "openai", data: { modelId: "gpt-4o" } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("update_model — 更新已有模型", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      npm: "@ai-sdk/openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map([["gpt-4o", { displayName: "GPT-4o", limitConfig: { context: 128000 } }]]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_model",
          name: "openai",
          modelId: "gpt-4o",
          data: { name: "GPT-4o Updated", cost: { input: 2.5, output: 10 } },
        }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    const p = _providers.get("openai")!;
    expect(p.models.get("gpt-4o")!.displayName).toBe("GPT-4o Updated");
    expect(p.models.get("gpt-4o")!.limitConfig).toEqual({ context: 128000 });
  });

  test("update_model — 模型不存在", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      npm: "@ai-sdk/openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_model", name: "openai", modelId: "nonexistent", data: {} }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("remove_model — 删除已有模型", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      npm: "@ai-sdk/openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map([
        ["gpt-4o", { displayName: "GPT-4o" }],
        ["gpt-3.5", { displayName: "GPT-3.5" }],
      ]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove_model", name: "openai", modelId: "gpt-3.5" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    const p = _providers.get("openai")!;
    expect(p.models.has("gpt-3.5")).toBe(false);
    expect(p.models.has("gpt-4o")).toBe(true);
  });

  test("remove_model — 模型不存在", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      npm: "@ai-sdk/openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove_model", name: "openai", modelId: "ghost" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("add_model — provider 不存在返回 NOT_FOUND", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_model", name: "ghost", data: { modelId: "m1" } }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});

describe("Provider Test action - edge cases", () => {
  beforeEach(() => {
    _providers = new Map();
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-team", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-team", userId: "test-user", role: "owner" });
  });

  test("test non-existent provider returns NOT_FOUND", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", name: "nonexistent" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});

describe("Provider atomic write", () => {
  beforeEach(() => {
    _providers = new Map();
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-team", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-team", userId: "test-user", role: "owner" });
  });

  test("concurrent set operations don't lose data", async () => {
    _providers.set("provider-a", {
      id: "prov-a",
      name: "A",
      displayName: null,
      npm: null,
      baseUrl: "http://a",
      apiKey: "key-a",
      extraOptions: null,
      models: new Map(),
    });
    _providers.set("provider-b", {
      id: "prov-b",
      name: "B",
      displayName: null,
      npm: null,
      baseUrl: "http://b",
      apiKey: "key-b",
      extraOptions: null,
      models: new Map(),
    });

    const [res1, res2] = await Promise.all([
      providersRoute.handle(
        new Request("http://localhost/config/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set", name: "provider-a", data: { apiKey: "new-key-a" } }),
        }),
      ),
      providersRoute.handle(
        new Request("http://localhost/config/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set", name: "provider-b", data: { apiKey: "new-key-b" } }),
        }),
      ),
    ]);

    const json1 = await res1.json();
    const json2 = await res2.json();
    expect(json1.success).toBe(true);
    expect(json2.success).toBe(true);

    expect(_providers.get("provider-a")!.apiKey).toBe("new-key-a");
    expect(_providers.get("provider-b")!.apiKey).toBe("new-key-b");
  });
});
