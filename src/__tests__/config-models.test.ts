import { describe, test, expect, beforeEach, mock } from "bun:test";

// In-memory mock for user config and providers
let _userConfig: { defaultAgent: string | null; currentModel: string | null; smallModel: string | null; permission: unknown } = { defaultAgent: null, currentModel: null, smallModel: null, permission: null };
let _providers: Map<string, { id: string; name: string; models: Map<string, Record<string, unknown>> }> = new Map();

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

mock.module("../services/team", () => ({
  getAuthContext: async () => ({ teamId: "test-team", userId: "test-user", role: "owner" }),
    getAuthContextByTeamId: async () => ({ teamId: "test-team", userId: "test-user", role: "owner" }),
  ensurePersonalTeam: async () => {},
  listMyTeams: async () => [{ id: "test-team", name: "Test Team", slug: "test-team" }],
  getTeamDetail: async () => null,
  createTeam: async () => null,
  switchTeam: async () => null,
  addMember: async () => {},
  removeMember: async () => false,
  updateRole: async () => false,
  getTeamMembers: async () => [],
  updateTeam: async () => false,
  deleteTeam: async () => false,
}));

mock.module("../services/config-pg", () => ({
  getUserConfig: async (_ctx: any) => ({ ..._userConfig }),
  setUserConfig: async (_ctx: any, patch: any) => {
    if (patch.currentModel !== undefined) _userConfig.currentModel = patch.currentModel;
    if (patch.smallModel !== undefined) _userConfig.smallModel = patch.smallModel;
    if (patch.permission !== undefined) _userConfig.permission = patch.permission;
    if (patch.defaultAgent !== undefined) _userConfig.defaultAgent = patch.defaultAgent;
  },
  listProviders: async (_ctx: any) => {
    return [..._providers.values()].map((p) => ({ id: p.id, name: p.name, modelCount: p.models.size }));
  },
  getProvider: async (_ctx: any, name: string) => {
    const p = _providers.get(name);
    if (!p) return null;
    return { ...p, models: [...p.models.entries()].map(([modelId, m]) => ({ id: "model-uuid", providerId: p.id, modelId, ...m })) };
  },
}));

const modelsRoute = (await import("../routes/web/config/models")).default;

describe("Models Config Route", () => {
  beforeEach(() => {
    _userConfig = { defaultAgent: null, currentModel: null, smallModel: null, permission: null };
    _providers = new Map();
  });

  test("get action — 无配置", async () => {
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
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
    _userConfig.currentModel = "claude-sonnet-4-6";
    _userConfig.smallModel = "claude-haiku-4-5";
    _providers.set("anthropic", { id: "prov-anthropic", name: "anthropic", models: new Map([["claude-sonnet-4-6", { displayName: "Claude Sonnet 4.6" }], ["claude-haiku-4-5", { displayName: "Claude Haiku 4.5" }]]) });
    await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    }));
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
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
    _userConfig.currentModel = "a";
    _providers.set("test", { id: "prov-test", name: "test", models: new Map([["model-1", { displayName: "M1" }]]) });
    await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    }));
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    _providers.delete("test");
    const res2 = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json2 = await res2.json();
    expect(json2.data.available).toHaveLength(1);
  });

  test("set action — 设置主模型", async () => {
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { model: "claude-opus-4-7" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.model).toBe("claude-opus-4-7");
    expect(_userConfig.currentModel).toBe("claude-opus-4-7");
  });

  test("set action — 设置轻量模型", async () => {
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { small_model: "gpt-4o-mini" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.small_model).toBe("gpt-4o-mini");
    expect(_userConfig.smallModel).toBe("gpt-4o-mini");
  });

  test("set action — 同时设置", async () => {
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { model: "a", small_model: "b" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_userConfig.currentModel).toBe("a");
    expect(_userConfig.smallModel).toBe("b");
  });

  test("set action — 空数据返回 VALIDATION_ERROR", async () => {
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: {} }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("refresh action", async () => {
    _providers.set("p1", { id: "prov-p1", name: "p1", models: new Map([["m1", { displayName: "M1" }], ["m2", { displayName: "M2" }]]) });
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.count).toBe(2);
  });

  test("未知 action 返回 VALIDATION_ERROR", async () => {
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "invalid" }),
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("get action — 无 permission 返回 null", async () => {
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.permission).toBe(null);
  });

  test("get action — permission 为对象时透传", async () => {
    _userConfig.permission = { bash: "allow", read: { "*.env": "deny" } };
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.permission).toEqual({ bash: "allow", read: { "*.env": "deny" } });
  });

  test("get action — permission 为字符串时透传", async () => {
    _userConfig.permission = "ask";
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.current.permission).toBe("ask");
  });

  test("set action — 单独设置 permission 对象", async () => {
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { permission: { bash: "deny" } } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.permission).toEqual({ bash: "deny" });
    expect(_userConfig.permission).toEqual({ bash: "deny" });
  });

  test("set action — 单独设置 permission 字符串", async () => {
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { permission: "allow" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.permission).toBe("allow");
    expect(_userConfig.permission).toBe("allow");
  });

  test("set action — 同时设置 model 和 permission", async () => {
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { model: "gpt-4o", permission: { edit: "deny" } } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.model).toBe("gpt-4o");
    expect(json.data.permission).toEqual({ edit: "deny" });
    expect(_userConfig.currentModel).toBe("gpt-4o");
    expect(_userConfig.permission).toEqual({ edit: "deny" });
  });

  test("set action — permission 为 null 时清除", async () => {
    _userConfig.permission = { bash: "allow" };
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { permission: null } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.permission).toBe(null);
    expect(_userConfig.permission).toBe(null);
  });

  test("set action invalidates available model cache", async () => {
    _providers.set("p1", { id: "prov-p1", name: "p1", models: new Map([["old-model", { displayName: "Old" }]]) });
    await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    _providers.set("p1", { id: "prov-p1", name: "p1", models: new Map([["new-model", { displayName: "New" }]]) });
    await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", data: { model: "new-model" } }),
    }));
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    }));
    const json = await res.json();
    expect(json.data.available).toHaveLength(1);
    expect(json.data.available[0].id).toBe("new-model");
  });

  test("set action — available list reflects model with context/output limits", async () => {
    _providers.set("p1", { id: "prov-p1", name: "p1", models: new Map([["big-model", { displayName: "Big", limitConfig: { context: 200000, output: 8192 } }]]) });
    await modelsRoute.handle(new Request("http://localhost/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    }));
    const res = await modelsRoute.handle(new Request("http://localhost/web/config/models", {
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
