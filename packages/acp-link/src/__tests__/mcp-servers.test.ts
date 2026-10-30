import { describe, expect, test } from "bun:test";
import { readPlatformMcpServers } from "../mcp-servers";

describe("平台下发的 mcpServers", () => {
  // 平台只注入 http 条目；非数组与畸形条目必须丢弃，避免把未知结构交给 Agent。
  test("只保留结构完整的 http 条目", () => {
    const httpServer = { type: "http", name: "im", url: "http://rcs/mcp/im", headers: [] };

    expect(readPlatformMcpServers(undefined)).toEqual([]);
    expect(readPlatformMcpServers("not-an-array")).toEqual([]);
    expect(
      readPlatformMcpServers([
        httpServer,
        { type: "stdio", name: "local", command: "sh" },
        { type: "http", name: "missing-url" },
        { type: "http", url: "http://rcs/no-name" },
        { type: "http", name: "not-a-url", url: 42 },
        null,
      ]),
    ).toEqual([httpServer]);
  });
});
