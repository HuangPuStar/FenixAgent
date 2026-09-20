import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createWebInstancesRoutes } from "../routes/web/instances";
import type { AgentInstanceRecord } from "../server/repositories/agent-instance";
import { resetAgentRuntimePort, stubAgentRuntimePort } from "../server/testing";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

// 路由的运行能力取自运行 port 绑定（1.4 W3b）：本用例用 port 替身替换实例动作，
// 不再有 `setWebInstanceRouteDeps` 这样的第二个替换点。
// 1.5c 随路由一同迁入本包（原 `apps/server/src/__tests__/`），认证改用包内守卫替身——
// 路由的守卫由宿主注入，包内用例只能注入替身。
const webInstanceRoutes = createWebInstancesRoutes({
  authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin(),
});

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
    setTestAuth({ organizationId: "org-1", userId: "user-1" });
  });

  afterEach(() => {
    resetAgentRuntimePort();
    resetTestAuth();
    resetAllStubs();
  });

  // Default 实例停止只释放 runtime，必须保留持久记录且不能调用删除。
  test("POST /instances/:id/stop stops a Default runtime without deleting it", async () => {
    const calls: string[] = [];
    stubAgentRuntimePort({
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
    stubAgentRuntimePort({
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
