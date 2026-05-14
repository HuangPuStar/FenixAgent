import { describe, test, expect, beforeEach, mock } from "bun:test";

// In-memory mock for agent configs and user config
let _agentStore: Record<string, any> = {};
let _userConfig: { defaultAgent: string | null; currentModel: string | null; smallModel: string | null; permission: unknown } = { defaultAgent: null, currentModel: null, smallModel: null, permission: null };

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

mock.module("../services/config-pg", () => ({
  listAgentConfigs: async (_userId: string) => {
    return Object.entries(_agentStore).map(([name, cfg]) => ({ name, ...cfg }));
  },
  getAgentConfig: async (_userId: string, name: string) => {
    const cfg = _agentStore[name];
    return cfg ? { name, ...cfg } : null;
  },
  createAgentConfig: async (_userId: string, name: string, data: Record<string, unknown>) => {
    _agentStore[name] = { ...data };
  },
  updateAgentConfig: async (_userId: string, name: string, data: Record<string, unknown>) => {
    if (!_agentStore[name]) return;
    const existing = { ..._agentStore[name] };
    for (const [key, value] of Object.entries(data)) {
      if (value === null) {
        delete existing[key];
      } else {
        existing[key] = value;
      }
    }
    delete existing.tools;
    _agentStore[name] = existing;
  },
  deleteAgentConfig: async () => [],
  getUserConfig: async (_userId: string) => ({ ..._userConfig }),
  setUserConfig: async (_userId: string, patch: any) => {
    if (patch.defaultAgent !== undefined) _userConfig.defaultAgent = patch.defaultAgent;
    if (patch.currentModel !== undefined) _userConfig.currentModel = patch.currentModel;
    if (patch.smallModel !== undefined) _userConfig.smallModel = patch.smallModel;
    if (patch.permission !== undefined) _userConfig.permission = patch.permission;
  },
}));

mock.module("../services/agent-knowledge", () => ({
  InvalidKnowledgeBindingError: class InvalidKnowledgeBindingError extends Error {},
  syncAgentKnowledgeBindings: async () => {},
  listAgentKnowledgeBindings: async () => [],
  resolveAgentKnowledgePolicy: () => ({ searchFirst: true, maxResults: 5, defaultNamespaces: [] }),
}));

const agentsRoute = (await import("../routes/web/config/agents")).default;

describe("Permission 更新流程验证", () => {
  beforeEach(() => {
    _agentStore = {
      demo: {
        model: "qwen",
        permission: { bash: "allow", task: "deny", skill: { "find-skills": "allow" } },
      },
    };
    _userConfig = { defaultAgent: null, currentModel: null, smallModel: null, permission: null };
  });

  test("更新嵌套 permission（含 skill 规则）", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "demo", data: { permission: { bash: "deny", task: "deny", skill: { "find-skills": "deny" } } } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_agentStore.demo.permission).toEqual({ bash: "deny", task: "deny", skill: { "find-skills": "deny" } });
  });

  test("GET 返回更新后的 permission", async () => {
    await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "demo", data: { permission: { read: { "*.env": "deny" }, bash: "ask" } } }),
    }));
    const getRes = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "demo" }),
    }));
    const getJson = await getRes.json();
    expect(getJson.data.permission).toEqual({ read: { "*.env": "deny" }, bash: "ask" });
  });

  test("不发送 permission 时旧值保留", async () => {
    await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "demo", data: { model: "gpt-4o" } }),
    }));
    expect(_agentStore.demo.permission).toEqual({ bash: "allow", task: "deny", skill: { "find-skills": "allow" } });
  });

  test("发送空对象覆盖旧 permission", async () => {
    await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "demo", data: { permission: {} } }),
    }));
    expect(_agentStore.demo.permission).toEqual({});
  });
});
