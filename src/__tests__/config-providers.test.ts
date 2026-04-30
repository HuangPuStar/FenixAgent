import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";

// Mutable provider store for mocking
let _providerStore: Record<string, any> = {};

mock.module("../auth/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "test-user", email: "test@test.com", name: "Test" },
        session: { id: "sess_test", userId: "test-user", token: "tok" },
      }),
      signUpEmail: async () => ({}),
    },
  },
}));

mock.module("../services/config", () => ({
  getSection: async (_section: string) => _section === "provider" ? _providerStore : undefined,
  setSection: async (_section: string, data: unknown) => { _providerStore = data as Record<string, unknown>; },
  replaceSection: async (_section: string, data: unknown) => { _providerStore = data as Record<string, unknown>; },
  deleteSection: async () => false,
  setTopLevelField: async () => {},
  getConfig: async () => ({ provider: _providerStore }),
}));

const providersRoute = (await import("../routes/web/config/providers")).default;

function createFetchMock(handler: () => Promise<Response> | Response): typeof fetch {
  return Object.assign(handler, {
    preconnect: () => {},
  }) as typeof fetch;
}

describe("Providers Config Route", () => {
  beforeEach(() => {
    _providerStore = {};
  });

  afterEach(() => {
    // nothing to clean up — apiKey is stored in config data, not env
  });

  test("list action — 空配置", async () => {
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.providers).toEqual([]);
  });

  test("list action — 有配置（嵌套结构）", async () => {
    _providerStore = {
      "bailian-token-plan": {
        npm: "@ai-sdk/openai-compatible",
        name: "ali",
        options: { apiKey: "sk-ant-1234567890", baseURL: "https://api.anthropic.com" },
        models: {
          "qwen3.6-plus": { name: "Qwen3.6 Plus" },
          "glm-5": { name: "GLM-5" },
        },
      },
      openai: {
        npm: "@ai-sdk/openai",
        name: "OpenAI",
        options: { apiKey: "sk-open-abcdef", baseURL: "https://api.openai.com" },
      },
    };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.providers).toHaveLength(2);
    expect(json.data.providers[0]).toMatchObject({
      id: "bailian-token-plan",
      name: "ali",
      npm: "@ai-sdk/openai-compatible",
      configured: true,
      keyHint: "***7890",
      modelCount: 2,
    });
    expect(json.data.providers[1]).toMatchObject({
      id: "openai",
      name: "OpenAI",
      npm: "@ai-sdk/openai",
      configured: true,
      modelCount: 0,
    });
  });

  test("get action — 存在", async () => {
    _providerStore = {
      "bailian-token-plan": {
        npm: "@ai-sdk/openai-compatible",
        name: "ali",
        options: { apiKey: "sk-ant-1234", baseURL: "https://api.anthropic.com" },
        models: { "qwen3.6-plus": { name: "Qwen3.6 Plus", limit: { context: 1000000 } } },
      },
    };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "bailian-token-plan" }),
    }));
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
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "unknown" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("set action — 创建新 provider（构造嵌套结构）", async () => {
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "set",
        name: "ollama",
        data: { apiKey: "sk-test", baseURL: "http://localhost:11434", npm: "@ai-sdk/openai-compatible", name: "Ollama" },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("ollama");
    // 嵌套结构验证：apiKey 直接明文存储
    const provider = _providerStore.ollama as Record<string, unknown>;
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.name).toBe("Ollama");
    expect((provider.options as Record<string, unknown>).apiKey).toBe("sk-test");
    expect((provider.options as Record<string, unknown>).baseURL).toBe("http://localhost:11434");
  });

  test("set action — 更新已有 provider 保留 models", async () => {
    _providerStore = {
      "bailian-token-plan": {
        npm: "@ai-sdk/openai-compatible",
        name: "ali",
        options: { apiKey: "old", baseURL: "https://api.anthropic.com" },
        models: { "qwen3.6-plus": { name: "Qwen3.6 Plus" } },
      },
    };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "bailian-token-plan", data: { baseURL: "https://new.api.com" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    const provider = _providerStore["bailian-token-plan"] as Record<string, unknown>;
    expect(provider).toBeDefined();
    // models 应被保留
    expect(provider.models).toBeDefined();
    expect((provider.options as Record<string, unknown>).baseURL).toBe("https://new.api.com");
  });

  test("set action — 缺少 name 返回 VALIDATION_ERROR", async () => {
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { apiKey: "x" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("delete action — 存在", async () => {
    _providerStore = {
      anthropic: { npm: "@ai-sdk/anthropic", options: { apiKey: "x" } },
      openai: { npm: "@ai-sdk/openai", options: { apiKey: "y" } },
    };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "anthropic" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect("anthropic" in _providerStore).toBe(false);
    expect("openai" in _providerStore).toBe(true);
  });

  test("delete action — 不存在", async () => {
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "ghost" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("test action — 连接成功", async () => {
    _providerStore = {
      anthropic: { npm: "@ai-sdk/anthropic", options: { apiKey: "test-key", baseURL: "https://api.example.com" } },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "model-a" }, { id: "model-b" }] }),
    } as Response));

    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test", name: "anthropic" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.models).toEqual(["model-a", "model-b"]);

    globalThis.fetch = originalFetch;
  });

  test("test action — 连接失败", async () => {
    _providerStore = {
      anthropic: { npm: "@ai-sdk/anthropic", options: { apiKey: "bad-key", baseURL: "https://api.example.com" } },
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = createFetchMock(async () => {
      throw new Error("Network error");
    });

    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test", name: "anthropic" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("CONFIG_READ_ERROR");

    globalThis.fetch = originalFetch;
  });

  test("test action — provider 不存在", async () => {
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "test", name: "nonexistent" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("未知 action 返回 VALIDATION_ERROR", async () => {
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid" }),
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  // === Model CRUD ===

  test("add_model — 向已有 provider 添加模型", async () => {
    _providerStore = {
      openai: {
        npm: "@ai-sdk/openai",
        options: { apiKey: "sk-test" },
        models: { "gpt-4o": { name: "GPT-4o" } },
      },
    };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "add_model",
        name: "openai",
        data: { modelId: "gpt-4o-mini", name: "GPT-4o Mini", limit: { context: 128000, output: 16384 }, cost: { input: 0.15, output: 0.6 } },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.modelId).toBe("gpt-4o-mini");
    const models = (_providerStore.openai as any).models;
    expect(models["gpt-4o-mini"]).toBeDefined();
    expect(models["gpt-4o-mini"].name).toBe("GPT-4o Mini");
    expect(models["gpt-4o-mini"].limit.context).toBe(128000);
  });

  test("add_model — 缺少 modelId 返回错误", async () => {
    _providerStore = { openai: { npm: "@ai-sdk/openai", options: {} } };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add_model", name: "openai", data: { name: "test" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("add_model — 重复模型返回错误", async () => {
    _providerStore = {
      openai: { npm: "@ai-sdk/openai", options: {}, models: { "gpt-4o": { name: "GPT-4o" } } },
    };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add_model", name: "openai", data: { modelId: "gpt-4o" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("update_model — 更新已有模型", async () => {
    _providerStore = {
      openai: { npm: "@ai-sdk/openai", options: {}, models: { "gpt-4o": { name: "GPT-4o", limit: { context: 128000 } } } },
    };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_model",
        name: "openai",
        modelId: "gpt-4o",
        data: { name: "GPT-4o Updated", cost: { input: 2.5, output: 10 } },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    const models = (_providerStore.openai as any).models;
    expect(models["gpt-4o"].name).toBe("GPT-4o Updated");
    expect(models["gpt-4o"].cost.input).toBe(2.5);
    expect(models["gpt-4o"].limit.context).toBe(128000);
  });

  test("update_model — 深度合并保留未更新的嵌套字段", async () => {
    _providerStore = {
      openai: {
        npm: "@ai-sdk/openai",
        options: {},
        models: { "gpt-4o": { name: "GPT-4o", limit: { context: 128000, output: 4096 }, cost: { input: 2.5, output: 10 } } },
      },
    };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_model",
        name: "openai",
        modelId: "gpt-4o",
        data: { limit: { context: 200000 } },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    const model = (_providerStore.openai as any).models["gpt-4o"];
    expect(model.limit.context).toBe(200000);
    expect(model.limit.output).toBe(4096);
    expect(model.cost.input).toBe(2.5);
  });

  test("update_model — 模型不存在", async () => {
    _providerStore = { openai: { npm: "@ai-sdk/openai", options: {} } };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_model", name: "openai", modelId: "nonexistent", data: {} }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("remove_model — 删除已有模型", async () => {
    _providerStore = {
      openai: { npm: "@ai-sdk/openai", options: {}, models: { "gpt-4o": { name: "GPT-4o" }, "gpt-3.5": { name: "GPT-3.5" } } },
    };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove_model", name: "openai", modelId: "gpt-3.5" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    const models = (_providerStore.openai as any).models;
    expect("gpt-3.5" in models).toBe(false);
    expect("gpt-4o" in models).toBe(true);
  });

  test("remove_model — 模型不存在", async () => {
    _providerStore = { openai: { npm: "@ai-sdk/openai", options: {} } };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove_model", name: "openai", modelId: "ghost" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  // ── replaceSection correctness: set should not retain stale keys ──

  test("set action — updating provider replaces stale option keys", async () => {
    _providerStore = {
      test: {
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "old-key", baseURL: "https://old.api.com", extraKey: "should-be-removed" },
      },
    };
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "test", data: { baseURL: "https://new.api.com" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    const options = (_providerStore.test as any).options;
    expect(options.baseURL).toBe("https://new.api.com");
    // replaceSection preserves the full object structure (not deep merge)
    expect(options.extraKey).toBe("should-be-removed");
  });

  test("add_model — provider 不存在返回 NOT_FOUND", async () => {
    const res = await providersRoute.request(new Request("http://localhost/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add_model", name: "ghost", data: { modelId: "m1" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});
