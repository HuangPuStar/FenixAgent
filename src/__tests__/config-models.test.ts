import { describe, test, expect, beforeEach, mock } from "bun:test";

let _configStore: Record<string, any> = {};

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
  getConfig: async () => _configStore,
  setTopLevelField: async (field: string, value: unknown) => { _configStore[field] = value; },
}));

const modelsRoute = (await import("../routes/web/config/models")).default;

describe("Models Config Route", () => {
  beforeEach(() => {
    _configStore = {};
  });

  test("get action — 无配置", async () => {
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current).toEqual({ model: null, small_model: null, permission: null });
    expect(json.data.available).toEqual([]);
  });

  test("get action — 有配置", async () => {
    _configStore = {
      model: "claude-sonnet-4-6",
      small_model: "claude-haiku-4-5",
      provider: {
        anthropic: {
          models: {
            "claude-sonnet-4-6": { name: "Claude Sonnet 4.6" },
            "claude-haiku-4-5": { name: "Claude Haiku 4.5" },
          },
        },
      },
    };
    // Force cache refresh to pick up new config
    await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    }));
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.model).toBe("claude-sonnet-4-6");
    expect(json.data.current.small_model).toBe("claude-haiku-4-5");
    expect(json.data.available).toHaveLength(2);
    expect(json.data.available[0]).toMatchObject({ id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6" });
  });

  test("get action — 使用缓存", async () => {
    _configStore = {
      model: "a",
      provider: { test: { models: { "model-1": { name: "M1" } } } },
    };
    // Force refresh to build cache with this config
    await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    }));
    // Now call get — should use cache (not refresh)
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    // Modify store after first request
    _configStore.provider = {};
    // Second request — should use cache (still see old data)
    const res2 = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    const json2 = await res2.json();
    // Cache still has old provider data
    expect(json2.data.available).toHaveLength(1);
  });

  test("set action — 设置主模型", async () => {
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { model: "claude-opus-4-7" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.model).toBe("claude-opus-4-7");
    expect(_configStore.model).toBe("claude-opus-4-7");
  });

  test("set action — 设置轻量模型", async () => {
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { small_model: "gpt-4o-mini" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.small_model).toBe("gpt-4o-mini");
    expect(_configStore.small_model).toBe("gpt-4o-mini");
  });

  test("set action — 同时设置", async () => {
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { model: "a", small_model: "b" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_configStore.model).toBe("a");
    expect(_configStore.small_model).toBe("b");
  });

  test("set action — 空数据返回 VALIDATION_ERROR", async () => {
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: {} }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("refresh action", async () => {
    _configStore = {
      provider: {
        p1: { models: { m1: { name: "M1" }, m2: { name: "M2" } } },
      },
    };
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.count).toBe(2);
  });

  test("未知 action 返回 VALIDATION_ERROR", async () => {
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid" }),
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  // ── Permission 透传测试 ──

  test("get action — 无 permission 返回 null", async () => {
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.permission).toBe(null);
  });

  test("get action — permission 为对象时透传", async () => {
    _configStore = {
      permission: { bash: "allow", read: { "*.env": "deny" } },
    };
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.permission).toEqual({ bash: "allow", read: { "*.env": "deny" } });
  });

  test("get action — permission 为字符串时透传", async () => {
    _configStore = {
      permission: "ask",
    };
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.permission).toBe("ask");
  });

  test("set action — 单独设置 permission 对象", async () => {
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { permission: { bash: "deny" } } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.permission).toEqual({ bash: "deny" });
    expect(_configStore.permission).toEqual({ bash: "deny" });
  });

  test("set action — 单独设置 permission 字符串", async () => {
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { permission: "allow" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.permission).toBe("allow");
    expect(_configStore.permission).toBe("allow");
  });

  test("set action — 同时设置 model 和 permission", async () => {
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { model: "gpt-4o", permission: { edit: "deny" } } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.model).toBe("gpt-4o");
    expect(json.data.permission).toEqual({ edit: "deny" });
    expect(_configStore.model).toBe("gpt-4o");
    expect(_configStore.permission).toEqual({ edit: "deny" });
  });

  test("set action — permission 为 null 时清除", async () => {
    _configStore.permission = { bash: "allow" };
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { permission: null } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.permission).toBe(null);
    expect(_configStore.permission).toBe(null);
  });

  // ── Cache invalidation on set ──

  test("set action invalidates available model cache", async () => {
    _configStore = {
      provider: { p1: { models: { "old-model": { name: "Old" } } } },
    };
    // Populate cache via get
    await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    // Change config
    _configStore.provider = { p1: { models: { "new-model": { name: "New" } } } };
    // Set model triggers cache invalidation
    await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { model: "new-model" } }),
    }));
    // Next get should reflect the updated config (not cached old data)
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    expect(json.data.available).toHaveLength(1);
    expect(json.data.available[0].id).toBe("new-model");
  });

  test("set action — available list reflects model with context/output limits", async () => {
    _configStore = {
      provider: {
        p1: { models: {
          "big-model": { name: "Big", limit: { context: 200000, output: 8192 } },
        } },
      },
    };
    // Force cache refresh to pick up the new config
    await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    }));
    const res = await modelsRoute.request(new Request("http://localhost/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    const model = json.data.available.find((m: any) => m.id === "big-model");
    expect(model.contextLimit).toBe(200000);
    expect(model.outputLimit).toBe(8192);
  });
});
