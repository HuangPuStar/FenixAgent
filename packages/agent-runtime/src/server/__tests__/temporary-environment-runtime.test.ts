import { afterEach, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import type { AgentInstanceRecord, IAgentInstanceRepo } from "../repositories/agent-instance";
import { AgentInstanceRuntimeCoordinator } from "../services/agent-instance-runtime-coordinator";
import { AgentInstanceService } from "../services/agent-instance-service";
import { TemporaryEnvironmentLifecycle } from "../services/temporary-environment-lifecycle";
import { stubEnvironmentRepo } from "../testing";

const instance: AgentInstanceRecord = {
  id: "inst_00000000000000000000000000000077",
  environmentId: "temp-runtime",
  ownerUserId: "user",
  creationSource: "api",
  name: "api",
  isDefault: false,
  createdByUserId: "user",
  createdAt: new Date(),
  updatedAt: new Date(),
};
afterEach(resetAllStubs);
// 期限内 idle 回收不续期，续期重用正在运行的实例，并在停止后恢复同一身份。
test("idle reclaim keeps expiry and renew reuses or restores the same instance", async () => {
  let expiresAt = new Date(Date.now() + 60000),
    starts = 0,
    stops = 0;
  stubEnvironmentRepo({ getById: async () => ({ id: instance.environmentId, expiresAt }) });
  const coordinator = new AgentInstanceRuntimeCoordinator({
    start: async () => {
      starts++;
    },
    stop: async () => {
      stops++;
    },
  });
  const service = new AgentInstanceService({} as IAgentInstanceRepo, coordinator);
  const lifecycle = new TemporaryEnvironmentLifecycle({
    markReclaimed: async () => {},
    read: async () => ({ id: instance.environmentId, expiresAt }),
    writeExpiry: async (_id, date) => {
      expiresAt = date;
    },
    stop: () => service.stopInstanceRuntime(instance, "strict"),
  });
  await service.ensureInstanceRuntime(instance);
  await lifecycle.renew(instance.environmentId, 60, () =>
    service.ensureInstanceRuntime(instance, undefined, "explicit"),
  );
  expect(starts).toBe(1);
  const saved = expiresAt.getTime();
  await service.reclaimInstanceRuntime(instance);
  expect(expiresAt.getTime()).toBe(saved);
  expect(stops).toBe(1);
  await lifecycle.renew(instance.environmentId, 60, () =>
    service.ensureInstanceRuntime(instance, undefined, "explicit"),
  );
  expect(starts).toBe(2);
  expect(coordinator.snapshot(instance.id).state).toBe("running");
  expiresAt = new Date(0);
  await lifecycle.expire(instance.environmentId);
  expect(coordinator.snapshot(instance.id).state).toBe("stopped");
  await lifecycle.renew(instance.environmentId, 60, () =>
    service.ensureInstanceRuntime(instance, undefined, "explicit"),
  );
  expect(starts).toBe(3);
});
// 失败的严格停止必须由下一次扫描继续尝试，不能删除身份或修改期限。
test("expiry retries an unconfirmed stop without changing the persisted deadline", async () => {
  const expiresAt = new Date(0);
  let attempts = 0;
  const lifecycle = new TemporaryEnvironmentLifecycle({
    markReclaimed: async () => {},
    read: async () => ({ id: "temp-retry", expiresAt }),
    writeExpiry: async () => {
      throw Error("must not renew");
    },
    stop: async () => {
      if (++attempts === 1) throw Error("unconfirmed");
    },
  });
  await expect(lifecycle.expire("temp-retry")).rejects.toThrow("unconfirmed");
  await lifecycle.expire("temp-retry");
  expect(attempts).toBe(2);
  expect(expiresAt.getTime()).toBe(0);
});

// 到期时取消已准入但排队等待旧 stop 的 restart，不能在回收完成后复活 Runtime。
test("expiry cancels a restart queued behind an in-flight stop", async () => {
  stubDb({ update: () => ({ set: () => ({ where: async () => ({ rowCount: 1 }) }) }) });
  let expiresAt = new Date(Date.now() + 60_000);
  let starts = 0;
  let finishStop!: () => void;
  let markStopping!: () => void;
  const stopping = new Promise<void>((resolve) => {
    markStopping = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    finishStop = resolve;
  });
  stubEnvironmentRepo({ getById: async () => ({ id: instance.environmentId, expiresAt }) });
  const coordinator = new AgentInstanceRuntimeCoordinator({
    start: async () => {
      starts++;
    },
    stop: async () => {
      markStopping();
      await stopGate;
    },
  });
  const service = new AgentInstanceService({} as IAgentInstanceRepo, coordinator);
  const { bindTemporaryEnvironmentStop, temporaryEnvironmentLifecycle } = await import(
    "../services/temporary-environment-state"
  );
  bindTemporaryEnvironmentStop(() => service.stopInstanceRuntime(instance, "strict"));
  await service.ensureInstanceRuntime(instance);
  const stop = service.stopInstanceRuntime(instance, "strict");
  await stopping;
  const restart = service.restartInstanceRuntime(instance);
  const restartResult = Promise.allSettled([restart]);
  // 确认 restart 已通过环境准入并在 coordinator 中等待 stop。
  await new Promise((resolve) => setTimeout(resolve, 0));
  expiresAt = new Date(0);
  const expired = temporaryEnvironmentLifecycle.expire(instance.environmentId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  finishStop();
  await Promise.all([stop, expired]);
  expect((await restartResult)[0]).toMatchObject({ status: "rejected", reason: { code: "ENVIRONMENT_EXPIRED" } });
  expect(starts).toBe(1);
  expect(coordinator.snapshot(instance.id).state).toBe("stopped");
});
