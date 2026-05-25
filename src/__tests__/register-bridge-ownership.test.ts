import { beforeEach, describe, expect, mock, test } from "bun:test";
import { AppError } from "../errors";

const mockEnvRepoGetById = mock(async (): Promise<any> => null);
const mockEnvRepoCreate = mock(async (d: any) => ({
  id: "env_new",
  secret: "rest_abc",
  status: "active",
  ...d,
}));
const mockEnvRepoUpdate = mock(async () => {});
const mockSessionRepoList = mock(async () => []);

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

describe("registerBridge ownership verification", () => {
  beforeEach(() => {
    mockEnvRepoGetById.mockClear();
    mockEnvRepoUpdate.mockClear();
    mockEnvRepoCreate.mockClear();
  });

  // authEnvironmentId 属于其他用户时抛出 FORBIDDEN
  test("throws FORBIDDEN when authEnvironmentId belongs to another user", async () => {
    mockEnvRepoGetById.mockResolvedValueOnce({
      id: "env_other",
      userId: "user_other",
      secret: "rest_other",
      status: "idle",
    });

    try {
      await registerBridge({
        authEnvironmentId: "env_other",
        userId: "user_self",
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("FORBIDDEN");
      expect((err as AppError).statusCode).toBe(403);
      expect(mockEnvRepoUpdate).not.toHaveBeenCalled();
    }
  });

  // authEnvironmentId 属于当前用户时正常更新
  test("updates environment when ownership matches", async () => {
    mockEnvRepoGetById.mockResolvedValueOnce({
      id: "env_self",
      userId: "user_self",
      secret: "rest_self",
      status: "idle",
    });
    mockSessionRepoList.mockResolvedValueOnce([]);

    const result = await registerBridge({
      authEnvironmentId: "env_self",
      userId: "user_self",
    });

    expect(result.environment_id).toBe("env_self");
    expect(result.status).toBe("active");
    expect(mockEnvRepoUpdate).toHaveBeenCalledTimes(1);
  });

  // authEnvironmentId 不存在时回退到新建环境
  test("falls back to creating new env when authEnvironmentId not found", async () => {
    mockEnvRepoGetById.mockResolvedValueOnce(null);

    const result = await registerBridge({
      authEnvironmentId: "env_missing",
      userId: "user_self",
    });

    expect(result.environment_id).toBe("env_new");
    expect(mockEnvRepoCreate).toHaveBeenCalledTimes(1);
  });

  // 无 authEnvironmentId 时直接创建新环境
  test("creates new env when no authEnvironmentId provided", async () => {
    const result = await registerBridge({
      userId: "user_self",
      machine_name: "test-machine",
    });

    expect(result.environment_id).toBe("env_new");
    expect(mockEnvRepoCreate).toHaveBeenCalledTimes(1);
    expect(mockEnvRepoGetById).not.toHaveBeenCalled();
  });

  // system 用户拥有的环境也应拒绝非 owner
  test("rejects when environment owned by system user and request from different user", async () => {
    mockEnvRepoGetById.mockResolvedValueOnce({
      id: "env_system",
      userId: "system",
      secret: "rest_system",
      status: "idle",
    });

    try {
      await registerBridge({
        authEnvironmentId: "env_system",
        userId: "user_real",
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("FORBIDDEN");
    }
  });
});
