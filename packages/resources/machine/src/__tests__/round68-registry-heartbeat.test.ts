import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { initializeMachineModuleConfig } from "../server/testing";

const heartbeat = await import("@fenix/resource-machine/server");

/** 机器生命周期通知的记录器（§1.7 B4 前置后，心跳只通报事件，投影由 sandbox 侧写自己的表）。 */
const lifecycleCalls: Array<{ event: "registered" | "heartbeat"; machineId: string; at: Date }> = [];

/**
 * 按用例重新绑定记录用端口。
 *
 * **不能写在文件顶层**：Bun 在同一进程里跑完整个包，第二个文件加载时会撞上「重复绑定」守卫
 * （`machine-lifecycle-port.ts` 的守卫是给生产用的——装配期二次绑定意味着两套实现抢同一批实例行）。
 * 用例侧改为「先重置再绑定」，模块级状态因此不跨文件泄漏。
 */
function bindLifecycleRecorder(): void {
  heartbeat.resetMachineLifecyclePortForTest();
  lifecycleCalls.length = 0;
  heartbeat.bindMachineLifecyclePort({
    notifyMachineRegistered: async (machineId, at) => {
      lifecycleCalls.push({ event: "registered", machineId, at });
    },
    notifyMachineHeartbeat: async (machineId, at) => {
      lifecycleCalls.push({ event: "heartbeat", machineId, at });
    },
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stubHeartbeatPersistence() {
  const where = mock(async () => {});
  const set = mock(() => ({ where }));
  const update = mock(() => ({ set }));
  stubDb({ update });
  return { update };
}

// 心跳持久化经包内句柄替换（heartbeat.setRegistryHeartbeatDeps）：用例在各自作用域内注入断言用的替身。
// 初始化基础设施：心跳路径要读模块配置，未初始化会直接抛错。
beforeEach(() => {
  initializeMachineModuleConfig();
  bindLifecycleRecorder();
});

afterEach(() => {
  heartbeat.stopHeartbeat("machine-timeout");
  heartbeat.stopHeartbeat("machine-timeout-error");
  heartbeat.stopHeartbeat("machine-refresh");
  heartbeat.stopHeartbeat("machine-replaced");
  heartbeat.stopHeartbeat("machine-stopped");
  heartbeat.stopMachineSweep();
  heartbeat.resetRegistryHeartbeatDeps();
  // 端口复位也是复位的一部分：只在 beforeEach 里 reset，端口会带着本文件的记录器活到下一个文件
  // （模块级单例，Bun 同进程跑完整个包），下一个文件若想验「未绑定」就永远验不到。
  heartbeat.resetMachineLifecyclePortForTest();
  resetAllStubs();
});

describe("registry 心跳生命周期", () => {
  // 机器长时间未上报心跳时，应标记超时、通知连接清理并移除计时器。
  test("超时后标记机器并执行一次清理回调", async () => {
    const markHeartbeatTimeout = mock(async () => {});
    const onTimeout = mock(() => {});
    heartbeat.setRegistryHeartbeatDeps({ markHeartbeatTimeout, updateHeartbeat: async () => {} });

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
    heartbeat.setRegistryHeartbeatDeps({ markHeartbeatTimeout, updateHeartbeat: async () => {} });

    heartbeat.startHeartbeat("machine-timeout-error", 2, onTimeout);
    await wait(30);

    expect(markHeartbeatTimeout).toHaveBeenCalledWith("machine-timeout-error");
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  // 收到正常心跳时，应刷新机器活跃时间、通报沙盒侧投影，并延后超时判断。
  test("正常心跳刷新存储并重置超时计时", async () => {
    const updateHeartbeat = mock(async () => {});
    const markHeartbeatTimeout = mock(async () => {});
    const onTimeout = mock(() => {});
    stubHeartbeatPersistence();
    heartbeat.setRegistryHeartbeatDeps({ markHeartbeatTimeout, updateHeartbeat });

    heartbeat.startHeartbeat("machine-refresh", 20, onTimeout);
    await wait(10);
    await heartbeat.handleHeartbeat("machine-refresh");
    await wait(30);

    expect(updateHeartbeat).toHaveBeenCalledWith("machine-refresh");
    // 沙盒实例的活跃时间不再由本包写：只通报事件（时刻由调用方给出，见 registry-heartbeat）。
    expect(lifecycleCalls).toEqual([{ event: "heartbeat", machineId: "machine-refresh", at: expect.any(Date) }]);
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
    heartbeat.setRegistryHeartbeatDeps({ markHeartbeatTimeout, updateHeartbeat: async () => {} });

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
    heartbeat.setRegistryHeartbeatDeps({ markHeartbeatTimeout: async () => {}, updateHeartbeat: async () => {} });

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
