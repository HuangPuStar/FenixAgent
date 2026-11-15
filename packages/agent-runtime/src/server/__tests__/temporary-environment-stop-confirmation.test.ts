import { afterEach, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { registerCreatedTemporaryEnvironment } from "../../facades/temporary-environment-facade";
import { createAgentRuntimeModule } from "../../runtime";
import type { AgentInstanceRecord, IAgentInstanceRepo } from "../repositories/agent-instance";
import { AgentInstanceRuntimeCoordinator } from "../services/agent-instance-runtime-coordinator";
import {
  AgentInstanceService,
  agentInstanceService,
  bindAgentInstanceRuntimeOperations,
} from "../services/agent-instance-service";
import {
  stopTemporaryEnvironmentMaintenance,
  temporaryEnvironmentLifecycle,
} from "../services/temporary-environment-state";
import { initializeAgentRuntimeModuleConfig, stubCoreRuntimeFacade, stubEnvironmentRepo } from "../testing";

const instance: AgentInstanceRecord = {
  id: "inst_stop_confirmation",
  environmentId: "temp-confirm",
  ownerUserId: "user",
  creationSource: "api",
  name: "api",
  isDefault: false,
  createdByUserId: "user",
  createdAt: new Date(),
  updatedAt: new Date(),
};
afterEach(() => {
  stopTemporaryEnvironmentMaintenance();
  resetAllStubs();
});

function coldRuntimeFixture(suffix: string, failConfirmation = false) {
  const environmentId = `temp-confirm-${suffix}`;
  const record = { ...instance, id: `${instance.id}-${suffix}`, environmentId };
  initializeAgentRuntimeModuleConfig();
  createAgentRuntimeModule();
  bindAgentInstanceRuntimeOperations({
    spawnInstance: async () => {},
    stopInstance: async () => {},
    hasActiveInstance: () => false,
  });
  stubCoreRuntimeFacade({ getInstance: () => null });
  stubEnvironmentRepo({ getById: async () => ({ id: environmentId, expiresAt: new Date(0) }) });
  const confirmations: unknown[] = [];
  let writes = 0;
  stubDb({
    select: () => ({ from: () => ({ where: async () => [record] }) }),
    update: () => ({
      set: (value: unknown) => {
        return {
          where: async () => {
            if (failConfirmation && ++writes === 1) throw new Error("confirmation write failed");
            confirmations.push(value);
            return { rowCount: 1 };
          },
        };
      },
    }),
  });
  return { confirmations, environmentId, instanceId: record.id };
}

// 跨重启只剩持久身份时不能误写完成标记，待办必须留给后续真实确认。
test("TTL assembly retains historical work when runtime termination is unknown", async () => {
  const { confirmations, environmentId } = coldRuntimeFixture("historical");
  await expect(temporaryEnvironmentLifecycle.expire(environmentId)).rejects.toThrow(
    "Temporary environment stop failed",
  );
  expect(confirmations).toEqual([]);
});

// 本控制面提交的新建冷环境不可能含有上一控制面的进程，允许确认无需启动的环境。
test("TTL assembly can reclaim a newly created cold environment", async () => {
  const { confirmations, environmentId, instanceId } = coldRuntimeFixture("new");
  registerCreatedTemporaryEnvironment(environmentId, new Date(Date.now() + 60_000), instanceId);
  await temporaryEnvironmentLifecycle.expire(environmentId);
  expect(confirmations).toEqual([expect.objectContaining({ expiryReclaimedAt: expect.any(Date) })]);
});

// 创建回执可能晚于其他连接发起的启动，迟到的冷实例登记不能推翻已开始的运行代次。
test("late creation registration preserves an instance that has already started", async () => {
  const { environmentId, instanceId } = coldRuntimeFixture("late-creation");
  stubEnvironmentRepo({ getById: async () => ({ id: environmentId, expiresAt: new Date(Date.now() + 60_000) }) });
  await agentInstanceService.ensureInstanceRuntime({ ...instance, id: instanceId, environmentId });
  const running = agentInstanceService.getRuntimeSnapshot(instanceId);
  expect(running.state).toBe("running");
  registerCreatedTemporaryEnvironment(environmentId, new Date(Date.now() + 60_000), instanceId);
  expect(agentInstanceService.getRuntimeSnapshot(instanceId)).toEqual(running);
  expect(agentInstanceService.hasConfirmedRuntimeStop(instanceId)).toBe(false);
});

// 停止确认独立于新建登记，确认写入失败后仍能重试持久化，避免重新制造未知状态。
test("a confirmed cold stop survives loss of creation tracking before a persistence retry", async () => {
  const { confirmations, environmentId, instanceId } = coldRuntimeFixture("write-retry", true);
  registerCreatedTemporaryEnvironment(environmentId, new Date(Date.now() + 60_000), instanceId);
  await expect(temporaryEnvironmentLifecycle.expire(environmentId)).rejects.toThrow("confirmation write failed");
  stopTemporaryEnvironmentMaintenance();
  await temporaryEnvironmentLifecycle.expire(environmentId);
  expect(confirmations).toEqual([expect.objectContaining({ expiryReclaimedAt: expect.any(Date) })]);
});

// 瞬时读取失败不能抹掉已提交新实例的来源证明，下一轮应仍能确认冷实例无需回收进程。
test("a transient expiry read failure does not strand a newly created cold instance", async () => {
  const { confirmations, environmentId, instanceId } = coldRuntimeFixture("read-retry");
  let markRead!: () => void;
  const failedRead = new Promise<void>((resolve) => {
    markRead = resolve;
  });
  let reads = 0;
  stubEnvironmentRepo({
    getById: async () => {
      if (++reads === 1) {
        markRead();
        throw new Error("transient read failure");
      }
      return { id: environmentId, expiresAt: new Date(0) };
    },
  });
  registerCreatedTemporaryEnvironment(environmentId, new Date(0), instanceId);
  await failedRead;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await temporaryEnvironmentLifecycle.expire(environmentId);
  expect(confirmations).toEqual([expect.objectContaining({ expiryReclaimedAt: expect.any(Date) })]);
});

// 默认停止快照与无实体停止成功都不构成旧进程已退出的证明。
test("an empty runtime registry cannot manufacture termination confirmation", async () => {
  const coordinator = new AgentInstanceRuntimeCoordinator({ start: async () => {}, stop: async () => {} });
  expect(coordinator.snapshot(instance.id).state).toBe("stopped");
  expect(coordinator.hasConfirmedStop(instance.id)).toBe(false);
  await coordinator.stopRuntime(instance, "strict");
  expect(coordinator.hasConfirmedStop(instance.id)).toBe(false);
});

// 未观察到实体的启动失败只能结束本次尝试，不能证明历史进程已经退出。
test("a failed start without an observed runtime cannot confirm termination", async () => {
  const coordinator = new AgentInstanceRuntimeCoordinator({
    start: async () => {
      throw new Error("prepare failed");
    },
    stop: async () => {},
    hasActiveRuntime: () => false,
  });
  await expect(coordinator.startRuntime(instance)).rejects.toThrow("prepare failed");
  expect(coordinator.snapshot(instance.id).state).toBe("stopped");
  expect(coordinator.hasConfirmedStop(instance.id)).toBe(false);
});

// 启动部分成功后确实停止了已观察实体，才允许后续到期回收使用这份确认。
test("a failed start confirms termination after stopping an observed runtime", async () => {
  let present = false;
  const coordinator = new AgentInstanceRuntimeCoordinator({
    start: async () => {
      present = true;
      throw new Error("startup handshake failed");
    },
    stop: async () => {
      present = false;
    },
    hasActiveRuntime: () => present,
  });
  await expect(coordinator.startRuntime(instance)).rejects.toThrow("startup handshake failed");
  expect(present).toBe(false);
  expect(coordinator.hasConfirmedStop(instance.id)).toBe(true);
});

// 启动期间先收到权威死亡事件时，迟到的补偿不能抹掉同代次已有的退出确认。
test("a late failed-start cleanup preserves an earlier authoritative death confirmation", async () => {
  let markStarted!: () => void;
  let failStart!: (error: Error) => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const starting = new Promise<void>((_resolve, reject) => {
    failStart = reject;
  });
  const coordinator = new AgentInstanceRuntimeCoordinator({
    start: async () => {
      markStarted();
      await starting;
    },
    stop: async () => {},
    hasActiveRuntime: () => false,
  });
  const operation = coordinator.startRuntime(instance);
  await started;
  coordinator.handleRuntimeDeath(instance.id, coordinator.snapshot(instance.id).runtimeGeneration);
  expect(coordinator.hasConfirmedStop(instance.id)).toBe(true);
  failStart(new Error("startup failed after runtime death"));
  await expect(operation).rejects.toThrow("startup failed after runtime death");
  expect(coordinator.hasConfirmedStop(instance.id)).toBe(true);
});

// 普通用户实例入口不得扩展临时环境，避免插入没有冷实例来源确认的第二个实例。
test.each([
  "temp-user-instance",
  "regular-user-instance",
])("user instance creation enforces environment kind: %s", async (environmentId) => {
  stubEnvironmentRepo({ getById: async () => ({ id: environmentId, expiresAt: new Date(Date.now() + 60_000) }) });
  const rows: AgentInstanceRecord[] = [];
  const created = { ...instance, environmentId, creationSource: "user" as const, name: "additional" };
  const repository = {
    insert: async () => {
      rows.push(created);
      return created;
    },
  } as IAgentInstanceRepo;
  const service = new AgentInstanceService(
    repository,
    new AgentInstanceRuntimeCoordinator({ start: async () => {}, stop: async () => {} }),
  );
  const creation = service.createUserInstance({
    environmentId,
    ownerUserId: "user",
    actorUserId: "user",
    name: "additional",
  });
  if (environmentId.startsWith("temp-")) {
    await expect(creation).rejects.toMatchObject({ code: "INSTANCE_NOT_FOUND", statusCode: 404 });
    expect(rows).toEqual([]);
  } else {
    expect(await creation).toEqual(created);
    expect(rows).toEqual([created]);
  }
});

// 停止已观察实体才产生证明，新运行代次不能沿用旧停止确认。
test("observed runtime termination is confirmed until the next start", async () => {
  let present = false;
  const coordinator = new AgentInstanceRuntimeCoordinator({
    start: async () => {
      present = true;
    },
    stop: async () => {
      present = false;
    },
    hasActiveRuntime: () => present,
  });
  await coordinator.startRuntime(instance);
  expect(coordinator.hasConfirmedStop(instance.id)).toBe(false);
  await coordinator.stopRuntime(instance, "strict");
  expect(coordinator.hasConfirmedStop(instance.id)).toBe(true);
  await coordinator.startRuntime(instance);
  expect(coordinator.hasConfirmedStop(instance.id)).toBe(false);
});
