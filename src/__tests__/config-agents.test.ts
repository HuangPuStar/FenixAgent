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

  // ── Task 2: Permission 类型定义与 Agents API 兼容转换 测试 ──

  describe("handleList — description 和 color 字段", () => {
    test("handleList 返回 description 和 color", async () => {
      _agentStore["test-agent"] = { model: "gpt-4o", mode: "primary", description: "测试描述", color: "primary" };
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      }));
      const json = await res.json();
      const agent = json.data.agents.find((a: any) => a.name === "test-agent");
      expect(agent.description).toBe("测试描述");
      expect(agent.color).toBe("primary");
    });

    test("handleList 无 description/color 时返回 null", async () => {
      _agentStore["no-meta"] = { model: "gpt-4o" };
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      }));
      const json = await res.json();
      const agent = json.data.agents.find((a: any) => a.name === "no-meta");
      expect(agent.description).toBe(null);
      expect(agent.color).toBe(null);
    });
  });

  describe("handleGet — tools→permission 转换", () => {
    test("handleGet tools→permission 转换", async () => {
      _agentStore["tool-agent"] = { tools: { bash: true, read: false } };
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", name: "tool-agent" }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.permission).toEqual({ bash: "allow", read: "deny" });
    });

    test("handleGet 无 tools 无 permission", async () => {
      _agentStore["no-perm"] = { model: "gpt-4o" };
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", name: "no-perm" }),
      }));
      const json = await res.json();
      expect(json.data.permission).toBe(null);
    });

    test("handleGet 已有 permission 不转换", async () => {
      _agentStore["perm-agent"] = { tools: { bash: true }, permission: { bash: "ask" } };
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", name: "perm-agent" }),
      }));
      const json = await res.json();
      expect(json.data.permission).toEqual({ bash: "ask" });
    });

    test("handleGet 新增字段默认值", async () => {
      _agentStore["new-fields"] = { model: "gpt-4o" };
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", name: "new-fields" }),
      }));
      const json = await res.json();
      expect(json.data.variant).toBe(null);
      expect(json.data.temperature).toBe(null);
      expect(json.data.top_p).toBe(null);
      expect(json.data.disable).toBe(false);
      expect(json.data.hidden).toBe(false);
      expect(json.data.color).toBe(null);
      expect(json.data.description).toBe(null);
    });

    test("handleGet 新增字段有值", async () => {
      _agentStore["val-agent"] = { model: "gpt-4o", variant: "thinking", temperature: 0.7, top_p: 0.9, disable: true, hidden: true, color: "#FF5500", description: "测试" };
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", name: "val-agent" }),
      }));
      const json = await res.json();
      expect(json.data.variant).toBe("thinking");
      expect(json.data.temperature).toBe(0.7);
      expect(json.data.top_p).toBe(0.9);
      expect(json.data.disable).toBe(true);
      expect(json.data.hidden).toBe(true);
      expect(json.data.color).toBe("#FF5500");
      expect(json.data.description).toBe("测试");
    });
  });

  describe("handleSet — 白名单过滤和新字段", () => {
    test("handleSet 写入 permission 并清除 tools", async () => {
      _agentStore["set-agent"] = { model: "gpt-4o", tools: { bash: true } };
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "set-agent", data: { permission: { bash: "deny" } } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(_agentStore["set-agent"].tools).toBeUndefined();
      expect(_agentStore["set-agent"].permission).toEqual({ bash: "deny" });
    });

    test("handleSet 过滤非法字段", async () => {
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "build", data: { model: "x", evil: "hack" } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(_agentStore.build.model).toBe("x");
      expect(_agentStore.build.evil).toBeUndefined();
    });

    test("handleSet 校验 temperature 无效", async () => {
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "build", data: { temperature: 3 } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toBe("INVALID_TEMPERATURE");
    });

    test("handleSet 校验 top_p 无效", async () => {
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "build", data: { top_p: 1.5 } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toBe("INVALID_TOP_P");
    });

    test("handleSet 校验 color 无效", async () => {
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "build", data: { color: "notacolor" } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toBe("INVALID_COLOR");
    });

    test("handleSet 校验 color 合法 hex", async () => {
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "build", data: { color: "#FF5500" } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(_agentStore.build.color).toBe("#FF5500");
    });

    test("handleSet 校验 color 合法预设", async () => {
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "build", data: { color: "primary" } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(_agentStore.build.color).toBe("primary");
    });

    test("handleSet 写入新字段", async () => {
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "build", data: { variant: "thinking", disable: true, description: "测试" } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(_agentStore.build.variant).toBe("thinking");
      expect(_agentStore.build.disable).toBe(true);
      expect(_agentStore.build.description).toBe("测试");
    });
  });

  describe("handleCreate — 白名单过滤和新字段校验", () => {
    test("handleCreate 白名单过滤", async () => {
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "filtered-create", data: { model: "gpt-4o", evil: "hack" } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(_agentStore["filtered-create"].model).toBe("gpt-4o");
      expect(_agentStore["filtered-create"].evil).toBeUndefined();
    });

    test("handleCreate 校验新字段", async () => {
      const res = await agentsRoute.request(new Request("http://localhost/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "bad-temp", data: { temperature: 5 } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });
  });
});
