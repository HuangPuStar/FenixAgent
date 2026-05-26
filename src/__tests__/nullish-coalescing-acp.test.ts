import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockEnvRepoCreate = mock(async (d: any) => ({
  id: "env_1",
  secret: d.secret,
  status: "active",
  ...d,
}));

const mockEnvironmentRepo = {
  getById: mock(async () => null),
  create: mockEnvRepoCreate,
  update: mock(async () => {}),
  getBySecret: mock(async () => null),
  listActive: mock(async () => []),
  listActiveByUsername: mock(async () => []),
  listByUserId: mock(async () => []),
  delete: mock(async () => true),
};

mock.module("../repositories", () => ({
  environmentRepo: mockEnvironmentRepo,
  sessionRepo: {
    listByEnvironment: mock(async (): Promise<Array<{ id: string }>> => []),
    create: mock(async (d: any) => ({ id: "ses_1", ...d })),
  },
}));

mock.module("../services/session", () => ({
  findOrCreateForEnvironment: mock(async () => ({ id: "ses_1" })),
}));

mock.module("./environment-core", () => ({
  deleteEnvironment: mock(async () => {}),
  toResponse: mock((r: any) => r),
}));

import { registerBridge, registerEnvironment } from "../services/environment-acp";

describe("environment-acp nullish coalescing (|| → ??)", () => {
  beforeEach(() => {
    mockEnvRepoCreate.mockClear();
  });

  // registerEnvironment: worker_type 空字符串不被 || 吞掉
  test("registerEnvironment preserves empty string worker_type with ??", async () => {
    await registerEnvironment({
      worker_type: "",
      userId: "user_1",
      machine_name: "test",
    });

    const call = mockEnvRepoCreate.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0].workerType).toBe("");
  });

  // registerEnvironment: userId 空字符串不被 || 吞掉
  test("registerEnvironment preserves empty string userId with ??", async () => {
    await registerEnvironment({
      userId: "",
      machine_name: "test2",
    });

    const call = mockEnvRepoCreate.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0].userId).toBe("");
  });

  // registerEnvironment: undefined worker_type 回退到 metadata
  test("registerEnvironment falls back to metadata worker_type", async () => {
    await registerEnvironment({
      metadata: { worker_type: "custom" },
      userId: "user_2",
      machine_name: "test3",
    });

    const call = mockEnvRepoCreate.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0].workerType).toBe("custom");
  });

  // registerBridge: undefined worker_type + metadata 回退到 "acp"
  test("registerBridge falls back to 'acp' when both undefined", async () => {
    const _result = await registerBridge({
      userId: "user_3",
    });

    const call = mockEnvRepoCreate.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0].workerType).toBe("acp");
  });
});
