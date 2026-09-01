import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import type { AgentInstanceRecord } from "../repositories";
import { resetAllStubs } from "../test-utils/helpers";

const {
  default: webInstanceRoutes,
  resetWebInstanceRouteDeps,
  setWebInstanceRouteDeps,
} = await import("../routes/web/instances");

const defaultInstance: AgentInstanceRecord = {
  id: "inst_00000000000000000000000000000001",
  environmentId: "env-1",
  ownerUserId: "user-1",
  creationSource: "user",
  name: "default",
  isDefault: true,
  createdByUserId: "user-1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function request(path: string, method: "POST" | "DELETE") {
  return webInstanceRoutes.handle(new Request(`http://localhost${path}`, { method }));
}

describe("Web Instance runtime actions", () => {
  beforeEach(() => {
    resetAllStubs();
    resetWebInstanceRouteDeps();
    setTestAuth({
      user: { id: "user-1", email: "user@fenix.com", name: "User" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
  });

  afterEach(() => {
    resetWebInstanceRouteDeps();
    resetTestAuth();
    resetAllStubs();
  });

  // Default 实例停止只释放 runtime，必须保留持久记录且不能调用删除。
  test("POST /instances/:id/stop stops a Default runtime without deleting it", async () => {
    const calls: string[] = [];
    setWebInstanceRouteDeps({
      getOwnedInstance: async () => defaultInstance,
      getOwnedEnvironment: async () => ({ id: defaultInstance.environmentId }) as never,
      stopInstanceRuntime: async (instance, mode) => {
        calls.push(`stop:${instance.id}:${mode}`);
      },
      deleteInstance: async () => {
        calls.push("delete");
      },
    });

    const response = await request(`/instances/${defaultInstance.id}/stop`, "POST");

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ success: true, data: null });
    expect(calls).toEqual([`stop:${defaultInstance.id}:strict`]);
  });

  // Default 实例重启必须复用原 uid，不能通过 delete + spawn 模拟重启。
  test("POST /instances/:id/restart restarts a Default runtime with the same identity", async () => {
    const calls: string[] = [];
    setWebInstanceRouteDeps({
      getOwnedInstance: async () => defaultInstance,
      getOwnedEnvironment: async () => ({ id: defaultInstance.environmentId }) as never,
      restartInstanceRuntime: async (instance) => {
        calls.push(`restart:${instance.id}`);
      },
      deleteInstance: async () => {
        calls.push("delete");
      },
    });

    const response = await request(`/instances/${defaultInstance.id}/restart`, "POST");

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ success: true, data: null });
    expect(calls).toEqual([`restart:${defaultInstance.id}`]);
  });
});
