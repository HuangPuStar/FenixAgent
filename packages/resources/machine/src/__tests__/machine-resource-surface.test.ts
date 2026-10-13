import { expect, test } from "bun:test";
import * as machineServer from "@fenix/resource-machine/server";

const surface = machineServer as unknown as Record<string, unknown>;

// 机器事件到沙盒实例状态的投影已移到 sandbox 侧（§1.7 B4 前置）：本包只对事件做通报。
test("Machine 资源包公开机器生命周期通知端口", () => {
  expect(machineServer.bindMachineLifecyclePort).toBeFunction();
  expect(machineServer.getMachineLifecyclePort).toBeFunction();
  expect(machineServer.resetMachineLifecyclePortForTest).toBeFunction();
});

// 反向守卫：写 `sandbox_instance` 的实现不得回到本包出口——复活它等于复活 §2.3 禁止的 machine → sandbox 写路径。
test("Machine 资源包不再公开沙盒实例投影", () => {
  expect(surface.markSandboxInstanceReadyForMachine).toBeUndefined();
  expect(surface.touchSandboxInstanceHeartbeatForMachine).toBeUndefined();
});
