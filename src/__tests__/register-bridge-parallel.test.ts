import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockEnvRepoGetById = mock(async (): Promise<any> => null);
const mockEnvRepoCreate = mock(async (d: any) => ({
  id: "env_new",
  secret: "rest_abc",
  status: "active",
  ...d,
}));
const mockEnvRepoUpdate = mock(async () => {});
const mockSessionRepoList = mock(async (): Promise<Array<{ id: string }>> => []);

mock.module("../repositories", () => ({
  environmentRepo: {
    getById: mockEnvRepoGetById,
    create: mockEnvRepoCreate,
    update: mockEnvRepoUpdate,
  },
  sessionRepo: {
    listByEnvironment: mockSessionRepoList,
    create: mock(async (d: any) => ({ id: "ses_new", ...d })),
  },
}));

mock.module("./session", () => ({
  findOrCreateForEnvironment: mock(async () => ({ id: "ses_new" })),
}));

mock.module("./environment-core", () => ({
  deleteEnvironment: mock(async () => {}),
  toResponse: mock((r: any) => r),
}));

import { registerBridge } from "../services/environment-acp";

describe("registerBridge existing env parallel queries", () => {
  beforeEach(() => {
    mockEnvRepoGetById.mockClear();
    mockEnvRepoUpdate.mockClear();
    mockSessionRepoList.mockClear();
  });

  // existing env 路径：update 和 listByEnvironment 并行调用
  test("calls update and listByEnvironment concurrently for existing env", async () => {
    const callOrder: string[] = [];
    mockEnvRepoUpdate.mockImplementation(async () => {
      callOrder.push("update_start");
      await new Promise((r) => setTimeout(r, 2));
      callOrder.push("update_end");
    });
    mockSessionRepoList.mockImplementation(async () => {
      callOrder.push("list_start");
      await new Promise((r) => setTimeout(r, 2));
      callOrder.push("list_end");
      return [{ id: "ses_existing" }] as Array<{ id: string }>;
    });

    mockEnvRepoGetById.mockResolvedValueOnce({
      id: "env_par1",
      userId: "user_1",
      secret: "rest_par1",
      status: "idle",
    });

    const result = await registerBridge({
      authEnvironmentId: "env_par1",
      userId: "user_1",
      capabilities: { mode: "advanced" },
    });

    expect(mockEnvRepoUpdate).toHaveBeenCalledTimes(1);
    expect(mockSessionRepoList).toHaveBeenCalledTimes(1);
    const listCallArgs = mockSessionRepoList.mock.calls[0] as unknown as [string];
    expect(listCallArgs[0]).toBe("env_par1");

    expect(callOrder.indexOf("list_start")).toBeLessThan(callOrder.indexOf("update_end"));

    expect(result.environment_id).toBe("env_par1");
    expect(result.status).toBe("active");
    expect(result.session_id).toBe("ses_existing");
  });

  // existing env 路径：sessions 为空时 session_id 为 undefined
  test("returns undefined session_id when no sessions exist", async () => {
    mockEnvRepoGetById.mockResolvedValueOnce({
      id: "env_par2",
      userId: "user_1",
      secret: "rest_par2",
      status: "idle",
    });
    mockSessionRepoList.mockResolvedValueOnce([]);

    const result = await registerBridge({
      authEnvironmentId: "env_par2",
      userId: "user_1",
    });

    expect(result.session_id).toBeUndefined();
  });

  // existing env 路径：update 传入正确的 capabilities 和 maxSessions
  test("passes capabilities and maxSessions to update", async () => {
    mockEnvRepoGetById.mockResolvedValueOnce({
      id: "env_par3",
      userId: "user_1",
      secret: "rest_par3",
      status: "idle",
    });

    await registerBridge({
      authEnvironmentId: "env_par3",
      userId: "user_1",
      capabilities: { tools: true },
      max_sessions: 5,
    });

    const updateArgs = mockEnvRepoUpdate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(updateArgs[0]).toBe("env_par3");
    expect(updateArgs[1].capabilities).toEqual({ tools: true });
    expect(updateArgs[1].maxSessions).toBe(5);
    expect(updateArgs[1].status).toBe("active");
  });
});
