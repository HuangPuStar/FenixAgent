import { describe, test, expect, beforeEach, mock } from "bun:test";

let _agentStore: Record<string, unknown> = {};
let _topLevelFields: Record<string, unknown> = {};

mock.module("../auth/middleware", () => ({
  sessionAuth: async (c: any, next: any) => {
    c.set("user", { id: "test-user", email: "test@test.com", name: "Test" });
    await next();
  },
}));

mock.module("../services/config", () => ({
  getSection: async (section: string) => section === "agent" ? _agentStore : undefined,
  setSection: async (_section: string, data: unknown) => { _agentStore = data as Record<string, unknown>; },
  replaceSection: async (_section: string, data: unknown) => { _agentStore = data as Record<string, unknown>; },
  setTopLevelField: async (field: string, value: unknown) => { _topLevelFields[field] = value; },
  getConfig: async () => ({ ..._topLevelFields, agent: _agentStore }),
}));

const agentsRoute = (await import("../routes/web/config/agents")).default;

describe("Agents Config Route", () => {
  beforeEach(() => {
    _agentStore = {
      build: { model: "claude-sonnet-4-6", prompt: "Build code", tools: ["Read", "Write"], steps: 50, mode: "primary" },
      plan: { model: "claude-opus-4-7", prompt: "Plan tasks", steps: 30 },
      "code-reviewer": { model: "gpt-4o", prompt: "Review code" },
    };
    _topLevelFields = { default_agent: "build" };
  });

  test("list 返回所有 agent", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.default_agent).toBe("build");
    expect(json.data.agents).toHaveLength(3);
    expect(json.data.agents[0]).toMatchObject({ name: "build", builtIn: true });
    expect(json.data.agents[2]).toMatchObject({ name: "code-reviewer", builtIn: false });
  });

  test("get 已有 agent", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "build" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("build");
    expect(json.data.builtIn).toBe(true);
    expect(json.data.model).toBe("claude-sonnet-4-6");
    expect(json.data.prompt).toBe("Build code");
    expect(json.data.tools).toEqual(["Read", "Write"]);
    expect(json.data.steps).toBe(50);
  });

  test("get 不存在 agent", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "nonexistent" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("set 更新已有 agent", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "build", data: { steps: 100 } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_agentStore.build.steps).toBe(100);
    // Original fields preserved
    expect(_agentStore.build.model).toBe("claude-sonnet-4-6");
  });

  test("set 不存在 agent", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "ghost", data: { model: "x" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("set 校验 steps 无效", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "build", data: { steps: 999 } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("create 新 agent", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name: "reviewer", data: { model: "gpt-4o", mode: "subagent" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_agentStore.reviewer).toBeDefined();
    expect(_agentStore.reviewer.mode).toBe("subagent");
  });

  test("create 已存在", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name: "build", data: { model: "x" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("ALREADY_EXISTS");
  });

  test("create 无效 name", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name: "Invalid!", data: { model: "x" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("delete 自定义 agent", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "code-reviewer" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect("code-reviewer" in _agentStore).toBe(false);
  });

  test("delete 内置 agent 返回 FORBIDDEN", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "build" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("FORBIDDEN");
  });

  test("delete 不存在 agent", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "ghost" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("set_default 已有 agent", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_default", name: "plan" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_topLevelFields.default_agent).toBe("plan");
  });

  test("set_default 不存在 agent", async () => {
    const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_default", name: "nope" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});
