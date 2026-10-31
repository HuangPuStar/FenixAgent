import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError } from "@fenix/platform-sdk";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createWebEnvironmentsRoutes } from "../routes/web/environments";
import type { AgentInstanceRecord, IAgentInstanceRepo } from "../server/repositories/agent-instance";
import type { EnvironmentRecord } from "../server/repositories/environment";
import { AgentInstanceRuntimeCoordinator } from "../server/services/agent-instance-runtime-coordinator";
import { AgentInstanceService } from "../server/services/agent-instance-service";
import { resetAgentRuntimePort, stubAgentRuntimePort } from "../server/testing";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

const instance: AgentInstanceRecord = {
  id: "inst_00000000000000000000000000000003",
  environmentId: "env-1",
  ownerUserId: "user-1",
  creationSource: "user",
  name: "default",
  isDefault: true,
  createdByUserId: "user-1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const environment: EnvironmentRecord = {
  id: instance.environmentId,
  name: "environment",
  description: null,
  workspacePath: "/workspace",
  agentConfigId: null,
  secret: "",
  machineName: null,
  directory: null,
  branch: null,
  gitRepoUrl: null,
  workerType: "local",
  capabilities: null,
  status: "idle",
  username: null,
  userId: instance.ownerUserId,
  organizationId: "org-1",
  autoStart: false,
  lastPollAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const repository: IAgentInstanceRepo = {
  getById: async (id) => (id === instance.id ? instance : undefined),
  findOwnedById: async (id, owner) => (id === instance.id && owner === instance.ownerUserId ? instance : undefined),
  findByCreationKey: async () => instance,
  findOrCreateByCreationKey: async () => instance,
  insert: async () => {
    throw new Error("Entering must reuse the persistent instance");
  },
  listByOwner: async () => [instance],
  listByEnvironment: async () => [instance],
  deleteById: async () => {
    throw new Error("Entering must retain the persistent instance");
  },
};
const routes = createWebEnvironmentsRoutes({ authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin() });

/** 经真实路由、实例选择和生命周期仲裁验证进入动作，只替换持久化与进程启动。 */
function createHarness() {
  let starts = 0;
  let stops = 0;
  let failStart = false;
  const coordinator = new AgentInstanceRuntimeCoordinator({
    async start() {
      starts += 1;
      if (failStart) throw new Error("ACP connection closed");
    },
    async stop() {
      stops += 1;
    },
  });
  const service = new AgentInstanceService(repository, coordinator);
  stubAgentRuntimePort({
    getOwnedEnvironment: async (id, organizationId, userId) => {
      if (id !== environment.id || organizationId !== environment.organizationId || userId !== environment.userId) {
        throw new NotFoundError(id);
      }
      return environment;
    },
    ensureInstance: async (input) => {
      const selected = await service.resolveInstanceForOperation(input);
      await service.ensureInstanceRuntime(selected, input.signal, input.activation);
      return selected;
    },
    getRuntimeSnapshot: (id) => service.getRuntimeSnapshot(id),
  });
  return {
    service,
    coordinator,
    counts: () => ({ starts, stops }),
    setFailStart(value: boolean) {
      failStart = value;
    },
  };
}

/** 发起控制台主动进入请求；省略 uid 时选择原有默认实例。 */
function enter(instanceUid?: string, environmentId = environment.id) {
  return routes.handle(
    new Request(`http://localhost/environments/${environmentId}/enter`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(instanceUid ? { instanceUid } : {}),
    }),
  );
}

beforeEach(() => {
  resetAllStubs();
  setTestAuth({ organizationId: "org-1", userId: instance.ownerUserId });
});
afterEach(() => {
  resetAgentRuntimePort();
  resetTestAuth();
  resetAllStubs();
});

describe("主动进入已停止实例", () => {
  for (const requestedUid of [undefined, instance.id]) {
    // 停止阻止后台恢复，但点击进入应使用同一持久身份启动，成功后恢复正常连接。
    test(`手动停止后主动进入${requestedUid ? "指定" : "默认"}实例成功`, async () => {
      const harness = createHarness();
      await harness.service.ensureInstanceRuntime(instance);
      await harness.service.stopInstanceRuntime(instance);
      await expect(harness.service.ensureInstanceRuntime(instance)).rejects.toMatchObject({ code: "INSTANCE_STOPPED" });

      const response = await enter(requestedUid);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        data: { instanceUid: instance.id, environmentId: instance.environmentId, status: "running" },
      });
      await harness.service.ensureInstanceRuntime(instance);
      expect(harness.counts()).toEqual({ starts: 2, stops: 1 });
    });
  }

  // 进入正在运行的实例只复用连接，不得误用 restart 中断已有回复。
  test("重复进入运行实例不停止也不重复启动", async () => {
    const harness = createHarness();
    await harness.service.ensureInstanceRuntime(instance);

    expect((await enter(instance.id)).status).toBe(200);
    expect((await enter(instance.id)).status).toBe(200);
    expect(harness.counts()).toEqual({ starts: 1, stops: 0 });
  });

  // 主动启动失败必须保留停止意图和原始错误，后台不得代替用户无限重试。
  test("进入启动失败后后台仍被拦截，用户可再次进入", async () => {
    const harness = createHarness();
    await harness.service.stopInstanceRuntime(instance);
    harness.setFailStart(true);

    const response = await enter(instance.id);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("ACP connection closed");
    expect(harness.service.getRuntimeSnapshot(instance.id).lastFailure).toBe("ACP connection closed");
    await expect(harness.service.ensureInstanceRuntime(instance)).rejects.toMatchObject({ code: "INSTANCE_STOPPED" });

    harness.setFailStart(false);
    expect((await enter(instance.id)).status).toBe(200);
    await harness.service.ensureInstanceRuntime(instance);
    expect(harness.counts().starts).toBe(2);
  });

  // 主动启动权只能在环境和实例归属校验通过后使用，不能绕过组织或用户隔离。
  test("其他组织、用户或环境的进入请求不会启动实例", async () => {
    const harness = createHarness();
    setTestAuth({ organizationId: "other-org", userId: instance.ownerUserId });
    expect((await enter(instance.id)).status).toBe(404);
    setTestAuth({ organizationId: "org-1", userId: "other-user" });
    expect((await enter(instance.id)).status).toBe(404);
    setTestAuth({ organizationId: "org-1", userId: instance.ownerUserId });
    expect((await enter(instance.id, "other-env")).status).toBe(404);
    expect((await enter("inst_00000000000000000000000000000004")).status).toBe(404);
    expect(harness.counts()).toEqual({ starts: 0, stops: 0 });
  });

  // 多次点击进入共享启动槽位，不能为同一 uid 启动多个进程。
  test("并发主动进入只启动一个运行实体", async () => {
    const harness = createHarness();
    await harness.service.stopInstanceRuntime(instance);

    const responses = await Promise.all([enter(instance.id), enter(instance.id), enter(instance.id)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(harness.counts()).toEqual({ starts: 1, stops: 1 });
  });

  // 用户进入应复用已经在飞的正常启动，不能取消后台启动后再创建一代进程。
  test("主动进入复用已在飞的后台启动", async () => {
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let starts = 0;
    let stops = 0;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        starts += 1;
        await gate;
      },
      async stop() {
        stops += 1;
      },
    });
    const service = new AgentInstanceService(repository, coordinator);
    const ensuring = service.ensureInstanceRuntime(instance);
    const entering = service.ensureInstanceRuntime(instance, undefined, "explicit");
    const results = Promise.allSettled([ensuring, entering]);
    releaseStart();

    expect((await results).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect({ starts, stops }).toEqual({ starts: 1, stops: 0 });
  });

  // 用户在启动中再点停止时，以较新的停止意图为准，迟到启动不得解除门禁。
  test("停止抢占主动进入后，迟到启动不能复活实例", async () => {
    let releaseStart!: () => void;
    let notifyStarting!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarting = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        notifyStarting();
        await gate;
      },
      async stop() {},
    });
    const service = new AgentInstanceService(repository, coordinator);
    await service.stopInstanceRuntime(instance);

    const entering = service.ensureInstanceRuntime(instance, undefined, "explicit");
    const result = entering.then(
      () => "started",
      () => "cancelled",
    );
    await started;
    const stopping = service.stopInstanceRuntime(instance);
    releaseStart();
    await stopping;

    expect(await result).toBe("cancelled");
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
    await expect(service.ensureInstanceRuntime(instance)).rejects.toMatchObject({ code: "INSTANCE_STOPPED" });
  });

  // 未确认停止的旧进程必须先清理，避免主动进入生成第二个运行实体。
  test("unknown 主动进入必须先确认旧运行实体已停止", async () => {
    let starts = 0;
    let failStop = true;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        starts += 1;
      },
      async stop() {
        if (failStop) throw new Error("stop unconfirmed");
      },
    });
    const service = new AgentInstanceService(repository, coordinator);
    await service.ensureInstanceRuntime(instance);
    await expect(service.stopInstanceRuntime(instance)).rejects.toThrow("stop unconfirmed");
    await expect(service.ensureInstanceRuntime(instance, undefined, "explicit")).rejects.toThrow("stop unconfirmed");
    expect(starts).toBe(1);

    failStop = false;
    await service.ensureInstanceRuntime(instance, undefined, "explicit");
    await service.ensureInstanceRuntime(instance);
    expect(starts).toBe(2);
  });
});
