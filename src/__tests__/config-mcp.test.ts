import { describe, test, expect, beforeEach, mock } from "bun:test";

// In-memory mock for MCP servers
let _mcpStore: Record<string, { type: string; config: Record<string, unknown>; enabled: boolean }> = {};

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
  listMcpServers: async (_userId: string) => {
    return Object.entries(_mcpStore).map(([name, row]) => ({ name, ...row }));
  },
  getMcpServer: async (_userId: string, name: string) => {
    const row = _mcpStore[name];
    return row ? { name, ...row } : null;
  },
  createMcpServer: async (_userId: string, name: string, type: string, config: Record<string, unknown>) => {
    _mcpStore[name] = { type, config, enabled: true };
  },
  updateMcpServer: async (_userId: string, name: string, config: Record<string, unknown>) => {
    if (!_mcpStore[name]) return;
    _mcpStore[name].config = config;
  },
  deleteMcpServer: async (_userId: string, name: string) => {
    if (!(name in _mcpStore)) return false;
    delete _mcpStore[name];
    return true;
  },
  setMcpServerEnabled: async (_userId: string, name: string, enabled: boolean) => {
    if (!_mcpStore[name]) return false;
    _mcpStore[name].enabled = enabled;
    return true;
  },
}));

// db mock for toolsCount
const _mockDbState: { tools: any[] } = { tools: [] };
mock.module("../db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => _mockDbState.tools }) }),
    delete: () => ({ where: async () => {} }),
  },
}));
mock.module("../db/schema", () => ({
  mcpTool: { id: "id", serverName: "server_name" },
}));
mock.module("drizzle-orm", () => ({
  eq: (_col: string, _val: string) => ({ col: _col, val: _val }),
}));

const mcpRoute = (await import("../routes/web/config/mcp")).default;

describe("MCP Config Route", () => {
  beforeEach(() => {
    _mcpStore = {
      "my-local": { type: "local", config: { type: "local", command: ["npx", "mcp-server"], environment: { KEY: "VALUE" }, timeout: 5000 }, enabled: true },
      "another-local": { type: "local", config: { type: "local", command: ["node", "server.js"] }, enabled: true },
      "my-remote": { type: "remote", config: { type: "remote", url: "https://example.com/mcp", headers: { Auth: "Bearer t" } }, enabled: true },
    };
    _mockDbState.tools = [];
  });

  test("handleList 空配置", async () => {
    _mcpStore = {};
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.servers).toEqual([]);
  });

  test("handleList 含多个服务器", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.servers).toHaveLength(3);
    const local1 = json.data.servers.find((s: any) => s.name === "my-local");
    expect(local1.type).toBe("local");
    expect(local1.enabled).toBe(true);
    expect(local1.summary).toBe("npx");
    expect(local1.timeout).toBe(5000);
    const remote1 = json.data.servers.find((s: any) => s.name === "my-remote");
    expect(remote1.type).toBe("remote");
    expect(remote1.summary).toBe("https://example.com/mcp");
  });

  test("handleGet 存在的服务器", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "my-local" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("my-local");
    expect(json.data.config.type).toBe("local");
    expect(json.data.config.command).toEqual(["npx", "mcp-server"]);
  });

  test("handleGet 不存在的服务器", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "nonexistent" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("handleCreate 正常创建 local 服务器", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        name: "new-server",
        config: { type: "local", command: ["npx", "mcp-server"], environment: { K: "V" }, timeout: 5000 },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("new-server");
    expect(_mcpStore["new-server"]).toBeDefined();
    expect(_mcpStore["new-server"].config.command).toEqual(["npx", "mcp-server"]);
  });

  test("handleCreate 正常创建 remote 服务器", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        name: "remote-srv",
        config: { type: "remote", url: "https://example.com/mcp" },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("remote-srv");
    expect(_mcpStore["remote-srv"].config.url).toBe("https://example.com/mcp");
  });

  test("handleCreate 重名", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        name: "my-local",
        config: { type: "local", command: ["npx"] },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("ALREADY_EXISTS");
  });

  test("handleCreate 无效名称 UPPER_CASE", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        name: "UPPER_CASE",
        config: { type: "local", command: ["npx"] },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.error.message).toContain("Invalid server name");
  });

  test("handleCreate 无效配置缺少 type", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        name: "bad-config",
        config: { command: ["npx"] },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toBe("INVALID_CONFIG_TYPE");
  });

  test("handleCreate local 缺少 command", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        name: "no-cmd",
        config: { type: "local" },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toBe("INVALID_COMMAND");
  });

  test("handleCreate remote 缺少 url", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        name: "no-url",
        config: { type: "remote" },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toBe("INVALID_URL");
  });

  test("handleUpdate 正常更新", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update",
        name: "my-local",
        config: { type: "local", command: ["npx", "updated-server"], timeout: 10000 },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.name).toBe("my-local");
    expect(_mcpStore["my-local"].config.command).toEqual(["npx", "updated-server"]);
    expect(_mcpStore["my-local"].config.timeout).toBe(10000);
  });

  test("handleUpdate 不存在的服务器", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update",
        name: "ghost",
        config: { type: "local", command: ["npx"] },
      }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("handleDelete 正常删除", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "my-local" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect("my-local" in _mcpStore).toBe(false);
  });

  test("handleDelete 不存在的服务器", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", name: "ghost" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("handleEnable 正常启用", async () => {
    _mcpStore["my-local"].enabled = false;
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enable", name: "my-local" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(true);
    expect(_mcpStore["my-local"].enabled).toBe(true);
  });

  test("handleEnable 禁用变体（无原始配置）", async () => {
    _mcpStore["lost-server"] = { type: "disabled", config: { enabled: false }, enabled: false };
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "enable", name: "lost-server" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.error.message).toContain("original config lost");
  });

  test("handleDisable 正常禁用", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable", name: "my-local" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(false);
    expect(_mcpStore["my-local"].enabled).toBe(false);
  });

  test("handleDisable 不存在的服务器", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "disable", name: "ghost" }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("未知 action", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "unknown" }),
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  describe("isValidMcpName 边界", () => {
    test("空字符串 → 失败", async () => {
      const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "", config: { type: "local", command: ["npx"] } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    test("单字符 a → 成功", async () => {
      _mcpStore = {};
      const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "a", config: { type: "local", command: ["npx"] } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
    });

    test("my-server → 成功", async () => {
      _mcpStore = {};
      const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "my-server", config: { type: "local", command: ["npx"] } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(true);
    });

    test("my--server（连续连字符）→ 失败", async () => {
      const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "my--server", config: { type: "local", command: ["npx"] } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });

    test("以连字符开头 -abc → 失败", async () => {
      const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", name: "-abc", config: { type: "local", command: ["npx"] } }),
      }));
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
    });
  });

  test("validateMcpConfig 非对象输入 null", async () => {
    const res = await mcpRoute.handle(new Request("http://localhost/web/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", name: "test", config: null }),
    }));
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.message).toBe("INVALID_CONFIG");
  });
});
