// R34: config/mcp-server.ts countToolsByServer Number() 类型转换
import { describe, test, expect, mock } from "bun:test";

// mock db — 从 test 文件（src/__tests__/）出发，src/db 的相对路径是 ../db
const selectMock = mock(() => Promise.resolve([{ count: "7" } as { count: string | number }]));
mock.module("../db", () => ({
  db: { select: () => ({ from: () => ({ where: selectMock }) }) },
}));
mock.module("../db/schema", () => ({
  mcpServer: { userId: "user_id", name: "name", id: "id", type: "type", config: "config", enabled: "enabled" },
  mcpTool: { serverName: "server_name" },
}));

const { countToolsByServer } = await import("../services/config/mcp-server");

describe("countToolsByServer Number() 类型转换", () => {
  // PG count(*) 可能返回字符串，Number() 确保返回数字类型
  test("字符串 count 值转为数字", async () => {
    selectMock.mockResolvedValueOnce([{ count: "7" }]);
    const result = await countToolsByServer("test-server");
    expect(result).toBe(7);
    expect(typeof result).toBe("number");
  });

  // 空结果返回 0
  test("undefined row 返回 0", async () => {
    selectMock.mockResolvedValueOnce([]);
    const result = await countToolsByServer("nonexistent");
    expect(result).toBe(0);
  });

  // 数字 count 值正常返回
  test("数字 count 值正常返回", async () => {
    selectMock.mockResolvedValueOnce([{ count: 3 }]);
    const result = await countToolsByServer("test-server");
    expect(result).toBe(3);
  });
});
