import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

import { _deps, _resetDeps } from "../services/environment-acp";

const updateMock = mock(async (_id: string, _patch: Record<string, unknown>) => true);

beforeEach(() => {
  _deps.environmentRepo = {
    update: updateMock,
  } as any;
  _deps.sessionRepo = {} as any;
  _deps.findOrCreateForEnvironment = mock(async () => ({ id: "ses_1" }));
  _deps.deleteEnvironment = mock(async () => {});
});

afterEach(() => {
  _resetDeps();
});

import { handleAcpRegister } from "../services/environment-acp";

describe("handleAcpRegister bound 路径合并 UPDATE", () => {
  beforeEach(() => {
    updateMock.mockClear();
  });

  // bound 路径：合并 markEnvironmentActive + updateEnvironmentCapabilities 为单次调用
  test("bound 路径应只调用一次 environmentRepo.update", async () => {
    await handleAcpRegister({
      wsId: "ws_1",
      userId: "user_1",
      agentName: "test-agent",
      capabilities: { foo: "bar" },
      maxSessions: 5,
      boundEnvId: "env_bound",
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  test("bound 路径 update 应包含 status + lastPollAt + capabilities + maxSessions", async () => {
    await handleAcpRegister({
      wsId: "ws_1",
      userId: "user_1",
      agentName: "test-agent",
      capabilities: { foo: "bar" },
      maxSessions: 3,
      boundEnvId: "env_bound",
    });

    const patch = updateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.status).toBe("active");
    expect(patch.lastPollAt).toBeInstanceOf(Date);
    expect(patch.capabilities).toEqual({ foo: "bar" });
    expect(patch.maxSessions).toBe(3);
  });

  test("bound 路径 capabilities 为 undefined 时不更新 capabilities 列", async () => {
    await handleAcpRegister({
      wsId: "ws_1",
      userId: "user_1",
      agentName: "test-agent",
      boundEnvId: "env_bound",
    });

    const patch = updateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.capabilities).toBeUndefined();
    expect(patch.maxSessions).toBeUndefined();
  });

  test("bound 路径返回 isNew: false", async () => {
    const result = await handleAcpRegister({
      wsId: "ws_1",
      userId: "user_1",
      agentName: "test-agent",
      boundEnvId: "env_bound",
    });
    expect(result.isNew).toBe(false);
    expect(result.envId).toBe("env_bound");
  });
});
