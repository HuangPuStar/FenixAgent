import { describe, expect, test } from "bun:test";
import type { AgentInstanceRecord, IAgentInstanceRepo } from "../repositories/agent-instance";
import { AgentInstanceRuntimeCoordinator, type RuntimeAdapter } from "../services/agent-instance-runtime-coordinator";
import { AgentInstanceService } from "../services/agent-instance-service";

const instance: AgentInstanceRecord = {
  id: "inst_lifecycle_audit",
  environmentId: "env_audit",
  ownerUserId: "user_audit",
  creationSource: "api",
  name: "primary",
  isDefault: false,
  createdByUserId: "user_audit",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("审计生命周期回归", () => {
  // 底层启动忽略取消时，停止必须等迟到完成并按原运行身份回收。
  test("迟到启动完成前停止不能返回成功", async () => {
    const gate = deferred();
    let alive = false;
    let generation = 0;
    let stopped = false;
    const adapter: RuntimeAdapter = {
      async start(_instance, runtimeGeneration) {
        generation = runtimeGeneration;
        await gate.promise;
        alive = true;
      },
      async stop(_instanceUid, runtimeGeneration) {
        expect(runtimeGeneration).toBe(generation);
        alive = false;
      },
    };
    const coordinator = new AgentInstanceRuntimeCoordinator(adapter);
    const starting = coordinator.ensureRuntime(instance).catch((error: unknown) => error);
    const runtimeGeneration = coordinator.snapshot(instance.id).runtimeGeneration;
    const stopping = coordinator.stopRuntime(instance, "strict").then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(coordinator.snapshot(instance.id).runtimeGeneration).toBe(runtimeGeneration);
    gate.resolve();
    await Promise.all([starting, stopping]);
    expect(alive).toBe(false);
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
  });

  // 旧启动的补偿与最终停止都失败时必须保留 unknown，禁止将未知运行实体声明为停止。
  test("补偿停止失败可诊断且仍能显式重试", async () => {
    const gate = deferred();
    let failStop = true;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        await gate.promise;
      },
      async stop() {
        if (failStop) throw new Error("physical stop unconfirmed");
      },
    });
    const starting = coordinator.ensureRuntime(instance).catch((error: unknown) => error);
    const stopping = coordinator.stopRuntime(instance, "strict");
    gate.resolve();
    await expect(stopping).rejects.toThrow("physical stop unconfirmed");
    expect(await starting).toBeInstanceOf(AggregateError);
    expect(coordinator.snapshot(instance.id)).toMatchObject({
      state: "unknown",
      lastFailure: "physical stop unconfirmed",
    });
    failStop = false;
    await coordinator.stopRuntime(instance, "strict");
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
  });

  // best-effort 调用的容错属于自身等待者，不能掩盖同一停止操作的 strict 确认失败。
  test("严格停止等待者不会继承并发宽松调用的吞错语义", async () => {
    const gate = deferred();
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {},
      async stop() {
        await gate.promise;
        throw new Error("stop not confirmed");
      },
    });
    await coordinator.ensureRuntime(instance);
    const bestEffort = coordinator.stopRuntime(instance, "best-effort");
    const strict = coordinator.stopRuntime(instance, "strict");
    gate.resolve();
    await expect(strict).rejects.toThrow("stop not confirmed");
    await bestEffort;
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
  });

  // 删除停止失败后不得残留门禁，重复删除必须能够重新确认停止。
  test("删除停止失败后允许再次删除", async () => {
    let fail = true;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {},
      async stop() {
        if (fail) throw new Error("delete stop failed");
      },
    });
    await coordinator.ensureRuntime(instance);
    await expect(coordinator.deleteRuntime(instance)).rejects.toThrow("delete stop failed");
    expect(coordinator.snapshot(instance.id)).toMatchObject({ state: "unknown", deleting: false });
    fail = false;
    await coordinator.deleteRuntime(instance);
    expect(coordinator.snapshot(instance.id)).toMatchObject({ state: "stopped", deleting: true });
  });

  // 数据库删除失败必须释放本次删除门禁，运行实体已停止时允许用户明确重启。
  test("数据库删除失败恢复公开操作入口", async () => {
    let starts = 0;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        starts++;
      },
      async stop() {},
    });
    const repository = {
      async deleteById() {
        throw new Error("database unavailable");
      },
    } as unknown as IAgentInstanceRepo;
    const service = new AgentInstanceService(repository, coordinator);
    await service.ensureInstanceRuntime(instance);
    await expect(service.deleteInstance(instance)).rejects.toThrow("database unavailable");
    expect(coordinator.snapshot(instance.id).deleting).toBe(false);
    await service.restartInstanceRuntime(instance);
    expect(starts).toBe(2);
  });

  // 自动回收不设置手动停止意图；随后 ensure 必须启动新代，而手动停止继续阻止自动复活。
  test("自动回收与手动停止保留不同恢复语义", async () => {
    let starts = 0;
    let active = false;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        active = true;
        starts++;
      },
      async stop() {
        active = false;
      },
      hasActiveRuntime() {
        return active;
      },
    });
    await coordinator.ensureRuntime(instance);
    const firstGeneration = coordinator.snapshot(instance.id).runtimeGeneration;
    await coordinator.reclaimRuntime(instance, firstGeneration);
    await coordinator.ensureRuntime(instance);
    expect(starts).toBe(2);
    expect(coordinator.snapshot(instance.id).runtimeGeneration).toBeGreaterThan(firstGeneration);
    await coordinator.reclaimRuntime(instance, firstGeneration);
    expect(active).toBe(true);
    await coordinator.stopRuntime(instance, "strict");
    await expect(coordinator.ensureRuntime(instance)).rejects.toMatchObject({ code: "INSTANCE_STOPPED" });
  });

  // 回收在重启后排队时也须重新核对原运行代次，不能把排队前的死亡事实用于新实体。
  test("重启期间排队的旧代回收不停止新代", async () => {
    const gate = deferred();
    let delayStop = false;
    let activeGeneration = 0;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start(_instance, generation) {
        activeGeneration = generation;
      },
      async stop() {
        if (delayStop) await gate.promise;
        activeGeneration = 0;
      },
    });
    await coordinator.ensureRuntime(instance);
    const oldGeneration = coordinator.snapshot(instance.id).runtimeGeneration;
    delayStop = true;
    const restart = coordinator.restartRuntime(instance);
    const reclaim = coordinator.reclaimRuntime(instance, oldGeneration);
    gate.resolve();
    await Promise.all([restart, reclaim]);
    expect(activeGeneration).toBeGreaterThan(oldGeneration);
    expect(coordinator.snapshot(instance.id).state).toBe("running");
  });

  // 运行投影已确认不存在时不能继续使用 coordinator 的 running 快捷分支。
  test("已丢失的运行实体在下次 ensure 重新启动", async () => {
    let active = false;
    let starts = 0;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        active = true;
        starts++;
      },
      async stop() {
        active = false;
      },
      hasActiveRuntime() {
        return active;
      },
    });
    await coordinator.ensureRuntime(instance);
    active = false;
    await coordinator.ensureRuntime(instance);
    expect(starts).toBe(2);
  });

  // Controller 残留不能冒充真实 Core 的 running 身份，自动重试须先收敛投影再启动。
  test("Core 已丢失但 Controller 残留时重新收敛启动", async () => {
    let active = false;
    let ready = false;
    let starts = 0;
    let stops = 0;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        active = true;
        ready = true;
        starts++;
      },
      async stop() {
        active = false;
        stops++;
      },
      hasActiveRuntime() {
        return active;
      },
      isRuntimeReady() {
        return ready;
      },
    });
    await coordinator.ensureRuntime(instance);
    ready = false;
    await coordinator.ensureRuntime(instance);
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    expect(coordinator.snapshot(instance.id).state).toBe("running");
  });

  // 停止只推进操作身份，真实机器断连仍须按原运行代次进入 unknown 并由 clean-slate 解除。
  test("停止期间原运行代次断连能被 clean-slate 确认", async () => {
    const gate = deferred();
    let stoppedCallbacks = 0;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {},
      async stop() {
        await gate.promise;
      },
      onStopped() {
        stoppedCallbacks++;
      },
    });
    await coordinator.ensureRuntime(instance);
    const generation = coordinator.snapshot(instance.id).runtimeGeneration;
    const stopping = coordinator.stopRuntime(instance, "strict");
    coordinator.handleRuntimeDisconnect(instance.id, generation, "machine-audit");
    expect(coordinator.snapshot(instance.id).state).toBe("unknown");
    coordinator.handleMachineCleanSlate("machine-audit");
    gate.resolve();
    await expect(stopping).rejects.toThrow("disconnected");
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
    expect(stoppedCallbacks).toBeGreaterThan(0);
    await expect(coordinator.ensureRuntime(instance)).rejects.toMatchObject({ code: "INSTANCE_STOPPED" });
    await coordinator.restartRuntime(instance);
    expect(coordinator.snapshot(instance.id).state).toBe("running");
  });
});
