import { afterEach, expect, test } from "bun:test";
import type { AgentController } from "@fenix/orchestration";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import type { AgentInstanceRecord } from "../server/repositories/agent-instance";
import {
  agentInstanceRuntimeCoordinator,
  bindAgentInstanceRuntimeOperations,
  resetAgentInstanceRuntimeOperations,
} from "../server/services/agent-instance-service";
import { stubCoreRuntimeFacade } from "../server/testing";
import {
  resetOrchestrationInstanceDeps,
  setOrchestrationInstanceDeps,
  stopInstanceViaController,
} from "../services/orchestration-instance";

const record: AgentInstanceRecord = {
  id: "stop-confirmation",
  environmentId: "env",
  ownerUserId: "user",
  creationSource: "user",
  name: "default",
  isDefault: true,
  createdByUserId: "user",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

afterEach(() => {
  resetAllStubs();
  resetAgentInstanceRuntimeOperations();
  resetOrchestrationInstanceDeps();
});

// 快照标为 stopped 但 fence 不匹配不能触发误杀；活动快照应通过 strict 活动停止通道确认。
test("停止中 core 世代切换不得静默成功", async () => {
  let reads = 0;
  const instance = { ...record, id: "stop-fence-mismatch" };
  stubCoreRuntimeFacade({
    getInstance: () => {
      reads += 1;
      return reads === 1 ? null : { status: "running", runtimeGeneration: 99, serverEpoch: "other" };
    },
  });
  bindAgentInstanceRuntimeOperations({
    async spawnInstance() {},
    hasActiveInstance: () => false,
    async stopInstance() {
      throw new Error("must not stop a different generation");
    },
  });
  await expect(agentInstanceRuntimeCoordinator.stopRuntime(instance, "strict")).rejects.toThrow("fence mismatch");
  expect(agentInstanceRuntimeCoordinator.snapshot(instance.id).state).toBe("unknown");
});

// 两个 owner 均确认不存在时重复 stop 可成功，不得以 coordinator 世代差异制造误报。
test("core 与 controller 均无实例时幂等停止", async () => {
  const instance = { ...record, id: "stop-confirmed-absent" };
  stubCoreRuntimeFacade({ getInstance: () => null });
  bindAgentInstanceRuntimeOperations({
    async spawnInstance() {},
    hasActiveInstance: () => false,
    async stopInstance() {
      throw new Error("absent runtime must not be stopped");
    },
  });
  await agentInstanceRuntimeCoordinator.stopRuntime(instance, "strict");
  await agentInstanceRuntimeCoordinator.stopRuntime(instance, "strict");
  expect(agentInstanceRuntimeCoordinator.snapshot(instance.id).state).toBe("stopped");
});

// INSTANCE_NOT_FOUND 只有在快照也不存在时才是幂等成功，丢失 runtime entry 必须阻止回收实时状态。
test("core 丢失 runtime entry 与不存在实例使用不同 strict 结果", async () => {
  let exists = true;
  let reclaimed = 0;
  const missing = Object.assign(new Error("runtime entry missing"), { code: "INSTANCE_NOT_FOUND" });
  stubCoreRuntimeFacade({
    async stopInstance() {
      throw missing;
    },
    getInstance: () => (exists ? { status: "error" } : null),
  });
  setOrchestrationInstanceDeps({
    getOrchestrationController: () => ({ async stopInstance() {} }) as unknown as AgentController,
    closeRelayConnectionsForStoppedInstance: async () => {
      reclaimed += 1;
    },
    reclaimYjsDocs: async () => {
      reclaimed += 1;
    },
  });
  await expect(stopInstanceViaController(record.id, "strict")).rejects.toThrow("Failed to fully stop");
  expect(reclaimed).toBe(0);
  exists = false;
  await stopInstanceViaController(record.id, "strict");
  expect(reclaimed).toBe(2);
});
