import { describe, test, expect, beforeEach, mock } from "bun:test";

// In-memory mock for agent configs and user config
let _agentStore: Record<string, any> = {};
let _userConfig: { defaultAgent: string | null; currentModel: string | null; smallModel: string | null; permission: unknown } = { defaultAgent: null, currentModel: null, smallModel: null, permission: null };
let _agentKnowledgeBindings: Record<string, { knowledgeBaseId: string; priority: number; enabled: boolean }[]> = {};

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
  deleteAgentConfig: async (_userId: string, name: string) => {
    if (!(name in _agentStore)) return false;
    delete _agentStore[name];
    return true;
  },
  getUserConfig: async (_userId: string) => ({ ..._userConfig }),
  setUserConfig: async (_userId: string, patch: any) => {
    if (patch.defaultAgent !== undefined) _userConfig.defaultAgent = patch.defaultAgent;
    if (patch.currentModel !== undefined) _userConfig.currentModel = patch.currentModel;
    if (patch.smallModel !== undefined) _userConfig.smallModel = patch.smallModel;
    if (patch.permission !== undefined) _userConfig.permission = patch.permission;
  },
}));

mock.module("../services/agent-knowledge", () => ({
  InvalidKnowledgeBindingError: class InvalidKnowledgeBindingError extends Error {
    code = "INVALID_KNOWLEDGE_BINDINGS";
  },
  syncAgentKnowledgeBindings: async (_userId: string, agentName: string, knowledge: { knowledgeBaseIds: string[] } | null | undefined) => {
    const missingIds = (knowledge?.knowledgeBaseIds ?? []).filter((id) => id === "kb_missing");
    if (missingIds.length > 0) {
      const error = new Error(`知识库不存在或无权限访问: ${missingIds.join(", ")}`) as Error & { code: string };
      error.code = "INVALID_KNOWLEDGE_BINDINGS";
      throw error;
    }
    _agentKnowledgeBindings[agentName] = (knowledge?.knowledgeBaseIds ?? []).map((knowledgeBaseId, priority) => ({
      knowledgeBaseId,
      priority,
      enabled: true,
    }));
  },
  listAgentKnowledgeBindings: async (agentName: string) => _agentKnowledgeBindings[agentName] ?? [],
  countBindingsByKnowledgeBaseIds: async (knowledgeBaseIds: string[]) => {
    const counts: Record<string, number> = {};
    for (const knowledgeBaseId of knowledgeBaseIds) {
      counts[knowledgeBaseId] = 0;
    }
    for (const bindings of Object.values(_agentKnowledgeBindings)) {
      for (const binding of bindings) {
        if (binding.knowledgeBaseId in counts) {
          counts[binding.knowledgeBaseId] += 1;
        }
      }
    }
    return counts;
  },
  resolveAgentKnowledgePolicy: (policy?: { searchFirst?: boolean; maxResults?: number; defaultNamespaces?: string[] } | null) => ({
    searchFirst: policy?.searchFirst ?? true,
    maxResults: policy?.maxResults ?? 5,
    defaultNamespaces: policy?.defaultNamespaces ?? [],
  }),
}));

const agentsRoute = (await import("../routes/web/config/agents")).default;

describe("Agents Config Route", () => {
  beforeEach(() => {
    _agentStore = {
      build: { model: "claude-sonnet-4-6", prompt: "Build code", tools: ["Read", "Write"], steps: 50, mode: "primary" },
      plan: { model: "claude-opus-4-7", prompt: "Plan tasks", steps: 30 },
      "code-reviewer": { model: "gpt-4o", prompt: "Review code" },
    };
    _userConfig = { defaultAgent: "build", currentModel: null, smallModel: null, permission: null };
    _agentKnowledgeBindings = {};
  });

  test("list 返回所有 agent", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "nonexistent" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("set 更新已有 agent", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "build", data: { steps: 100 } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_agentStore.build.steps).toBe(100);
    expect(_agentStore.build.model).toBe("claude-sonnet-4-6");
  });

  test("set returns validation error when knowledge base ids are invalid", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "set",
        name: "build",
        data: {
          knowledge: {
            knowledgeBaseIds: ["kb_missing"],
            policy: { searchFirst: true, maxResults: 5 },
          },
        },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("INVALID_KNOWLEDGE_BINDINGS");
  });

  test("set 不存在 agent", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "ghost", data: { model: "x" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("set 校验 steps 无效", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "build", data: { steps: 999 } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("create 新 agent", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name: "build", data: { model: "x" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("ALREADY_EXISTS");
  });

  test("create 无效 name", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name: "Invalid!", data: { model: "x" } }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("delete 自定义 agent", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "code-reviewer" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect("code-reviewer" in _agentStore).toBe(false);
  });

  test("delete 内置 agent 返回 FORBIDDEN", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "build" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("FORBIDDEN");
  });

  test("delete 不存在 agent", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "ghost" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("set_default 已有 agent", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_default", name: "plan" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(_userConfig.defaultAgent).toBe("plan");
  });

  test("set_default 不存在 agent", async () => {
    const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_default", name: "nope" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  describe("handleList — description 和 color 字段", () => {
    test("handleList 返回 description 和 color", async () => {
      _agentStore["test-agent"] = { model: "gpt-4o", mode: "primary", description: "测试描述", color: "primary" };
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", name: "no-perm" }),
      }));
      const json = await res.json();
      expect(json.data.permission).toBe(null);
    });

    test("handleGet 已有 permission 不转换", async () => {
      _agentStore["perm-agent"] = { tools: { bash: true }, permission: { bash: "ask" } };
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", name: "perm-agent" }),
      }));
      const json = await res.json();
      expect(json.data.permission).toEqual({ bash: "ask" });
    });

    test("handleGet 新增字段默认值", async () => {
      _agentStore["new-fields"] = { model: "gpt-4o" };
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      _agentStore["val-agent"] = {
        model: "gpt-4o",
        variant: "thinking",
        temperature: 0.7,
        topP: 0.9,
        disable: true,
        hidden: true,
        color: "#FF5500",
        description: "测试",
        knowledge: { knowledgeBaseIds: ["kb_a"], policy: { searchFirst: false, maxResults: 3 } },
      };
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      expect(json.data.knowledge).toEqual({
        knowledgeBaseIds: ["kb_a"],
        policy: { searchFirst: false, maxResults: 3, defaultNamespaces: [] },
      });
    });
  });

  describe("handleSet — 白名单过滤和新字段", () => {
    test("handleSet 写入 permission", async () => {
      _agentStore["set-agent"] = { model: "gpt-4o", tools: { bash: true } };
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "build", data: { color: "#FF5500" } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(_agentStore.build.color).toBe("#FF5500");
    });

    test("handleSet 校验 color 合法预设", async () => {
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", name: "build", data: { color: "primary" } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(_agentStore.build.color).toBe("primary");
    });

    test("handleSet 写入新字段", async () => {
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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

    test("set 更新 knowledge 并覆盖旧绑定", async () => {
      _agentKnowledgeBindings.build = [{ knowledgeBaseId: "kb_old", priority: 0, enabled: true }];
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set",
          name: "build",
          data: {
            knowledge: {
              knowledgeBaseIds: ["kb_new_a", "kb_new_b"],
              policy: { searchFirst: false, maxResults: 8 },
            },
          },
        }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(_agentStore.build.knowledge).toEqual({
        knowledgeBaseIds: ["kb_new_a", "kb_new_b"],
        policy: { searchFirst: false, maxResults: 8, defaultNamespaces: [] },
      });
      expect(_agentKnowledgeBindings.build).toEqual([
        { knowledgeBaseId: "kb_new_a", priority: 0, enabled: true },
        { knowledgeBaseId: "kb_new_b", priority: 1, enabled: true },
      ]);
    });
  });

  describe("handleCreate — 白名单过滤和新字段校验", () => {
    test("handleCreate 白名单过滤", async () => {
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
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
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "bad-temp", data: { temperature: 5 } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    test("list 返回 knowledgeBaseCount", async () => {
      _agentKnowledgeBindings.build = [
        { knowledgeBaseId: "kb_a", priority: 0, enabled: true },
        { knowledgeBaseId: "kb_b", priority: 1, enabled: true },
      ];
      const res = await agentsRoute.handle(new Request("http://localhost/web/config/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      }));
      const json = await res.json();
      const build = json.data.agents.find((agent: any) => agent.name === "build");
      expect(build.knowledgeBaseCount).toBe(2);
    });
  });
});
