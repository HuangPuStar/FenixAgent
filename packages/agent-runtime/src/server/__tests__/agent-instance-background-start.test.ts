import { afterEach, expect, test } from "bun:test";
import { isAgentExecutionIdleReclaimable } from "../../services/agent-execution-admission";
import { globalInstanceRegistry } from "../../services/instance-registry";
import type { AgentInstanceRecord } from "../repositories/agent-instance";
import {
  agentInstanceRuntimeCoordinator,
  agentInstanceService,
  bindAgentInstanceRuntimeOperations,
  resetAgentInstanceRuntimeOperations,
} from "../services/agent-instance-service";
import { resetCoreRuntimeFacadeStub, stubCoreRuntimeFacade } from "../testing";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  resetCoreRuntimeFacadeStub();
  resetAgentInstanceRuntimeOperations();
  globalInstanceRegistry.clear();
});

// 取消仅退出启动等待者，迟到完成的持久 API 实例仍必须进入空闲回收策略。
test("late persistent background start remains reclaimable after its only waiter cancels", async () => {
  for (const creationSource of ["api", "workflow", "user"] as const) {
    const record: AgentInstanceRecord = {
      id: `inst_background_${creationSource}`,
      environmentId: "env-background",
      ownerUserId: "user-background",
      creationSource,
      name: "primary",
      isDefault: false,
      createdByUserId: "user-background",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const started = deferred();
    const finish = deferred();
    let snapshot: { status: string; runtimeGeneration: number; serverEpoch: string } | null = null;
    stubCoreRuntimeFacade({ getInstance: () => snapshot });
    bindAgentInstanceRuntimeOperations({
      async spawnInstance(_environmentId, _userId, source, options) {
        started.resolve();
        await finish.promise;
        snapshot = {
          status: "running",
          runtimeGeneration: options.runtimeGeneration,
          serverEpoch: options.serverEpoch,
        };
        globalInstanceRegistry.register(record.id, {
          userId: record.ownerUserId,
          environmentId: record.environmentId,
          organizationId: "org-background",
          spawnSource: source,
          lastActivityAt: Date.now(),
          relayCount: 0,
          lastRelayDetachedAt: null,
        });
      },
      async stopInstance() {
        snapshot = null;
        globalInstanceRegistry.unregister(record.id);
      },
      hasActiveInstance() {
        return snapshot !== null;
      },
    });
    const controller = new AbortController();
    const waiting = agentInstanceService.ensureInstanceRuntime(record, controller.signal);
    await started.promise;
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(globalInstanceRegistry.has(record.id)).toBe(false);
    finish.resolve();
    await agentInstanceService.ensureInstanceRuntime(record);
    expect(isAgentExecutionIdleReclaimable(record.id)).toBe(creationSource !== "user");
    await agentInstanceRuntimeCoordinator.stopRuntime(record, "strict");
  }
});
