import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

// In-memory PG mock for providers
let _providers: Map<
  string,
  {
    id: string;
    name: string;
    displayName: string | null;
    protocol: "openai" | "anthropic";
    baseUrl: string | null;
    apiKey: string | null;
    extraOptions: Record<string, unknown> | null;
    models: Map<string, Record<string, unknown>>;
  }
> = new Map();

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

function setupStubs() {
  stubConfigPg({
    listProviders: async (_ctx: any) => {
      return [..._providers.values()].map((p) => ({
        id: p.id,
        name: p.name,
        displayName: p.displayName,
        protocol: p.protocol,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        extraOptions: p.extraOptions,
        resourceAccess: internalAccess(p.id),
        resourceKey: `test-team/${p.id}`,
        modelCount: p.models.size,
      }));
    },
    getProvider: async (_ctx: any, name: string) => {
      const p = _providers.get(name);
      if (!p) return null;
      return {
        ...p,
        resourceAccess: internalAccess(p.id),
        models: [...p.models.entries()].map(([modelId, m]) => ({
          id: "model-uuid",
          providerId: p.id,
          modelId,
          providerResourceAccess: internalAccess(p.id),
          ...m,
        })),
      };
    },
    assertProviderInternalWritable: async (_ctx: any, name: string) => {
      const p = await (async () => {
        const provider = _providers.get(name);
        if (!provider) return null;
        return {
          ...provider,
          resourceAccess: internalAccess(provider.id),
          models: [...provider.models.entries()].map(([modelId, m]) => ({
            id: "model-uuid",
            providerId: provider.id,
            modelId,
            providerResourceAccess: internalAccess(provider.id),
            ...m,
          })),
        };
      })();
      return p;
    },
    upsertProvider: async (_ctx: any, name: string, data: any) => {
      const existing = _providers.get(name);
      if (existing) {
        Object.assign(existing, {
          displayName: data.displayName ?? existing.displayName,
          protocol: data.protocol ?? existing.protocol,
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
        protocol: data.protocol ?? "openai",
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
    addModel: async (_ctx: any, providerId: string, data: any) => {
      for (const p of _providers.values()) {
        if (p.id === providerId) {
          p.models.set(data.modelId, data);
          return;
        }
      }
    },
    updateModel: async (_ctx: any, providerId: string, modelId: string, data: any) => {
      for (const p of _providers.values()) {
        if (p.id === providerId) {
          const existing = p.models.get(modelId) ?? {};
          p.models.set(modelId, { ...existing, ...data });
          return;
        }
      }
    },
    removeModel: async (_ctx: any, providerId: string, modelId: string) => {
      for (const p of _providers.values()) {
        if (p.id === providerId) {
          p.models.delete(modelId);
          return;
        }
      }
    },
  });
}

// Helper to get provider store for assertions
function _getProviderStore() {
  const result: Record<string, any> = {};
  for (const [name, p] of _providers) {
    const provider: Record<string, any> = { name: p.name, protocol: p.protocol, displayName: p.displayName };
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

function createFetchMock(
  handler: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response> | Response,
): typeof fetch {
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
    resetAllStubs();
    setupStubs();
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: {
        organizationId: "test-team",
        userId: "test-user",
        role: "owner",
      },
    });
    setTestOrgContext({
      organizationId: "test-team",
      userId: "test-user",
      role: "owner",
    });
    _providers = new Map();
  });

  test("list action — 空配置", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.providers).toEqual([]);
  });

  test("list action — 有配置（嵌套结构）", async () => {
    _providers.set("bailian-token-plan", {
      id: "prov-bailian",
      name: "bailian-token-plan",
      displayName: null,
      protocol: "openai",
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
      name: "openai",
      displayName: null,
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-open-abcdef",
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.providers).toHaveLength(2);
    expect(json.data.providers[0]).toMatchObject({
      id: "bailian-token-plan",
      name: "",
      protocol: "openai",
      keyHint: "***7890",
      modelCount: 2,
    });
    expect(json.data.providers[1]).toMatchObject({
      id: "openai",
      name: "",
      protocol: "openai",
      modelCount: 0,
    });
  });

  test("get action — 存在", async () => {
    _providers.set("bailian-token-plan", {
      id: "prov-bailian",
      name: "bailian-token-plan",
      displayName: null,
      protocol: "openai",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-1234",
      extraOptions: null,
      models: new Map([
        [
          "qwen3.6-plus",
          {
            displayName: "Qwen3.6 Plus",
            limitConfig: { context: 1000000 },
          },
        ],
      ]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/bailian-token-plan", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("bailian-token-plan");
    expect(json.data.name).toBe("");
    expect(json.data.protocol).toBe("openai");
    expect(json.data.keyHint).toBe("***1234");
    expect(json.data.models).toHaveLength(1);
    expect(json.data.models[0].id).toBe("qwen3.6-plus");
    expect("options" in json.data).toBe(false);
  });

  test("get action — 短 key 返回固定 7 位掩码", async () => {
    _providers.set("short-key-provider", {
      id: "prov-short",
      name: "short-key-provider",
      displayName: null,
      protocol: "openai",
      baseUrl: null,
      apiKey: "abc",
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/short-key-provider", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.keyHint).toBe("*******");
  });

  test("get action — 空 key 返回固定 7 位掩码", async () => {
    _providers.set("empty-key-provider", {
      id: "prov-empty",
      name: "empty-key-provider",
      displayName: null,
      protocol: "openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/empty-key-provider", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.keyHint).toBe("*******");
  });

  test("get action — 不存在", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/unknown", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("set action — 创建新 provider", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/ollama", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: "sk-test",
          baseURL: "http://localhost:11434",
          protocol: "openai",
          name: "Ollama",
        }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe("ollama");
    const p = _providers.get("ollama");
    expect(p).toBeDefined();
    expect(p!.protocol).toBe("openai");
    expect(p!.apiKey).toBe("sk-test");
    expect(p!.baseUrl).toBe("http://localhost:11434");
  });

  test("set action — 更新已有 provider 保留 models", async () => {
    _providers.set("bailian-token-plan", {
      id: "prov-bailian",
      name: "bailian-token-plan",
      displayName: null,
      protocol: "openai",
      baseUrl: "https://api.anthropic.com",
      apiKey: "old",
      extraOptions: null,
      models: new Map([["qwen3.6-plus", { displayName: "Qwen3.6 Plus" }]]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/bailian-token-plan", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseURL: "https://new.api.com",
        }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    const p = _providers.get("bailian-token-plan");
    expect(p).toBeDefined();
    expect(p!.models.size).toBe(1);
    expect(p!.baseUrl).toBe("https://new.api.com");
  });

  test("GET 不存在的 provider 返回 NOT_FOUND", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/nonexistent", {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("delete action — 存在", async () => {
    _providers.set("anthropic", {
      id: "prov-anthropic",
      name: "anthropic",
      displayName: null,
      protocol: "anthropic",
      baseUrl: null,
      apiKey: "x",
      extraOptions: null,
      models: new Map(),
    });
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      protocol: "openai",
      baseUrl: null,
      apiKey: "y",
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/anthropic", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_providers.has("anthropic")).toBe(false);
    expect(_providers.has("openai")).toBe(true);
  });

  test("delete action — 不存在", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/ghost", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("test action — openai 协议通过 models 接口验证", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      protocol: "openai",
      baseUrl: "https://api.example.com/",
      apiKey: "test-key",
      extraOptions: null,
      models: new Map(),
    });
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestMethod = "";
    globalThis.fetch = createFetchMock(async (input, init) => {
      requestUrl = typeof input === "string" ? input : input.toString();
      requestMethod = init?.method ?? "GET";
      return {
        ok: true,
        json: async () => ({ data: [{ id: "model-a" }, { id: "model-b" }] }),
      } as Response;
    });

    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/openai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.models).toEqual(["model-a", "model-b"]);
    expect(requestMethod).toBe("GET");
    expect(requestUrl).toBe("https://api.example.com/v1/models");

    globalThis.fetch = originalFetch;
  });

  test("test action — anthropic 优先通过 models 接口验证", async () => {
    _providers.set("anthropic", {
      id: "prov-anthropic",
      name: "anthropic",
      displayName: null,
      protocol: "anthropic",
      baseUrl: "https://api.example.com/",
      apiKey: "test-key",
      extraOptions: null,
      models: new Map(),
    });
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestMethod = "";
    let requestHeaders: RequestInit["headers"];
    globalThis.fetch = createFetchMock(async (input, init) => {
      requestUrl = typeof input === "string" ? input : input.toString();
      requestMethod = init?.method ?? "GET";
      requestHeaders = init?.headers;
      return {
        ok: true,
        json: async () => ({ data: [{ id: "claude-3-5-haiku-20241022" }, { id: "claude-3-7-sonnet-20250219" }] }),
      } as Response;
    });

    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/anthropic/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.models).toEqual(["claude-3-5-haiku-20241022", "claude-3-7-sonnet-20250219"]);
    expect(requestMethod).toBe("GET");
    expect(requestUrl).toBe("https://api.example.com/v1/models");
    expect(requestHeaders).toMatchObject({
      "x-api-key": "test-key",
      "anthropic-version": "2023-06-01",
    });

    globalThis.fetch = originalFetch;
  });

  test("test action — anthropic models 404 时提示改用模型测试", async () => {
    _providers.set("anthropic", {
      id: "prov-anthropic",
      name: "anthropic",
      displayName: null,
      protocol: "anthropic",
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      extraOptions: null,
      models: new Map([["claude-3-7-sonnet", { displayName: "Claude 3.7 Sonnet" }]]),
    });
    const originalFetch = globalThis.fetch;
    const requestMethods: string[] = [];
    globalThis.fetch = createFetchMock(async (_input, init) => {
      requestMethods.push(init?.method ?? "GET");
      return {
        ok: false,
        status: 404,
        text: async () => "not found",
      } as Response;
    });

    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/anthropic/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("PROVIDER_TEST_LIST_HTTP_ERROR");
    expect(json.data).toEqual({
      protocol: "anthropic",
      status: 404,
      detail: "not found",
      hint: "configure_model_then_test_model",
    });
    expect(requestMethods).toEqual(["GET"]);

    globalThis.fetch = originalFetch;
  });

  test("test action — anthropic models 非 404/405 时直接失败", async () => {
    _providers.set("anthropic", {
      id: "prov-anthropic",
      name: "anthropic",
      displayName: null,
      protocol: "anthropic",
      baseUrl: "https://api.example.com",
      apiKey: "bad-key",
      extraOptions: null,
      models: new Map(),
    });
    const originalFetch = globalThis.fetch;
    const requestMethods: string[] = [];
    globalThis.fetch = createFetchMock(async (_input, init) => {
      requestMethods.push(init?.method ?? "GET");
      return {
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      } as Response;
    });

    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/anthropic/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("PROVIDER_TEST_LIST_HTTP_ERROR");
    expect(json.data).toEqual({
      protocol: "anthropic",
      status: 401,
      detail: "unauthorized",
    });
    expect(requestMethods).toEqual(["GET"]);

    globalThis.fetch = originalFetch;
  });

  test("test_model action — anthropic 通过 messages 返回文本", async () => {
    _providers.set("anthropic", {
      id: "prov-anthropic",
      name: "anthropic",
      displayName: null,
      protocol: "anthropic",
      baseUrl: "https://api.example.com/",
      apiKey: "test-key",
      extraOptions: null,
      models: new Map([["claude-3-7-sonnet", { displayName: "Claude 3.7 Sonnet" }]]),
    });
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestMethod = "";
    let requestBody = "";
    globalThis.fetch = createFetchMock(async (input, init) => {
      requestUrl = typeof input === "string" ? input : input.toString();
      requestMethod = init?.method ?? "GET";
      requestBody = typeof init?.body === "string" ? init.body : "";
      return {
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "hello from anthropic" }] }),
      } as Response;
    });

    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/anthropic/models/claude-3-7-sonnet/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.ok).toBe(true);
    expect(json.data.content).toBe("hello from anthropic");
    expect(requestMethod).toBe("POST");
    expect(requestUrl).toBe("https://api.example.com/v1/messages");
    expect(JSON.parse(requestBody)).toMatchObject({
      model: "claude-3-7-sonnet",
      messages: [{ role: "user", content: "hello" }],
    });

    globalThis.fetch = originalFetch;
  });

  test("test_model action — openai 通过 chat completions 返回文本", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      protocol: "openai",
      baseUrl: "https://api.example.com",
      apiKey: "test-key",
      extraOptions: null,
      models: new Map([["gpt-4o-mini", { displayName: "GPT-4o Mini" }]]),
    });
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    globalThis.fetch = createFetchMock(async (input) => {
      requestUrl = typeof input === "string" ? input : input.toString();
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "hello from openai" } }] }),
      } as Response;
    });

    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/openai/models/gpt-4o-mini/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.content).toBe("hello from openai");
    expect(requestUrl).toBe("https://api.example.com/v1/chat/completions");

    globalThis.fetch = originalFetch;
  });

  test("test action — 连接失败", async () => {
    _providers.set("anthropic", {
      id: "prov-anthropic",
      name: "anthropic",
      displayName: null,
      protocol: "anthropic",
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
      new Request("http://localhost/config/providers/anthropic/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("CONFIG_TEST_REQUEST_FAILED");
    expect(json.data).toEqual({
      target: "provider",
      protocol: "anthropic",
      reason: "request_failed",
      detail: "Network error",
    });

    globalThis.fetch = originalFetch;
  });

  test("test action — provider 不存在", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/nonexistent/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("test action — openai 响应缺少 data 数组时失败", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      protocol: "openai",
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
          json: async () => ({ object: "list" }),
        }) as Response,
    );

    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/openai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("PROVIDER_TEST_LIST_RESPONSE_INVALID");
    expect(json.data).toEqual({
      protocol: "openai",
      reason: "missing_data_array",
    });

    globalThis.fetch = originalFetch;
  });

  // POST 缺少 name 返回 VALIDATION_ERROR
  test("创建 Provider 缺少 name 返回验证错误", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "x" }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  // === Model CRUD ===

  test("add_model — 向已有 provider 添加模型", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      protocol: "openai",
      baseUrl: null,
      apiKey: "sk-test",
      extraOptions: null,
      models: new Map([["gpt-4o", { displayName: "GPT-4o" }]]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/openai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: "gpt-4o-mini",
          name: "GPT-4o Mini",
          limit: {
            context: 128000,
            output: 16384,
          },
          cost: {
            input: 0.15,
            output: 0.6,
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
      protocol: "openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/openai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test",
        }),
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
      protocol: "openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map([["gpt-4o", { displayName: "GPT-4o" }]]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/openai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: "gpt-4o",
        }),
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
      protocol: "openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map([["gpt-4o", { displayName: "GPT-4o", limitConfig: { context: 128000 } }]]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/openai/models/gpt-4o", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "GPT-4o Updated",
          cost: {
            input: 2.5,
            output: 10,
          },
        }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(true);
    const p = _providers.get("openai")!;
    expect(p.models.get("gpt-4o")!.displayName).toBe("GPT-4o Updated");
    expect(p.models.get("gpt-4o")!.limitConfig).toEqual({
      context: 128000,
    });
  });

  test("update_model — 模型不存在", async () => {
    _providers.set("openai", {
      id: "prov-openai",
      name: "openai",
      displayName: null,
      protocol: "openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/openai/models/nonexistent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
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
      protocol: "openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map([
        ["gpt-4o", { displayName: "GPT-4o" }],
        ["gpt-3.5", { displayName: "GPT-3.5" }],
      ]),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/openai/models/gpt-3.5", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
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
      protocol: "openai",
      baseUrl: null,
      apiKey: null,
      extraOptions: null,
      models: new Map(),
    });
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/openai/models/ghost", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("add_model — provider 不存在返回 NOT_FOUND", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/ghost/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: "m1",
        }),
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});

describe("Provider Test action - edge cases", () => {
  beforeEach(() => {
    resetAllStubs();
    setupStubs();
    _providers = new Map();
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: {
        organizationId: "test-team",
        userId: "test-user",
        role: "owner",
      },
    });
    setTestOrgContext({
      organizationId: "test-team",
      userId: "test-user",
      role: "owner",
    });
  });

  test("test non-existent provider returns NOT_FOUND", async () => {
    const res = await providersRoute.handle(
      new Request("http://localhost/config/providers/nonexistent/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});

describe("Provider atomic write", () => {
  beforeEach(() => {
    resetAllStubs();
    setupStubs();
    _providers = new Map();
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: {
        organizationId: "test-team",
        userId: "test-user",
        role: "owner",
      },
    });
    setTestOrgContext({
      organizationId: "test-team",
      userId: "test-user",
      role: "owner",
    });
  });

  test("concurrent set operations don't lose data", async () => {
    _providers.set("provider-a", {
      id: "prov-a",
      name: "provider-a",
      displayName: null,
      protocol: "openai",
      baseUrl: "http://a",
      apiKey: "key-a",
      extraOptions: null,
      models: new Map(),
    });
    _providers.set("provider-b", {
      id: "prov-b",
      name: "provider-b",
      displayName: null,
      protocol: "openai",
      baseUrl: "http://b",
      apiKey: "key-b",
      extraOptions: null,
      models: new Map(),
    });

    const [res1, res2] = await Promise.all([
      providersRoute.handle(
        new Request("http://localhost/config/providers/provider-a", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: "new-key-a",
          }),
        }),
      ),
      providersRoute.handle(
        new Request("http://localhost/config/providers/provider-b", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey: "new-key-b",
          }),
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
