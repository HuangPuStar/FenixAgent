// 测试 setMcpServerEnabled 返回 boolean
import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockWhere = mock(() => ({ returning: () => [{ id: "s1" }] }));
const mockSet = mock(() => ({ where: mockWhere }));
const mockDbUpdate = mock(() => ({ set: mockSet }));

mock.module("../db", () => ({
  db: { update: mockDbUpdate },
}));

mock.module("../db/schema", () => ({
  mcpServer: {
    userId: "user_id",
    name: "name",
    enabled: "enabled",
    updatedAt: "updated_at",
    id: "id",
  },
  mcpTool: {},
}));

// drizzle-orm 必须在 mcp-server 导入前 mock
mock.module("drizzle-orm", () => ({
  eq: (col: any, val: any) => ({ col, val }),
  and: (...conds: any[]) => conds,
  sql: (strings: TemplateStringsArray, ...values: any[]) => ({ strings, values }),
}));

const { setMcpServerEnabled } = await import("../services/config/mcp-server");

describe("setMcpServerEnabled boolean return", () => {
  test("returns true when server exists", async () => {
    mockWhere.mockImplementation(() => ({ returning: () => [{ id: "s1" }] }));
    const result = await setMcpServerEnabled("u1", "my-server", true);
    expect(result).toBe(true);
  });

  test("returns false when server does not exist", async () => {
    mockWhere.mockImplementation(() => ({ returning: () => [] }));
    const result = await setMcpServerEnabled("u1", "nonexistent", false);
    expect(result).toBe(false);
  });
});
