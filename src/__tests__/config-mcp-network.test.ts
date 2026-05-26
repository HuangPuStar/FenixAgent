import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";

// In-memory mock for MCP servers
let _mcpStore: Record<string, { type: string; config: Record<string, unknown>; enabled: boolean }> = {};

let _inspectResult: any = {
  reachable: true,
  protocol: true,
  serverName: "test-server",
  serverVersion: "1.0.0",
  tools: [{ name: "tool1", description: "desc1", inputSchema: { type: "object" } }],
  transport: "streamable-http" as const,
};

mock.module("../services/config-pg", () => ({
  getMcpServer: async (_ctx: any, name: string) => {
    const row = _mcpStore[name];
    return row ? { name, ...row } : null;
  },
  listMcpServers: async () => [],
  createMcpServer: async () => {},
  updateMcpServer: async () => {},
  deleteMcpServer: async () => [],
  setMcpServerEnabled: async () => [],
}));

mock.module("../services/mcp-inspector", () => ({
  inspectRemoteMcpServer: async (_url: string, _headers?: Record<string, string>, _timeout?: number) => {
    return _inspectResult;
  },
}));

// db mock with chainable query builder
const _mockDbState: { tools: any[] } = { tools: [] };

const mockSelect = mock(() => ({
  from: mock(() => ({
    where: mock(async () => _mockDbState.tools),
  })),
}));

const mockDelete = mock(() => ({
  where: mock(async () => {}),
}));

const mockInsert = mock(() => ({
  values: mock(async () => {}),
}));

mock.module("../db", () => ({
  db: {
    select: mockSelect,
    delete: mockDelete,
    insert: mockInsert,
    transaction: async (fn: (tx: any) => Promise<any>) => {
      // 模拟事务：直接执行 fn，传入 mock db 作为 tx
      const tx = {
        delete: mockDelete,
        insert: mockInsert,
      };
      return fn(tx);
    },
  },
}));

mock.module("../db/schema", () => ({
  mcpTool: {
    id: "id",
    serverName: "server_name",
    toolName: "tool_name",
    description: "description",
    inputSchema: "input_schema",
    inspectedAt: "inspected_at",
  },
}));

mock.module("drizzle-orm", () => ({
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ sql: strings.join("?"), params: values }),
  eq: (_col: string, _val: string) => ({ col: _col, val: _val }),
  and: (..._conds: any[]) => _conds,
}));

const mcpRoute = (await import("../routes/web/config/mcp")).default;

function postRequest(body: Record<string, unknown>) {
  return mcpRoute.handle(
    new Request("http://localhost/config/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("MCP Config Route - Network Actions", () => {
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
    _mcpStore = {
      "my-local": {
        type: "local",
        config: { type: "local", command: ["npx", "mcp-server"], environment: { KEY: "VALUE" }, timeout: 5000 },
        enabled: true,
      },
      "my-remote": {
        type: "remote",
        config: { type: "remote", url: "https://example.com/mcp", headers: { Auth: "Bearer t" }, timeout: 10000 },
        enabled: true,
      },
    };
    _inspectResult = {
      reachable: true,
      protocol: true,
      serverName: "test-server",
      serverVersion: "1.0.0",
      tools: [{ name: "tool1", description: "desc1", inputSchema: { type: "object" } }],
      transport: "streamable-http" as const,
    };
    _mockDbState.tools = [];
  });

  describe("test action", () => {
    test("remote 服务器可达且是 MCP 协议", async () => {
      _inspectResult = {
        reachable: true,
        protocol: true,
        serverName: "remote-mcp",
        serverVersion: "2.0.0",
        tools: [{ name: "tool1" }, { name: "tool2" }],
        transport: "sse",
      };

      const res = await postRequest({ action: "test", name: "my-remote" });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.name).toBe("my-remote");
      expect(json.data.reachable).toBe(true);
      expect(json.data.protocol).toBe(true);
      expect(json.data.serverName).toBe("remote-mcp");
      expect(json.data.serverVersion).toBe("2.0.0");
      expect(json.data.toolsCount).toBe(2);
      expect(json.data.transport).toBe("sse");
    });

    test("remote 服务器可达但非 MCP 协议", async () => {
      _inspectResult = {
        reachable: true,
        protocol: false,
        tools: [],
        message: "非 MCP 协议",
      };

      const res = await postRequest({ action: "test", name: "my-remote" });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.reachable).toBe(true);
      expect(json.data.protocol).toBe(false);
      expect(json.data.message).toBe("非 MCP 协议");
    });

    test("remote 服务器不可达", async () => {
      _inspectResult = {
        reachable: false,
        protocol: false,
        tools: [],
        message: "Connection refused",
      };

      const res = await postRequest({ action: "test", name: "my-remote" });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.reachable).toBe(false);
      expect(json.data.protocol).toBe(false);
      expect(json.data.message).toBe("Connection refused");
    });

    test("local 服务器命令可用", async () => {
      const res = await postRequest({ action: "test", name: "my-local" });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.name).toBe("my-local");
      expect(json.data.reachable).toBe(true);
      expect(json.data.message).toContain("npx");
    });

    test("local 服务器命令未找到", async () => {
      _mcpStore["bad-cmd"] = {
        type: "local",
        config: { type: "local", command: ["nonexistent-command-xyz-12345"] },
        enabled: true,
      };

      const res = await postRequest({ action: "test", name: "bad-cmd" });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.reachable).toBe(false);
      expect(json.data.message).toContain("nonexistent-command-xyz-12345");
      expect(json.data.message).toContain("未找到");
    });

    test("不存在的服务器", async () => {
      const res = await postRequest({ action: "test", name: "ghost" });
      const json = await res.json();

      expect(json.success).toBe(false);
      expect(json.error.code).toBe("NOT_FOUND");
    });
  });

  describe("test_url action", () => {
    test("URL 缺失返回错误", async () => {
      const res = await postRequest({ action: "test_url" });
      const json = await res.json();

      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("URL is required");
    });

    test("连接成功（reachable + protocol）", async () => {
      _inspectResult = {
        reachable: true,
        protocol: true,
        serverName: "url-server",
        serverVersion: "3.0.0",
        tools: [{ name: "t1" }, { name: "t2" }, { name: "t3" }],
        transport: "streamable-http",
      };

      const res = await postRequest({
        action: "test_url",
        url: "https://example.com/mcp",
        headers: { Auth: "Bearer tok" },
        timeout: 5000,
      });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.reachable).toBe(true);
      expect(json.data.protocol).toBe(true);
      expect(json.data.serverName).toBe("url-server");
      expect(json.data.serverVersion).toBe("3.0.0");
      expect(json.data.toolsCount).toBe(3);
      expect(json.data.transport).toBe("streamable-http");
    });

    test("连接失败（reachable: false）", async () => {
      _inspectResult = {
        reachable: false,
        protocol: false,
        tools: [],
        message: "ECONNREFUSED",
      };

      const res = await postRequest({ action: "test_url", url: "https://unreachable.example.com/mcp" });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.reachable).toBe(false);
      expect(json.data.protocol).toBe(false);
      expect(json.data.message).toBe("ECONNREFUSED");
    });
  });

  describe("inspect action", () => {
    test("非 remote 类型拒绝（local server）", async () => {
      const res = await postRequest({ action: "inspect", name: "my-local" });
      const json = await res.json();

      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toContain("remote");
    });

    test("连接失败返回错误", async () => {
      _inspectResult = {
        reachable: false,
        protocol: false,
        tools: [],
        message: "Timeout",
      };

      const res = await postRequest({ action: "inspect", name: "my-remote" });
      const json = await res.json();

      expect(json.success).toBe(false);
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(json.error.message).toBe("Timeout");
    });

    test("连接成功并存储 tools", async () => {
      _inspectResult = {
        reachable: true,
        protocol: true,
        serverName: "inspected-server",
        serverVersion: "1.5.0",
        tools: [
          { name: "tool-a", description: "Tool A", inputSchema: { type: "object", properties: {} } },
          { name: "tool-b", description: "Tool B", inputSchema: null },
        ],
        transport: "sse",
      };

      const res = await postRequest({ action: "inspect", name: "my-remote" });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.name).toBe("my-remote");
      expect(json.data.serverInfo.name).toBe("inspected-server");
      expect(json.data.serverInfo.version).toBe("1.5.0");
      expect(json.data.tools).toHaveLength(2);
      expect(json.data.tools[0].name).toBe("tool-a");
      expect(json.data.tools[1].name).toBe("tool-b");
      expect(json.data.transport).toBe("sse");
      expect(json.data.stored).toBe(true);

      expect(mockDelete).toHaveBeenCalled();
      expect(mockInsert).toHaveBeenCalled();
    });

    test("连接成功但无 tools（不调用 insert）", async () => {
      _inspectResult = {
        reachable: true,
        protocol: true,
        serverName: "empty-server",
        serverVersion: "0.1.0",
        tools: [],
        transport: "streamable-http",
      };

      mockInsert.mockClear();

      const res = await postRequest({ action: "inspect", name: "my-remote" });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.tools).toHaveLength(0);
      expect(json.data.stored).toBe(true);
      expect(mockInsert).not.toHaveBeenCalled();
    });

    test("不存在的服务器", async () => {
      const res = await postRequest({ action: "inspect", name: "ghost" });
      const json = await res.json();

      expect(json.success).toBe(false);
      expect(json.error.code).toBe("NOT_FOUND");
    });
  });

  describe("list_tools action", () => {
    test("返回工具列表", async () => {
      const now = new Date();
      _mockDbState.tools = [
        {
          id: "1",
          toolName: "read_file",
          description: "Read a file",
          inputSchema: '{"type":"object"}',
          inspectedAt: now,
        },
        { id: "2", toolName: "write_file", description: "Write a file", inputSchema: null, inspectedAt: now },
      ];

      const res = await postRequest({ action: "list_tools", name: "my-remote" });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.name).toBe("my-remote");
      expect(json.data.tools).toHaveLength(2);
      expect(json.data.tools[0].id).toBe("1");
      expect(json.data.tools[0].toolName).toBe("read_file");
      expect(json.data.tools[0].description).toBe("Read a file");
      expect(json.data.tools[0].inputSchema).toBe('{"type":"object"}');
      expect(json.data.tools[0].inspectedAt).toBe(now.getTime());
      expect(json.data.tools[1].toolName).toBe("write_file");
      expect(json.data.tools[1].inputSchema).toBeNull();
    });

    test("空工具列表", async () => {
      _mockDbState.tools = [];

      const res = await postRequest({ action: "list_tools", name: "empty-server" });
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.data.tools).toHaveLength(0);
    });
  });
});
