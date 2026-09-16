import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAllStubs, stubDb, stubRegistry } from "../../../../../apps/server/src/test-utils/helpers";
import { registryRegistry } from "../../../../../apps/server/src/test-utils/stubs/module-stubs";

const heartbeat = await import("@fenix/resource-machine/server");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stubHeartbeatPersistence() {
  const where = mock(async () => {});
  const set = mock(() => ({ where }));
  const update = mock(() => ({ set }));
  stubDb({ update });
  return { update };
}

beforeEach(() => {
  resetAllStubs();
  heartbeat.setRegistryHeartbeatDeps({
    markHeartbeatTimeout: (machineId: string) => registryRegistry.get("markHeartbeatTimeout")(machineId),
    updateHeartbeat: (machineId: string) => registryRegistry.get("updateHeartbeat")(machineId),
  });
});

afterEach(() => {
  heartbeat.stopHeartbeat("machine-timeout");
  heartbeat.stopHeartbeat("machine-timeout-error");
  heartbeat.stopHeartbeat("machine-refresh");
  heartbeat.stopHeartbeat("machine-replaced");
  heartbeat.stopHeartbeat("machine-stopped");
  heartbeat.stopMachineSweep();
  heartbeat.resetRegistryHeartbeatDeps();
  resetAllStubs();
});

describe("registry 心跳生命周期", () => {
  // 机器长时间未上报心跳时，应标记超时、通知连接清理并移除计时器。
  test("超时后标记机器并执行一次清理回调", async () => {
    const markHeartbeatTimeout = mock(async () => {});
    const onTimeout = mock(() => {});
    stubRegistry({ markHeartbeatTimeout, updateHeartbeat: async () => {} });

    heartbeat.startHeartbeat("machine-timeout", 2, onTimeout);
    await wait(30);

    expect(markHeartbeatTimeout).toHaveBeenCalledWith("machine-timeout");
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  // 标记超时落库失败不能阻止断连清理，避免失联机器遗留活跃资源。
  test("超时标记失败时仍执行连接清理", async () => {
    const markHeartbeatTimeout = mock(async () => {
      throw new Error("database unavailable");
    });
    const onTimeout = mock(() => {});
    stubRegistry({ markHeartbeatTimeout, updateHeartbeat: async () => {} });

    heartbeat.startHeartbeat("machine-timeout-error", 2, onTimeout);
    await wait(30);

    expect(markHeartbeatTimeout).toHaveBeenCalledWith("machine-timeout-error");
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  // 收到正常心跳时，应同时刷新机器和关联 Sandbox 的活跃时间，并延后超时判断。
  test("正常心跳刷新存储并重置超时计时", async () => {
    const updateHeartbeat = mock(async () => {});
    const markHeartbeatTimeout = mock(async () => {});
    const onTimeout = mock(() => {});
    const { update } = stubHeartbeatPersistence();
    stubRegistry({ markHeartbeatTimeout, updateHeartbeat });

    heartbeat.startHeartbeat("machine-refresh", 20, onTimeout);
    await wait(10);
    await heartbeat.handleHeartbeat("machine-refresh");
    await wait(30);

    expect(updateHeartbeat).toHaveBeenCalledWith("machine-refresh");
    expect(update).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();

    await wait(40);
    expect(markHeartbeatTimeout).toHaveBeenCalledWith("machine-refresh");
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  // 重复注册同一机器必须替换旧计时器，防止旧连接误触发资源清理。
  test("重复启动同一机器时只保留最新超时回调", async () => {
    const markHeartbeatTimeout = mock(async () => {});
    const oldTimeout = mock(() => {});
    const latestTimeout = mock(() => {});
    stubRegistry({ markHeartbeatTimeout, updateHeartbeat: async () => {} });

    heartbeat.startHeartbeat("machine-replaced", 5, oldTimeout);
    heartbeat.startHeartbeat("machine-replaced", 5, latestTimeout);
    await wait(40);

    expect(oldTimeout).not.toHaveBeenCalled();
    expect(latestTimeout).toHaveBeenCalledTimes(1);
    expect(markHeartbeatTimeout).toHaveBeenCalledTimes(1);
  });

  // 主动断开机器或重复停止巡检时，都应安全释放已登记的本地定时资源。
  test("停止心跳和巡检可重复调用且不会触发清理", async () => {
    const onTimeout = mock(() => {});
    stubRegistry({ markHeartbeatTimeout: async () => {}, updateHeartbeat: async () => {} });

    heartbeat.startHeartbeat("machine-stopped", 5, onTimeout);
    heartbeat.stopHeartbeat("machine-stopped");
    heartbeat.stopHeartbeat("machine-stopped");
    heartbeat.startMachineSweep(60_000);
    heartbeat.startMachineSweep(60_000);
    heartbeat.stopMachineSweep();
    heartbeat.stopMachineSweep();
    await wait(30);

    expect(onTimeout).not.toHaveBeenCalled();
  });
});
