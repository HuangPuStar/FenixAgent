import { afterEach, expect, test } from "bun:test";
import type { LaunchInstanceRequest } from "@fenix/core";
import type { AgentController, Instance } from "@fenix/orchestration";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import type { AgentInstanceRecord } from "../server/repositories/agent-instance";
import type { EnvironmentRecord, IEnvironmentRepo } from "../server/repositories/environment";
import { AgentInstanceRuntimeCoordinator } from "../server/services/agent-instance-runtime-coordinator";
import { initializeAgentRuntimeModuleConfig, stubCoreRuntimeFacade } from "../server/testing";
import { globalInstanceRegistry } from "../services/instance-registry";
import {
  resetOrchestrationInstanceDeps,
  setOrchestrationInstanceDeps,
  spawnInstanceViaController,
  stopInstanceViaController,
} from "../services/orchestration-instance";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const record: AgentInstanceRecord = {
  id: "inst_start_cancellation",
  environmentId: "environment-cancellation",
  ownerUserId: "user-cancellation",
  creationSource: "api",
  name: "primary",
  isDefault: false,
  createdByUserId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

afterEach(() => {
  resetOrchestrationInstanceDeps();
  resetAllStubs();
  globalInstanceRegistry.clear();
});

for (const boundary of ["environment", "launch-spec", "core-launch", "supplement"]) {
  // 真正启动桥接的各异步边界被停止抢占时，controller/core/supplement 必须全部回收。
  test(`停止等待 ${boundary} 恢复并清理启动副作用`, async () => {
    initializeAgentRuntimeModuleConfig();
    const reached = deferred();
    const resume = deferred();
    const pause = async (stage: string) => {
      if (stage !== boundary) return;
      reached.resolve();
      await resume.promise;
    };
    let controllerActive = false;
    let processAlive = false;
    const requests: LaunchInstanceRequest[] = [];
    const instance = { instanceId: record.id, machineId: "local-default" } as Instance;
    const controller = {
      async spawnInstance() {
        await pause("environment");
        controllerActive = true;
        return instance;
      },
      async stopInstance() {
        controllerActive = false;
      },
    } as unknown as AgentController;
    stubCoreRuntimeFacade({
      async launchInstance(request: LaunchInstanceRequest) {
        requests.push(request);
        await pause("core-launch");
        processAlive = true;
        return { instanceId: record.id };
      },
      async stopInstance() {
        processAlive = false;
      },
      getInstance: () => null,
      listInstances: () => [],
    });
    setOrchestrationInstanceDeps({
      getOrchestrationController: () => controller,
      async buildAgentLaunchSpecForCore() {
        await pause("launch-spec");
        return { workspace: "/tmp/audit-cancellation", env: {}, agent: { name: "test" } } as unknown as AgentLaunchSpec;
      },
      environmentRepo: {
        async getById() {
          await pause("supplement");
          return { organizationId: "org-cancellation", userId: record.ownerUserId } as EnvironmentRecord;
        },
      } as unknown as IEnvironmentRepo,
      async closeRelayConnectionsForStoppedInstance() {},
      async reclaimYjsDocs() {},
    });
    const coordinator = new AgentInstanceRuntimeCoordinator({
      start: (persistent, generation, signal) =>
        spawnInstanceViaController(persistent.environmentId, persistent.ownerUserId, "interactive", {
          instanceUid: persistent.id,
          runtimeGeneration: generation,
          serverEpoch: "audit-epoch",
          signal,
        }).then(() => undefined),
      stop: (instanceId) => stopInstanceViaController(instanceId, "strict"),
    });
    const starting = coordinator.ensureRuntime(record).catch((error: unknown) => error);
    await reached.promise;
    let stopped = false;
    const stopping = coordinator.stopRuntime(record, "strict").then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resume.resolve();
    await Promise.all([starting, stopping]);
    expect(processAlive).toBe(false);
    expect(controllerActive).toBe(false);
    expect(globalInstanceRegistry.get(record.id)).toBeUndefined();
    expect(coordinator.snapshot(record.id).state).toBe("stopped");
    for (const request of requests) {
      expect(request).toMatchObject({ runtimeGeneration: 1, serverEpoch: "audit-epoch" });
    }
    if (boundary === "environment" || boundary === "launch-spec") expect(requests).toHaveLength(0);
    else expect(requests).toHaveLength(1);
  });
}
