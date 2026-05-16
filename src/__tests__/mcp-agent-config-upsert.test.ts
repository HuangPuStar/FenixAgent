import { test, expect, mock, describe, beforeEach } from "bun:test";

// ── mock.module 必须在 import 被测模块之前注册 ──

// 模拟 Drizzle schema 中的表列标识符
const mockMcpServerTable = {
  userId: "user_id",
  name: "name",
};

const mockAgentConfigTable = {
  userId: "user_id",
  name: "name",
};

// 统一 mock chain：db.insert(table) → .values(data) → .onConflictDoUpdate(opts)
const mockOnConflictDoUpdate = mock(() => Promise.resolve());
const mockValues = mock(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockInsert = mock(() => ({ values: mockValues }));

mock.module("../db", () => ({
  db: { insert: mockInsert },
}));

mock.module("../db/schema", () => ({
  mcpServer: mockMcpServerTable,
  agentConfig: mockAgentConfigTable,
}));

// mcp-server.ts imports parseJsonb from ./jsonb（相对于 services/config/）
mock.module("../services/config/jsonb", () => ({
  parseJsonb: (v: unknown) => v,
}));

// agent-config.ts imports resolveAgentKnowledgePolicy from ../agent-knowledge（相对于 services/config/）
mock.module("../services/agent-knowledge", () => ({
  resolveAgentKnowledgePolicy: () => ({ searchFirst: false, maxResults: 5, defaultNamespaces: [] }),
}));

import { createMcpServer } from "../services/config/mcp-server";
import { createAgentConfig } from "../services/config/agent-config";

function clearAllMocks() {
  mockInsert.mockClear();
  mockValues.mockClear();
  mockOnConflictDoUpdate.mockClear();
}

describe("createMcpServer — onConflictDoUpdate 幂等 upsert", () => {
  beforeEach(clearAllMocks);

  // createMcpServer 调用 insert 时传入包含 userId、name、type、config、enabled、updatedAt 的 values
  test("inserts with values including userId, name, type, config, enabled, updatedAt", async () => {
    await createMcpServer("user-1", "my-server", "local", { command: ["npx", "test"] });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(mockMcpServerTable);
    expect(mockValues).toHaveBeenCalledTimes(1);

    const valuesArg = (mockValues.mock.calls as any[][])[0][0] as Record<string, unknown>;
    expect(valuesArg.userId).toBe("user-1");
    expect(valuesArg.name).toBe("my-server");
    expect(valuesArg.type).toBe("local");
    expect(valuesArg.config).toEqual({ command: ["npx", "test"] });
    expect(valuesArg.enabled).toBe(true);
    expect(valuesArg.updatedAt).toBeInstanceOf(Date);
  });

  // onConflictDoUpdate 的 target 应该是 [mcpServer.userId, mcpServer.name]
  test("onConflictDoUpdate target is [mcpServer.userId, mcpServer.name]", async () => {
    await createMcpServer("user-1", "my-server", "remote", { url: "http://example.com" });
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);

    const [conflictArg] = (mockOnConflictDoUpdate.mock.calls as any[][])[0] as [Record<string, unknown>];
    expect(conflictArg.target).toEqual(["user_id", "name"]);
  });

  // onConflictDoUpdate set 包含 type、config、updatedAt 但不包含 userId/name（冲突目标列不参与更新）
  test("onConflictDoUpdate set includes type, config, updatedAt but NOT userId/name", async () => {
    const config = { url: "http://example.com" };
    await createMcpServer("user-1", "my-server", "remote", config);
    const setArg = ((mockOnConflictDoUpdate.mock.calls as any[][])[0][0] as Record<string, unknown>).set as Record<string, unknown>;

    expect(setArg.type).toBe("remote");
    expect(setArg.config).toBe(config);
    expect(setArg.updatedAt).toBeInstanceOf(Date);
    expect("userId" in setArg).toBe(false);
    expect("name" in setArg).toBe(false);
  });
});

describe("createAgentConfig — onConflictDoUpdate 幂等 upsert", () => {
  beforeEach(clearAllMocks);

  // createAgentConfig 调用 insert 时传入包含 userId、name、updatedAt 的 values
  test("inserts with values including userId, name, updatedAt", async () => {
    await createAgentConfig("user-1", "general", { model: "gpt-4" });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(mockAgentConfigTable);
    expect(mockValues).toHaveBeenCalledTimes(1);

    const valuesArg = (mockValues.mock.calls as any[][])[0][0] as Record<string, unknown>;
    expect(valuesArg.userId).toBe("user-1");
    expect(valuesArg.name).toBe("general");
    expect(valuesArg.updatedAt).toBeInstanceOf(Date);
  });

  // onConflictDoUpdate 的 target 应该是 [agentConfig.userId, agentConfig.name]
  test("onConflictDoUpdate target is [agentConfig.userId, agentConfig.name]", async () => {
    await createAgentConfig("user-1", "general", { model: "gpt-4" });
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);

    const [conflictArg] = (mockOnConflictDoUpdate.mock.calls as any[][])[0] as [Record<string, unknown>];
    expect(conflictArg.target).toEqual(["user_id", "name"]);
  });

  // onConflictDoUpdate set 包含 settable 字段（如 model、prompt）和 updatedAt
  test("onConflictDoUpdate set includes settable fields (model, prompt) and updatedAt", async () => {
    await createAgentConfig("user-1", "general", {
      model: "gpt-4",
      prompt: "You are helpful",
      steps: 10,
    });
    const setArg = ((mockOnConflictDoUpdate.mock.calls as any[][])[0][0] as Record<string, unknown>).set as Record<string, unknown>;

    expect(setArg.model).toBe("gpt-4");
    expect(setArg.prompt).toBe("You are helpful");
    expect(setArg.steps).toBe(10);
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });
});
