import { describe, expect, test } from "bun:test";
import type { McpInspectResult, McpToolItem } from "../services/mcp-inspector";

describe("MCP Inspector - Types and Structure", () => {
  test("McpInspectResult has correct shape for unreachable server", () => {
    const result: McpInspectResult = {
      reachable: false,
      protocol: false,
      tools: [],
      message: "Connection refused",
    };
    expect(result.reachable).toBe(false);
    expect(result.protocol).toBe(false);
    expect(result.tools).toHaveLength(0);
    expect(result.message).toBe("Connection refused");
    expect(result.transport).toBeUndefined();
  });

  test("McpInspectResult has correct shape for successful inspection", () => {
    const tools: McpToolItem[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
      { name: "list_files", description: "List files" },
    ];
    const result: McpInspectResult = {
      reachable: true,
      protocol: true,
      serverName: "test-server",
      serverVersion: "1.0.0",
      tools,
      transport: "streamable-http",
    };
    expect(result.reachable).toBe(true);
    expect(result.protocol).toBe(true);
    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("read_file");
    expect(result.tools[0].inputSchema).toBeDefined();
    expect(result.tools[1].inputSchema).toBeUndefined();
    expect(result.transport).toBe("streamable-http");
  });

  test("McpInspectResult supports sse transport", () => {
    const result: McpInspectResult = {
      reachable: true,
      protocol: true,
      tools: [],
      transport: "sse",
    };
    expect(result.transport).toBe("sse");
  });

  test("McpToolItem has optional fields", () => {
    const minimal: McpToolItem = { name: "ping" };
    expect(minimal.name).toBe("ping");
    expect(minimal.description).toBeUndefined();
    expect(minimal.inputSchema).toBeUndefined();
  });
});

describe("MCP Inspector - URL validation", () => {
  test("rejects empty URL", () => {
    expect(() => new URL("")).toThrow();
  });

  test("accepts valid HTTP URL", () => {
    const url = new URL("http://localhost:3000/sse");
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("localhost");
  });

  test("accepts valid HTTPS URL", () => {
    const url = new URL("https://api.example.com/mcp");
    expect(url.protocol).toBe("https:");
  });
});
