import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── handleAcpIdentify 并行 markActive + getEnvironment 验证 ──

const mockEnvUpdate = mock(async (_id: string, _patch: Record<string, unknown>) => {});
const mockEnvGetById = mock(async () => ({
  id: "env_bound",
  userId: "user1",
  workerType: "acp",
  capabilities: { mode: "full" },
}));

mock.module("../repositories", () => ({
  environmentRepo: {
    getById: mockEnvGetById,
    update: mockEnvUpdate,
    getBySecret: mock(async () => null),
    create: mock(async () => ({})),
    delete: mock(async () => true),
    listActive: mock(async () => []),
    listActiveByUsername: mock(async () => []),
    listByUserId: mock(async () => []),
  },
  sessionRepo: {
    listByEnvironment: mock(async () => []),
    create: mock(async (p: { id: string }) => ({ id: p.id })),
    bindOwner: mock(async () => {}),
  },
}));

mock.module("../services/session", () => ({
  findOrCreateForEnvironment: mock(async () => ({ id: "ses_1" })),
}));

mock.module("../logger", () => ({
  log: mock(() => {}),
  error: mock(() => {}),
}));

const { handleAcpIdentify } = await import("../services/environment-acp");

describe("handleAcpIdentify parallel optimization", () => {
  beforeEach(() => {
    mockEnvUpdate.mockClear();
    mockEnvGetById.mockClear();
  });

  // bound 环境：并行执行 markActive 和 getById
  test("bound env: markActive and getById run in parallel", async () => {
    const callOrder: string[] = [];
    mockEnvUpdate.mockImplementation(async () => {
      callOrder.push("update_start");
      await new Promise((r) => setTimeout(r, 2));
      callOrder.push("update_end");
    });
    mockEnvGetById.mockImplementation(async () => {
      callOrder.push("get_start");
      await new Promise((r) => setTimeout(r, 2));
      callOrder.push("get_end");
      return { id: "env_bound", userId: "user1", workerType: "acp", capabilities: { mode: "full" } };
    });

    const result = await handleAcpIdentify({
      agentId: "env_bound",
      userId: "user1",
      boundEnvId: "env_bound",
    });

    // 返回正确结果
    expect(result.envId).toBe("env_bound");
    expect(result.capabilities).toEqual({ mode: "full" });

    // 并行：get_start 应在 update_end 之前（否则是串行）
    const getStartIdx = callOrder.indexOf("get_start");
    const updateEndIdx = callOrder.indexOf("update_end");
    expect(getStartIdx).toBeLessThan(updateEndIdx);
  });

  // bound 环境：markActive 更新 status
  test("bound env: update called with active status", async () => {
    await handleAcpIdentify({
      agentId: "env_bound",
      userId: "user1",
      boundEnvId: "env_bound",
    });

    expect(mockEnvUpdate).toHaveBeenCalledWith("env_bound", expect.objectContaining({ status: "active" }));
  });

  // unbound 环境：串行验证 + active
  test("unbound env: validates ownership and marks active", async () => {
    mockEnvGetById.mockResolvedValueOnce({
      id: "agent_1",
      userId: "user1",
      workerType: "acp",
      capabilities: { tools: true },
    } as any);

    const result = await handleAcpIdentify({
      agentId: "agent_1",
      userId: "user1",
      boundEnvId: null,
    });

    expect(result.envId).toBe("agent_1");
    expect(result.capabilities).toEqual({ tools: true });
  });
});
